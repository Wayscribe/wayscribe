# Security

## 1. Security posture

Flight Recorder may receive customer records, API requests, errors, identifiers, and internal system metadata.

Security and privacy are product requirements from the first release.

The safest default is:

> Capture metadata automatically. Capture values only when explicitly enabled.

## 2. Primary threats

### Secret capture

Payloads, headers, stack traces, and metadata may contain:

- API keys
- OAuth tokens
- cookies
- passwords
- webhook signatures
- database credentials

Stack traces and error messages carry these as free text, where redaction by
key name cannot reach. Section 4 describes how that text is masked, what the
masking does not catch, and why stacks are kept only under `full-payload`.

### Sensitive customer data

Captured entities may include:

- names
- email addresses
- phone numbers
- addresses
- health information
- financial information
- government identifiers

### Cross-project access

A query or API key must never expose another project or environment.

Nor may an API key write into one. A journey belongs to the environment that created it,
and ingestion refuses an event for it from another environment's key with
`journey_environment_mismatch` (ADR-038).

### Guessing the admin token

The admin token reads every payload of every project, and it is one shared
secret. The web login and the API both throttle failed attempts per source
address, five a minute and then five minutes locked out, and neither keys that
address on `X-Forwarded-For` unless `TRUSTED_PROXY_COUNT` says how many proxies
to look through (`OPERATIONS.md` §9). The throttles are per process. They slow a
guesser; the token's length, 32 characters at least, is what makes guessing
hopeless.

### Replay abuse

Historical payload replay could:

- charge a card
- send an email
- create duplicate records
- overwrite newer data
- trigger external webhooks
- reuse expired or privileged credentials

### Denial of service

Unbounded payloads, event batches, nesting, or SDK buffers could exhaust memory, CPU, database storage, or network capacity.

### Correlation leakage

Journey and entity identifiers propagated over HTTP may reveal business information to downstream systems.

## 3. Capture modes

Each environment supports one of:

### `metadata-only`

Store identifiers, operation metadata, timing, errors according to policy, and no business payload values.

### `allowlisted-fields`

Store only configured payload paths.

### `redacted-payload`

Store payload after configured sensitive paths are removed or replaced.

### `full-payload`

Store full payload subject to hard size limits and mandatory secret filtering.

`full-payload` must never mean “skip secret detection.”

## 4. Redaction

Redaction should occur:

1. in the SDK before buffering
2. on the server before persistence
3. before replay request creation
4. before replay response persistence
5. before any future AI provider request

Server policy is authoritative and may capture less data than the SDK requests.

Redaction replacements should preserve evidence that a value existed:

```json
{
  "access_token": "[REDACTED]"
}
```

### Credentials inside error text

Path redaction matches the name a value is filed under, so it cannot reach a
credential written inside a string. Error text is where those appear, so
`error.message` is also masked by shape, in the SDK before sending and on the
server before storing, whoever sent the event (ADR-046). The masker replaces:

- URL userinfo: `postgres://app:hunter2@db` becomes `postgres://[REDACTED]@db`
- the secret path segment of Slack and Discord webhook URLs, keeping the
  workspace and channel
- `Bearer`, `Basic` and `Digest` credentials of at least eight characters,
  keeping the scheme word. A value that reads as words, such as
  `Basic plan-2026`, and the auth-params of a challenge such as
  `Bearer realm="api"` are kept.
