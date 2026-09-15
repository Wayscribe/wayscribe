# Rotating `ENCRYPTION_KEY` — design

Date: 2026-09-15. Status: approved for planning (autonomous v1 work, see the
project's v1 scope).

## Why

`ENCRYPTION_KEY` is the one secret an operator configures, and today rotating it
is permanently destructive. HKDF derives three subkeys from it
(`packages/payload-security/src/keys.ts`):

| Subkey | Used for | Stored as | What rotation does today |
| --- | --- | --- | --- |
| `fieldEncryption` | entity ids, alias display values, replay destination headers | AES-256-GCM, base64 of `iv ‖ tag ‖ ciphertext` | every value becomes undecryptable |
| `searchToken` | `journeys.primary_entity_id_hash`, `entity_aliases.alias_value_hash` | HMAC-SHA256 hex | every existing record becomes unsearchable |
| `apiKey` (pepper) | `api_keys.key_hash` | HMAC-SHA256 hex of the full key | every issued API key stops authenticating |

A self-hosting team will rotate this key: after a suspected leak, on a schedule,
or when someone who had it leaves. The open debt item `DEBT-P94G8Q` says the
envelope change "is hours now and a re-encryption project once anyone stores
data". Nothing is published yet, so this is the moment to make the format
carry a key identifier.

`content_hash` is an unkeyed SHA-256 and is unaffected. `ADMIN_TOKEN` rotation
is already safe (it signs every web session out) and stays out of scope.

## What an operator does

1. Generate a new key. Set `ENCRYPTION_KEY` to the new value and
   `ENCRYPTION_KEY_PREVIOUS` to the old one. Restart the API (and anything else
   that reads the key: the migrate/bootstrap container and the CLI).
2. From that moment new data is written under the new key, and everything
   written under the old key still decrypts, still searches, and every API key
   still authenticates.
3. Run `rotate:reencrypt`. It rewrites every encrypted value and search token
   under the new key, in batches, resumably. Safe to interrupt and re-run.
4. Run `rotate:status`. It reports how many rows and API keys are still under a
   key other than the current one. API keys migrate by themselves the next time
   each one authenticates; the status lists the ones that have not, so the
   operator can wait or reissue them.
5. When status shows nothing left under the old key, remove
   `ENCRYPTION_KEY_PREVIOUS` and restart.

If step 5 happens early, the API still starts, and logs at boot how many rows
and keys it can no longer read. `doctor` (a later v1 item) reports the same.

## Design

### Key identity

A key's identifier is a fingerprint derived from the master key:
`HKDF-SHA256(master, info = "flight-recorder/key-id", length = 6)`, hex-encoded
(12 characters). It is derived, not configured, so an operator cannot mislabel
a key, and it reveals nothing useful: HKDF output under a distinct info label is
independent of the three subkeys.

### The keyring

`packages/payload-security` gains a `Keyring`:

```ts
interface KeyMaterial {
  id: string;               // the 12-character fingerprint
  fieldEncryption: Buffer;
  searchToken: Buffer;
  apiKey: Buffer;
}

interface Keyring {
  current: KeyMaterial;
  previous: KeyMaterial | null;
}

function createKeyring(current: string, previous?: string): Keyring;
```

`createKeyring` refuses a `previous` equal to `current` (same fingerprint), so a
copy-paste mistake fails at boot rather than silently doing nothing.
`deriveSubkeys` stays as the internal building block.

### Encrypted values: a versioned envelope

New format: `fr1.<keyId>.<base64(iv ‖ tag ‖ ciphertext)>`.

- `.` never appears in standard base64, so the prefix is unambiguous, and a
  value with no prefix is the legacy format.
- `encryptField(keyring, plaintext)` always uses `keyring.current`.
- `decryptField(keyring, value)`:
  - `fr1.` with a known id: decrypt with that key.
  - `fr1.` with an unknown id: throw a `UnknownKeyError` naming the id, so the
    operator can tell "key removed too early" from "data corrupted".
  - legacy (no prefix): try `current`, then `previous`. GCM authentication makes
    a wrong key fail loudly, never decrypt to garbage.
- `keyIdOf(value)` returns the id, or `null` for legacy, for status and
  re-encryption.

The low-level single-key functions stay internal so the keyring is the only
entry point from outside the package.

### Search tokens: search under both keys

- Ingestion writes tokens under `current` only.
- Search (`packages/database/src/repositories/search.ts`) and any lookup by
  token compare against the set `{token(current), token(previous)}` when
  `previous` exists: `hash IN (…)` instead of `=`. The indexes on the hash
  columns serve an `IN` of two values.
- `searchTokens(keyring, value): string[]` returns one or two tokens.

### Aliases written during the grace period

`entity_aliases` is unique on `(project_id, journey_id, alias_type,
alias_value_hash)`. Once the token changes, a repeat of the same alias on the
same journey would insert a second row under the new token and show the alias
twice. Ingestion therefore, when `previous` exists, first rewrites any existing
row for that `(project_id, journey_id, alias_type)` whose hash is the previous
key's token for this value, setting the new token and a re-encrypted display
value, then performs the ordinary insert-or-ignore. The plaintext is in hand at
that moment, so this costs one indexed update and needs no decryption.

### API keys: migrate on use

- `api_keys` gains `key_hash_key_id text null`. Null means "written before this
  change", treated as unknown generation.
- New keys store `key_hash_key_id = current.id`.
- Verification, in order:
  1. If `key_hash_key_id` equals `previous.id`, verify with `previous`.
  2. Otherwise verify with `current`.
  3. If that fails, `previous` exists, and `key_hash_key_id` is null, verify with
     `previous`.

  On success under `previous`, rewrite `key_hash` and `key_hash_key_id` under
  `current` in the same request. The presented key is the plaintext that makes
  the rewrite possible; this is the only way an HMAC verifier can move to a new
  pepper. On success under `current` with a null `key_hash_key_id`, record
  `current.id`, so status is accurate on an install that predates this change.
- Every failure still returns the same 401 as today.
- The rewrite is best effort: if it fails, authentication still succeeds and the
  next request tries again.

### Replay destination headers

Encrypted with the envelope like the other fields; re-encrypted by the command.

### `rotate:reencrypt`

A database CLI command (`packages/database/src/cli.ts`, same pattern as
`retention:sweep`):

- Takes the same `ENCRYPTION_KEY` / `ENCRYPTION_KEY_PREVIOUS` environment.
  Refuses to run without `previous`, with a message explaining the procedure.
- Holds a PostgreSQL advisory lock so two runs cannot overlap.
- Processes `journeys`, `entity_aliases`, and `replay_destinations` in batches
  of 500 ordered by primary key, each batch in its own transaction.
- A row needs work when its ciphertext is legacy or under a key id other than
  `current.id`. For `journeys` and `entity_aliases`, the same update rewrites
  the ciphertext and the token (decrypt, re-encrypt, recompute token from the
  plaintext), so the ciphertext's key id is the progress marker for both.
- Rows whose ciphertext is null cannot have their token recomputed. They are
  counted and reported, not failed.
- Idempotent: a second run finds nothing to do and says so.
- Prints per-table counts: rewritten, already current, unrecoverable.
- Does not touch API keys; they cannot be rewritten without the plaintext key.

### `rotate:status`

Read-only. For each table, counts of rows by key id (current, previous, legacy,
unknown, null ciphertext), and API keys by `key_hash_key_id` with their prefix,
name, and `last_used_at`, for the ones not under `current`. Exit code 0 when
nothing remains under a non-current key, 1 otherwise, so a script can wait on
it.

### Boot check

At API start, after migrations are confirmed:

- Count rows in each encrypted table whose envelope key id is neither
  `current.id` nor `previous.id`, and API keys whose `key_hash_key_id` is
  neither. These can no longer be read.
- For each table with legacy (unprefixed) rows, try to decrypt the first one
  with the keyring. If that fails, report that table's legacy count as
  unreadable too.

A non-zero total logs one warning with the per-table counts and the
`rotate:status` command. The API still starts: refusing
would stop ingestion for a read problem.

## Migration

`012_key_rotation.js`: add `api_keys.key_hash_key_id text null`. No data
migration: legacy ciphertext and null key ids are handled by the read paths
above and upgraded by use or by `rotate:reencrypt`.

## Configuration

- `packages/config`: `ENCRYPTION_KEY_PREVIOUS` optional, minimum 32 characters
  when present, and flagged by the published-defaults warning like the others.
- Compose files and the Helm chart pass it through when set. `.env.example`
  documents it commented out.

## Documentation

- `docs/OPERATIONS.md` §6 rewritten around the procedure above, with the
  failure it prevents stated first.
- `docs/SECURITY.md`: key identifiers and the grace period.
- `docs/DECISIONS.md`: ADR-044, "Keys carry an identifier, and rotation is a
  grace period, not a migration". Update the README's ADR count (the docs-truth
  test checks it).
