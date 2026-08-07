# Phase 1a: Protocol, Schema, and Security Primitives — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** The event protocol package, the remaining database migrations and local seed,
and the security primitives. Ingestion endpoints are Phase 1b.

## 1. Context

Phase 0 established the workspace, configuration, and a single migration. Phase 1 in the
implementation plan covers protocol, persistence, security, and ingestion together —
roughly double Phase 0's footprint. It is split here:

- **Phase 1a (this document):** three packages that are independently unit-testable and
  need no HTTP server.
- **Phase 1b:** the ingestion endpoints that consume all three, plus `payload-diff`.

The three Phase 1a packages have no dependencies on one another, so they can be built and
reviewed in any order.

## 2. Components

### `packages/protocol`

The wire contract between instrumented applications and the recorder. Owns:

- `PROTOCOL_VERSION` constant, value `"0.1"`.
- Zod schemas for the envelope, the journey event, and every nested structure: entity,
  aliases, error, runtime metadata, deployment metadata, custom metadata.
- TypeScript types inferred from the schemas with `z.infer`, never declared separately.
  Two hand-maintained definitions of the same shape drift.
- Stable error codes from `EVENT_PROTOCOL.md` section 12.
- The five fixtures named in `TESTING_STRATEGY.md` section 4, which the SDK and API test
  suites both consume.

The operation enum includes `identified` (ADR-023).

This package must not import anything else in the workspace. It is the boundary the SDK
and the API agree on, and a dependency here would leak implementation into the contract.

### `packages/database`

Migrations 002 through 009, plus a local development seed.

Migration order: environments, api_keys, journeys, entity_aliases, journey_events,
replay_destinations, replay_runs, audit_events.

`DATABASE_SCHEMA.md` section 7 suggests a tenth migration for "indexes and constraints
not safely created inline." That applies to concurrent index creation against a live
table; every index here is created alongside its own table on an empty schema, so each
lives in the migration that creates the table it serves. Splitting them out would
separate an index from the table it belongs to for no benefit.

Migrations remain plain ESM JavaScript per ADR-027.

The seed creates one project, one environment, and one API key, printing the full key
once. It is idempotent: re-running it must not create duplicates.

### `packages/payload-security`

Five independent primitives:

1. Path-based redaction.
2. HMAC-SHA256 search tokens.
3. API-key generation and constant-time verification.
4. AES-256-GCM field encryption.
5. Input limits: payload bytes, JSON depth, object key count, string length.

**This package takes keys as explicit function parameters and does not import
`@flight-recorder/config`.** It stays a pure library: testable with fixed keys, no
environment required, and every call site shows which key it uses. Composition is
`apps/api`'s job in Phase 1b.

## 3. Key management

Three primitives need key material. Using one raw key for all three is poor practice;
requiring three environment variables works against the onboarding target.

**Decision:** derive purpose-specific subkeys from the single `ENCRYPTION_KEY` using
HKDF-SHA256 with distinct info labels:

```text
flight-recorder/field-encryption
flight-recorder/search-token
flight-recorder/api-key
```

One variable to configure; three cryptographically independent keys; no cross-purpose
reuse.

Consequence: rotating the master rotates all three, which invalidates existing search
tokens and API keys. V0 accepts this. The limitation is documented in the security
documentation rather than left implicit, and a future phase may split the variables.

## 4. Schema decisions

### API keys cannot reference another project's environment

`DATABASE_SCHEMA.md` leaves this as "enforced in application logic or composite FK
design." Application logic is how cross-tenant defects happen.

`environments` gains `UNIQUE (id, project_id)`. `api_keys` then carries a composite
foreign key `(environment_id, project_id)` referencing `environments (id, project_id)`.
An API key whose environment belongs to a different project becomes structurally
unrepresentable, by the same reasoning as ADR-020 one level down.

### Carried from Phase 0

- Composite primary keys `(project_id, id)` on `journeys` and `journey_events`, with
  `entity_aliases` referencing journeys through `(project_id, journey_id)` (ADR-020).
- `journey_events.content_hash` for duplicate-conflict detection (ADR-021).
- `environments.capture_mode` CHECK against the four hyphenated protocol values
  (ADR-018).
- `replay_destinations.base_url` as an origin with optional base path (ADR-019).

### Indexes and constraints