- values assigned to a secret name. A name is split into words on `_`, `-`, `.`
  and case changes:
  - the built-in secret names (`authorization`, `cookie`, `password`, `api_key`,
    `access_token` and the rest) count in every form
  - `token`, `signature`, `sig`, `passwd`, `pwd` and `pass` count when assigned
    with `=` or as a quoted key, and after an unquoted colon only with a quoted
    value, as in `util.inspect` output such as `pass: 'hunter2x'`. A number
    assigned to `pass` is a count, as in `tests pass=12`, and is kept. `key`
    counts only as a query parameter.
  - a name of several words counts when it ends in `password`, `passwd`, `pwd`,
    `passphrase`, `secret`, `token`, `credential` or `credentials`, or in a pair
    such as `api key`, `secret key`, `private key` or `access key`. A token that
    pages or protects a form (`pageToken`, `nextToken`, `csrf_token`) does not
    count, and nor does a name ending in `id`, `arn`, `name` or `url`. So
    `DB_PASSWORD`, `STRIPE_API_KEY` and `x-auth-token` are masked, and
    `password_hash`, `SecretId` and `max_tokens` are not.
- JSON Web Tokens, and PEM and PGP private key blocks
- provider-prefixed credentials: Stripe `sk_`, `rk_` and `whsec_`, Slack
  `xox?-` and `xapp-`, GitHub `gh?_` and `github_pat_`, GitLab `glpat-`, AWS
  `AKIA` and `ASIA` key ids, Google `AIza`, OpenAI and Anthropic `sk-`, npm
  `npm_`, SendGrid `SG.`, Hugging Face `hf_`, and Flight Recorder `fr_` keys

After an unquoted colon, a value is only read when a blank follows the colon,
so `secret:prod/db` inside an ARN is left alone.

What it does not catch, by design or by limitation:

- **A credential in a shape not listed.** It does not guess at entropy. Long
  random-looking strings are exactly the identifiers the product shows, such as
  Salesforce ids, UUIDs and hashes, so there is no "looks random" rule.
- **Prose after a secret name.** An unquoted value that is a plain word after a
  colon, or after `=` and a blank, is read as a sentence:
  `client_secret: missing`, `DB_PASSWORD: not set`. A credential that is a
  single dictionary word in that position, such as `DB_PASSWORD: sunshine`, is
  stored. Attached to `=`, as `.env` and Compose files write it,
  `DB_PASSWORD=sunshine` is masked.
- **A name without separators.** `DBPASSWORD` is one word and not on any list.
- **The error's `type` and `code`.** Only `message`, and a kept `stack`, are
  masked.
- **`metadata` strings and payload strings.** Those keep path redaction only.
- **Rows written before this masking existed.** Their messages and stacks are
  stored as they arrived, until they are deleted (section 14, deletion on
  demand).

`error.stack` is stored only when the environment captures full payloads, which
requires both `ALLOW_FULL_PAYLOAD_CAPTURE` and the environment's `full-payload`
setting. In every other mode ingestion drops it. A kept stack is masked like a
message. The Node SDK never sends one of its own. It masks a window of twice
the protocol's limit and then cuts the result, a message to 4096 characters and
a stack passed to `record()` to 16384, ending in `[TRUNCATED]`; it masks the cut
text once more, so the server's pass leaves it unchanged.

The content hash stored with each event is an unkeyed SHA-256 over the event as
received, before any masking or redaction. With read access to the database, a
low-entropy secret that was masked can be guessed offline by rebuilding the
event with a candidate and comparing hashes. This was already true of redacted
payload values, and is recorded as a known limitation in ADR-046.

## 5. API keys

- Generate high-entropy keys.
- Display the full key once.
- Store only a safe prefix and verification hash.
- Scope keys to one project and environment.
- Support revocation.
- Never log keys.
- Use constant-time verification where applicable.
- Track last use without storing request payloads in auth logs.

## 6. Searchable sensitive aliases

Do not store plaintext searchable email addresses or similar low-entropy values by default.

Use normalized HMAC search tokens with a server-held key.

Display values may be:

- omitted
- masked
- encrypted
- available only to permitted local users

## 7. Encryption

At minimum:

- HTTPS for non-local deployment
- encrypted database and backup volumes at the infrastructure layer
- application encryption for stored replay headers
- external encryption key supplied through environment or secret manager

Alias display values, entity identifiers, and replay destination headers are
already encrypted at rest with a key derived from `ENCRYPTION_KEY`, in the format
and under the keys ADR-044 describes. Payloads are not, and this is a settled
decision rather than an interim state (ADR-040): redaction, not encryption, is
the payload control.

