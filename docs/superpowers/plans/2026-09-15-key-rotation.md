# Key Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is test-first. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rotating `ENCRYPTION_KEY` becomes a grace period instead of data loss: values carry a key identifier, the API reads under the current and previous key, API keys migrate on use, and a command re-encrypts the rest.

**Spec:** `docs/superpowers/specs/2026-09-15-key-rotation-design.md`. The spec is authoritative for behaviour; this plan fixes the order, file boundaries, and what each task must prove.

**Tech stack:** TypeScript, Node 24, Fastify, Knex, PostgreSQL 17, Vitest (node project; integration tests use testcontainers via `pnpm test:integration`).

**Conventions for every task:**

- Prefix commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`; run from the repository root.
- Work on branch `key-rotation`.
- Before each commit: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`. Tasks that touch the database also run `pnpm test:integration`.
- `.ts` files need explicit return types; `noUncheckedIndexedAccess` is on; no non-null assertions (lint forbids them).
- Comments explain why, in the repository's existing voice. No em dashes in CHANGELOG or docs prose added by these tasks.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Task 1: Keyring and envelope in `payload-security`

**Files:** `packages/payload-security/src/keyring.ts` (create), `keyring.test.ts` (create), `encryption.ts`, `encryption.test.ts`, `search-token.ts`, `search-token.test.ts`, `api-key.ts`, `api-key.test.ts`, `keys.ts`, `index.ts`.

Build, test-first:

- `keyFingerprint(master): string` (HKDF info `flight-recorder/key-id`, 6 bytes, hex).
- `KeyMaterial`, `Keyring`, `createKeyring(current, previous?)`; throws on identical fingerprints and on a key shorter than 32 characters (reuse `deriveSubkeys`' check).
- `UnknownKeyError` (carries `keyId`).
- `encryptValue(keyring, plaintext)` writes `fr1.<id>.<base64>`; `decryptValue(keyring, value)` handles known id, unknown id, legacy under current, legacy under previous, tampered; `keyIdOf(value)`. The existing single-key `encryptField` / `decryptField` stay exported and unchanged in this task, and become internal helpers in Task 2.
- `searchTokens(keyring, value): string[]` (current first, previous second when present). `searchToken(key, value)` stays exported for now.
- `verifyApiKeyWithKeyring(keyring, presented, stored: { keyHash, keyHashKeyId }): { ok: false } | { ok: true; migrate: { keyHash, keyHashKeyId } | null }` implementing the spec's verification order. `migrate` is non-null when the stored verifier must be rewritten (verified under previous, or verified under current with a null id).
- `issueApiKey(keyring)` / `apiKeyRecordFor(keyring, apiKey)` return `keyHashKeyId` alongside the verifier. The existing `generateApiKey(pepper)` / `apiKeyRecord(pepper, key)` / `verifyApiKey` stay exported for now.

Prove: every case in the spec's "Unit, payload-security" list; `verifyApiKeyWithKeyring` for each branch of the order, including a wrong key under both keys returning `{ ok: false }`.

This task adds; it removes nothing and edits no callers, so the whole repository still compiles and every existing test passes.

## Task 2: Thread the keyring through the API, database, and config

**Files:** `packages/config/src/schema.ts` (+ tests, + `insecure-defaults.ts`), `apps/api/src/server.ts`, `apps/api/src/auth.ts` (+ tests), `apps/api/src/routes/events.ts`, `queries.ts`, `present.ts`, `replays.ts`, `apps/api/src/ingestion/ingest-event.ts`, `packages/database/src/repositories/api-keys.ts`, `key-admin.ts`, `replay.ts`, `search.ts`, `aliases.ts`, `packages/database/src/seed-local.ts`, `seed-demo.ts`, `packages/database/src/cli.ts`, `packages/database/migrations/012_key_rotation.js`, `.env.example`, `infrastructure/compose.yaml`, `compose.published.yaml`, `compose.demo.yaml` (only if it passes the key), `deploy/helm/flight-recorder` (values and secret passthrough), and any test that constructs subkeys.

Build:

- Config: optional `ENCRYPTION_KEY_PREVIOUS` (min 32 when set); insecure-default warning covers it.
- The API builds one `Keyring` at boot and passes it where `subkeys` went. When every caller uses the keyring functions, make the single-key `encryptField`, `decryptField`, `searchToken`, `generateApiKey`, `apiKeyRecord` and `verifyApiKey` internal to `payload-security` (remove them from `index.ts`), so the keyring is the only way in. Ingestion encrypts with the envelope and writes current tokens. Queries decrypt with the keyring. Replay destinations encrypt and decrypt with it. Key admin, seeds, and the CLI issue keys with `keyHashKeyId`.
- Migration `012_key_rotation.js`: `api_keys.key_hash_key_id text null`, with a down migration.
- Search and every token lookup use `whereIn` over `searchTokens(keyring, value)`.
- Alias grace rewrite in ingestion, as the spec describes, only when `previous` exists.
- API key auth uses `verifyApiKeyWithKeyring`; when `migrate` is non-null, update the row (best effort, logged on failure, never failing the request). Auth failure responses unchanged.
- Compose, Helm and `.env.example` pass `ENCRYPTION_KEY_PREVIOUS` through when set, commented in `.env.example`.

Prove, in integration tests against PostgreSQL:
- Spec scenarios 1 and 2 (grace-period reads, search, API key migration on use, no duplicate alias row).
- A key issued before the migration (null `key_hash_key_id`) authenticates under current and gets its id recorded.
- Everything that passed before still passes: `pnpm test`, `pnpm test:integration`.

## Task 3: `rotate:reencrypt`, `rotate:status`, and the boot check

**Files:** `packages/database/src/repositories/rotation.ts` (create) and `rotation.integration.test.ts` (create), `packages/database/src/cli.ts`, `packages/database/src/index.ts`, `apps/api/src/server.ts` (boot check, or a small module it calls), `apps/api/src/…` test for the warning.

Build per the spec: advisory lock, batches of 500 by primary key, per-batch transactions, progress marked by the ciphertext's key id, null-ciphertext rows counted, idempotent second run, per-table output. `rotate:status` read-only, exit 1 when anything remains under a non-current key, API keys listed with prefix, name, `last_used_at`. The boot check logs one warning with per-table counts when rows or keys are unreadable.

Prove: spec scenarios 3, 4, 5, plus: two concurrent `reencrypt` runs do not both work (the second reports the lock is held); `rotate:status` exit codes; the boot warning fires for an unknown key id and stays silent on a clean install.

## Task 4: Documentation and debt

**Files:** `docs/OPERATIONS.md` §6 and the troubleshooting table, `docs/SECURITY.md`, `docs/DECISIONS.md` (ADR-044), `README.md` (ADR count, any rotation claim), `CHANGELOG.md` (Unreleased), `docs/DATABASE_SCHEMA.md` (the new column and the envelope format), `packages/database/README.md` or `docs/LOCAL_DEVELOPMENT.md` CLI tables (the two commands), `packages/payload-security/src/encryption.ts` (remove the `DEBT-P94G8Q` block).

Prove: `pnpm vitest run tests/docs-truth.test.ts` passes (ADR count and numbering); `npx debtwatch list` no longer shows `DEBT-P94G8Q`; a reader following OPERATIONS §6 literally performs the rotation that Task 3's scenario 4 exercises.

## Task 5: End-to-end rotation on a real stack

No new files unless a defect is found.

Against a fresh Compose stack from a clean clone: bring up the demo, trigger a journey, rotate following `docs/OPERATIONS.md` §6 exactly (new key, previous set, restart, `rotate:reencrypt`, `rotate:status`, remove previous, restart), then confirm in the browser that search by `0018Z00002ABC`, the journey detail, and the diff still work, the demo's fixed API key still ingests (it migrated on use), and a second triggered journey records. Run `pnpm test:demo` and the Playwright suite before and after. Record every command and its output in the task report. Any step the documentation gets wrong is a defect to fix in Task 4's files.