- CHANGELOG under Unreleased.
- Remove the `DEBT-P94G8Q` declaration.

## Testing

- **Unit, `payload-security`:** fingerprint stability and independence from the
  subkeys; envelope round trip; decrypt legacy under current and under
  previous; unknown id error; tampered value fails; `createKeyring` refusing a
  duplicate; `searchTokens` returning one or two.
- **Unit, API auth:** verify under current; verify under previous triggers the
  rewrite callback; rewrite failure still authenticates; wrong key still 401 with
  the same body.
- **Integration (real PostgreSQL, existing testcontainers pattern):**
  1. Ingest a journey with an alias under key A. Restart with current B,
     previous A. Search by entity id and by alias value finds it; the detail
     decrypts; the old API key authenticates and its row now carries B's id.
  2. Ingest the same alias again under B: still one alias row.
  3. Run `rotate:reencrypt`: every row now carries B's id and B's tokens;
     second run rewrites nothing.
  4. Restart with current B and no previous: search, detail, and the migrated
     API key all work; an API key never used during the grace period fails
     and `rotate:status` had listed it.
  5. Legacy rows (inserted in the old base64 format directly) decrypt and are
     rewritten by the command.
- **Browser and demo suites** pass unchanged.

## Out of scope

- More than one previous key. A rotation completes before the next begins.
- Automatic re-encryption at boot. It is a long-running write that an operator
  should start deliberately.
- Re-issuing API keys automatically.
- `ADMIN_TOKEN` grace periods.