Encryption keys must not be stored in the same database as ciphertext.

### Key identifiers and rotation

Every encrypted value is stored as `fr1.<keyId>.<ciphertext>`. The key id is a
12-character HKDF fingerprint of `ENCRYPTION_KEY` under its own label: it
identifies the key without revealing anything about the subkeys, so it is safe
to log, and it is derived rather than configured, so a key cannot be
mislabelled. Values written before key ids existed have no prefix and are still
read.

Rotation is a grace period rather than a cut-over (ADR-044):

- `ENCRYPTION_KEY_PREVIOUS` holds the key being replaced. The API writes only
  under the current key and reads under both.
- Search matches either key's token until the data is re-encrypted.
- API key verifiers are HMACs and cannot be recomputed without the key itself,
  so each moves to the current key the next time it authenticates. A key that
  does not authenticate during the grace period stops working when the previous
  key is removed; `rotate:status` lists every such key so it can be revoked and
  reissued.
- `rotate:reencrypt` rewrites the stored values and tokens, and `rotate:status`
  confirms nothing is left under the old key before it is removed.
- GCM authentication makes a value under the wrong key fail to decrypt rather
  than produce garbage. A value under a key that is not configured is reported
  with that key's id, once per id, and the API logs a count at boot.
- A replay whose destination headers cannot be decrypted is refused and audited
  as blocked, never sent without them.
- Decrypted destination headers are held in memory for the request being sent.
  A replay run stores and returns them by name with the value `[REDACTED]`, and
  audit rows name blocked headers without values. Encrypting a credential on
  the destination would mean nothing if every run copied it out in the clear,
  which runs written before migration 015 did.
- A destination that echoes its request would put those values back into the
  run through its response. Before a run's response body and error message are
  stored, every occurrence of each destination header value at least 8
  characters long is replaced with `[REDACTED]`: within every string of a JSON
  body, and within a text body or message, in both the raw and the JSON-escaped
  form. That is exact matching, and it has limits. A value shorter than 8
  characters is not replaced. A body cut at the response size cap can end part
  way through a value, and the fragment is not matched. A value the destination
  encodes some other way, such as base64, is not recognised. Responses stored
  before this release are not scrubbed, because a migration has no key to
  decrypt the headers it would have to look for.

A suspected leak of `ENCRYPTION_KEY` is a reason to rotate, and a rotation does
not undo what the leaked key could already read: any dump or replica taken
before it stays readable with the old key. Rotation takes the live database out
of the old key's reach once re-encryption finishes, not the copies made before.

## 8. Project isolation

Every query must be explicitly scoped by authenticated project.

Tests must attempt cross-project access for:

- search
- journey reads
- event reads
- replay destinations
- replay runs
- audit events

Avoid unscoped repository functions.

## 9. Replay security

V0 replay rules:

- development destinations only
- explicit destination configuration
- host allowlist
- no automatic production credentials
- no copied authorization header
- no copied cookies
- no copied webhook signatures
- strict timeout
- request and response size limits
- audit every attempt
- user reviews payload before send
- destination header values are sent, never stored with the run or returned

`REPLAY_ALLOWED_HOSTS` is the load-bearing control. Replay deliberately allows
private addresses, because every development destination is one, so the list is
all that limits where an admin token can make the API send a request. A host
matches exactly, on any port. `host.docker.internal` reaches every service on the
Docker host, and `localhost` is the API's own container. The published Compose
file and the Helm chart default to `localhost` alone; a production installation
should set a minimal explicit list (`OPERATIONS.md` §9).

Blocked headers should include at least:

```text
authorization
proxy-authorization
cookie
set-cookie
x-api-key
x-amz-security-token
x-hook-signature
stripe-signature
```

Projects may add more.

## 10. Propagation security

By default, propagate only:

- journey ID
- non-sensitive entity type
- primary entity ID when explicitly allowed
- standard trace context

Do not propagate aliases automatically.

Allow projects to propagate only the journey ID.

## 11. Input limits

Enforce:

- maximum request body
- maximum batch count
- maximum event payload
- maximum JSON depth
- maximum number of object keys
- maximum string length
- maximum metadata size
- maximum replay response body
- replay timeout

Reject dangerous or malformed payloads before expensive processing.

## 12. SDK resilience and safety

- bounded event queue
- no recursive logging of recorder failures
- no synchronous network dependency
- safe serialization of circular values
- truncation indicators
- configurable stack capture
- clear dropped-event diagnostics

## 13. Audit events

Audit at least:

- API-key creation and revocation
- capture-policy changes
- replay destination creation and update
- replay attempt
- replay blocked by policy
- retention changes
- deletion or cleanup operations

Audit metadata must itself be sanitized.

A deletion's audit row is written in the same transaction as the delete, so
data never leaves without a record. An erasure's row records the search token
of the erased identifier under the current key, and counts, **never the
identifier itself**: the identifier is the personal data the erasure removed,
and an audit trail that kept it would be the one place it survived. A later
erasure of the same value produces the same token, so the two rows can be
matched without storing what they erased. A replay destination's creation and
deletion record its name, not its base URL, which can carry credentials or name
a host the operator considers internal (ADR-045). **Audit rows written before
this change record the base URL at creation**, and deleting the destination does
not remove them; `OPERATIONS.md` §8 gives the statement that strips the URL
from them.

## 14. Retention

- default to short local retention
- configure per environment
- delete in bounded batches
- document backup implications
- ensure deleted aliases and payloads are removed
- avoid retaining replay responses longer than the source environment requires

### Deletion on demand

Retention is not the only way out. An operator can delete one journey, every
journey matching an identifier (an erasure request, or the rows a redaction miss
wrote), an environment's time window, or a replay destination
(`OPERATIONS.md` §8).

- Deletion is hard: rows are deleted, and a journey's events, aliases, and replay
  runs go with it. A soft delete would keep what the operator asked to remove.
- Only the admin token, a signed-in web session, and the database CLI can delete.
  An API key cannot: it sits in application configuration on many servers, and a
  leaked one must not be able to erase the record of what it sent.
- Erasure matches the identifier's search tokens under every configured key, so
  it finds journeys still under the previous key during a rotation.
- Erasure matches an entity id or an alias, which is what search finds, and
  nothing else. An identifier that appears only inside a payload, such as an
  email address in `input` that was never recorded as an alias, is not matched,
  so an erasure request for it deletes nothing and reports zero journeys. Finding those
  journeys is the operator's work, and deleting each is `delete:journey`
  (`OPERATIONS.md` §8). An erasure that scans payloads is not built.
- Deleted rows remain in PostgreSQL's files until vacuum, and in every backup
  taken before the deletion. The documentation says so rather than implying
  otherwise.

## 15. Future BYOK AI security

AI is not part of V0.

Future BYOK rules:

- disabled by default
- explicit project enablement
- user-owned credentials
- provider credentials encrypted
- redaction before request
- field-selection preview
- no automatic background export of payloads
- full request audit
- provider endpoint allowlist
- output clearly labeled as inference
- deterministic evidence remains authoritative

## 16. Pre-release security checklist

- [ ] Project isolation tests pass.
- [ ] API keys are never stored in plaintext.
- [ ] Default capture mode is safe.
- [ ] Redaction occurs before persistence.
- [ ] Common secret headers are filtered.
- [ ] Payload and batch limits are enforced.
- [ ] Replay cannot target an unapproved host.
- [ ] Replay cannot copy historical authorization.
- [ ] Audit events are generated.
- [ ] SDK outage does not fail host operations.
- [ ] Retention cleanup deletes all related data.
- [ ] Documentation warns against capturing regulated data without proper controls.
