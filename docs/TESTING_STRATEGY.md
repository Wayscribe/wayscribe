# Testing Strategy

## 1. Goals

Testing must protect:

- protocol compatibility
- ingestion correctness
- project isolation
- SDK failure isolation
- sensitive-data handling
- deterministic timelines
- replay safety
- the complete reference journey

## 2. Test layers

### Unit tests

Use for:

- Zod protocol schemas
- normalization and HMAC search tokens
- payload redaction
- payload diffing
- URL and header policy
- journey status derivation
- SDK buffer behavior
- retry timing logic

### Database integration tests

Use a real PostgreSQL instance through Testcontainers or a dedicated Compose test service.

Cover:

- migrations
- uniqueness constraints
- idempotent insertion
- transaction rollback
- search indexes
- journey summary updates
- retention cleanup
- project isolation

### API integration tests

Use Fastify injection where possible.

Cover:

- authentication
- validation
- event and batch ingestion
- stable errors
- search
- journey reads
- event reads
- replay destination policy
- replay audit creation

### SDK contract tests

Run a test ingestion server and verify emitted protocol envelopes.

Cover:

- public methods
- callback return preservation
- callback error preservation
- trace context
- HTTP propagation
- SQS attribute propagation
- batching
- retries
- shutdown

### Browser tests

Use Playwright for:

- search
- journey timeline
- event detail
- diff display
- replay preparation
- replay result
- blocked destination message

### End-to-end test

The full demo scenario is the release gate.

## 3. Critical test matrix

| Area | Happy path | Failure path | Abuse or boundary path |
|---|---|---|---|
| Ingestion | accepted event | invalid schema | oversized payload |
| Idempotency | new event | duplicate retry | conflicting duplicate |
| Auth | valid key | revoked key | cross-project access |
| Redaction | configured path | malformed payload | deeply nested secret |
| Diff | changed field | missing output | huge array |
| SDK | successful send | recorder unavailable | full buffer |
| Propagation | HTTP/SQS round-trip | missing context | tampered context |
| Replay | allowed local host | target timeout | SSRF/disallowed host |
| Retention | expired journey | partial batch failure | large deletion set |

## 4. Protocol fixtures

Maintain versioned fixtures:

```text
packages/protocol/fixtures/
├── v0.1-valid-minimal.json
├── v0.1-valid-complete.json
├── v0.1-invalid-missing-id.json
├── v0.1-invalid-operation.json
└── v0.1-invalid-timestamp.json
```

Fixtures should be reusable across SDK and API tests.

## 5. Idempotency tests

Verify:

- same project and event ID inserts once
- different projects may use the same event ID
- retry returns duplicate accepted response
- duplicate does not increment event count twice
- duplicate does not add aliases twice
- conflicting payload for same event ID returns documented behavior

The conflicting duplicate policy should be decided explicitly. Recommended: return a conflict error if a duplicate ID has a different canonical content hash.

## 6. Security tests

Required:

- common secrets redacted
- project scoping applied to every read
- replay blocks historical authorization
- replay blocks non-allowlisted host
- redirect cannot escape allowlist
- oversized replay response truncated or rejected
- API key hash only in database
- error logs do not include secret payloads

## 7. Performance checks

Not formal benchmarks initially, but add repeatable development checks for:

- batch of 20 small events
- journey with 500 events
- search dataset with representative aliases
- deeply nested payload redaction
- diff of maximum supported payload
- retention deletion batch

## 8. CI stages

Recommended:

1. install
2. formatting check
3. lint
4. type check
5. unit tests
6. database integration tests
7. build
8. browser and E2E tests on protected branches or release workflow

## 9. Release gate

No V0 release unless the automated demo proves:

- the defective field is visible
- the first bad transformation is identifiable
- downstream failure and retries are shown
- replay against corrected code succeeds
- recorder outage does not break the integration