- Partial indexes on `trace_id`, `message_id`, and `correlation_id` where non-null.
- `CHECK (retention_days > 0)`, `CHECK (event_count >= 0)`, `CHECK (duration_ms >= 0)`.
- `entity_aliases` unique on `(project_id, journey_id, alias_type, alias_value_hash)`,
  with lookup indexes on `(project_id, alias_type, alias_value_hash)` and
  `(project_id, alias_value_hash)`.
- An alias value may map to more than one journey over time; no global uniqueness.

## 5. Security primitive designs

### Redaction

A deliberately small path grammar:

- literal segments, e.g. `customer.ssn`
- `*` matching exactly one level, e.g. `*.password`
- `[*]` matching array elements, e.g. `items[*].cardNumber`
- case-insensitive matching for header-like names, e.g. `authorization`

Matched values are replaced with the string `"[REDACTED]"` rather than deleted, because
`SECURITY.md` section 4 requires preserving evidence that a value existed.

The grammar is documented as exhaustive. Regular-expression paths and conditional rules
are out of scope, so users are not left guessing what is supported.

Redaction must handle cyclic structures without infinite recursion, and must not mutate
its input.

### Search tokens

```text
HMAC-SHA256(searchKey, aliasType + ":" + normalizedValue)
```

The alias type is part of the HMAC input per `DATABASE_SCHEMA.md` section 4, so the same
value under two alias types produces different tokens and cannot collide.

Normalization trims surrounding whitespace and lowercases values that are valid UUIDs,
while preserving punctuation that is meaningful in external identifiers. It does not
lowercase arbitrary values, because external systems issue case-sensitive identifiers.

### API keys

Generated as `fr_` followed by 24 random bytes, base64url-encoded. The first 12
characters are stored as `key_prefix` and used for lookup; the stored verifier is
`HMAC-SHA256(apiKeySubkey, fullKey)`. Verification compares in constant time using
`crypto.timingSafeEqual`.

The full key is displayed once, at generation.

### Field encryption

AES-256-GCM. A fresh random 12-byte IV per encryption, never reused. Stored as
base64 of `iv || authTag || ciphertext`, so a single text column holds everything
needed to decrypt.

Decryption of tampered ciphertext must fail loudly rather than return partial plaintext;
GCM's authentication tag provides this.

### Input limits

Configurable, with the defaults from `LOCAL_DEVELOPMENT.md` section 5. Limits are checked
before expensive processing, per `SECURITY.md` section 11: an oversized or pathologically
nested payload must be rejected before redaction walks it.

## 6. Testing

Every primitive is tested on its abuse path, not only its happy path:

- **Redaction:** configured paths, wildcards, array wildcards, deeply nested secrets,
  cyclic structures, input not mutated, non-matching paths untouched.
- **Search tokens:** deterministic for equal input, differs across alias types, differs
  across keys, normalization behaves as documented.
- **API keys:** generated keys are unique, verification accepts the correct key, rejects
  a wrong key, rejects a key from a different pepper, and uses a constant-time compare.
- **Field encryption:** round-trips, produces a different ciphertext each time for the
  same plaintext (IV uniqueness), and fails on a tampered tag or ciphertext.
- **Limits:** oversized payload, excessive depth, excessive key count, and oversized
  strings are each rejected.
- **Protocol:** the five fixtures validate or fail as intended, unknown protocol versions
  are rejected with `unsupported_protocol_version`, and unknown optional fields are
  preserved where documented as safe.
- **Migrations (Testcontainers):** each constraint, including a deliberate attempt to
  insert an API key whose environment belongs to another project, which must fail at the
  database rather than in application code. Also idempotent seed re-run, and rollback.

## 7. Acceptance criteria

- `pnpm test` and `pnpm test:integration` pass on a clean clone.
- All ten migrations apply and roll back cleanly against a real PostgreSQL container.
- A valid complete event fixture validates; each invalid fixture fails with its expected
  stable error code.
- An unsupported protocol version is rejected with a machine-readable code.
- Cross-project API key insertion is rejected by a database constraint.
- Redaction removes configured paths before any value is persisted or returned.
- Encrypted values round-trip, and tampered ciphertext fails to decrypt.
- The seed prints a working API key once and is safe to re-run.
- The full CI pipeline passes.

## 8. Not in this phase

Ingestion endpoints, journey and alias upsert logic, the correlation rules, batch
handling, and `payload-diff`. All belong to Phase 1b.

ADR-024 requires payload diffs to be computed at ingestion. `payload-diff` therefore
moves into Phase 1b rather than Phase 2, so the column is populated from the first
ingested event. Diffs derive from payloads that redaction may drop, so a journey ingested
without a diff cannot have one reconstructed later.
