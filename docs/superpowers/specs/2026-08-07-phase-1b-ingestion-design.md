# Phase 1b: Authenticated Idempotent Ingestion — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** API-key authentication, single and batch event ingestion, journey and alias
upsert, capture policy and server-side redaction, and the `payload-diff` package.

## 1. Context

Phase 1a delivered the protocol schemas, the database schema, and the security
primitives as independent libraries. Phase 1b composes them into a working ingestion
pipeline: an authenticated `POST /v1/events` that stores an event, creates or updates
its journey, records its aliases, and computes its payload diff.

This is the first phase that produces something a developer can use. After it, an SDK
could send an event and a row would appear.

`payload-diff` lands here rather than in Phase 2 because ADR-024 requires diffs to be
computed at ingestion, and a diff cannot be reconstructed later once redaction has
dropped the payloads it derives from.

## 2. Components

### `packages/payload-diff`

Structural comparison of two JSON-compatible values, producing added, removed, and
changed entries with dotted paths.

Arrays compare element-wise by index per ADR-025. No subsequence matching, so a
reordered array reads as broadly changed. Complexity limits are enforced: comparison
stops and reports truncation rather than walking an unbounded structure.

Depends on nothing.

### Repositories in `packages/database`

Journey, event, and API-key queries move out of route handlers into repository modules.

**Every repository function takes `projectId` as its first parameter.** There is no
unscoped variant available to call by mistake, which is the practical form of the
project-isolation requirement in `SECURITY.md` section 8.

### Authentication in `apps/api`

A Fastify hook resolving `Authorization: Bearer <key>`:

1. Extract the key prefix and look up the row by `key_prefix` (unique, indexed).
2. Verify with constant-time HMAC comparison.
3. Reject if `revoked_at` is set.
4. Attach project and environment context to the request.

`last_used_at` is updated outside the request path, so authentication remains a single
indexed read and a write failure there cannot fail ingestion.

The API key is scoped to one environment. An event whose `environment` field names a
different environment is rejected with `unauthorized_environment`.

### Ingestion service in `apps/api`

Per event, inside one transaction:

1. Enforce input limits.
2. Compute the content hash.
3. Apply capture policy and server-side redaction.
4. Compute the payload diff.
5. **Create the journey if absent.**
6. Insert the event, or detect a duplicate or conflict.
7. Update the journey summary — only for genuinely new events.
8. Upsert aliases.

**Correction to `ARCHITECTURE.md` section 8.** That section orders the transaction as
"insert the event, then create the journey if missing." That ordering cannot work:
`journey_events` carries a composite foreign key to `journeys` (ADR-020), so inserting
an event before its journey exists violates the constraint.

The journey row is therefore created first, at `event_count` 0, and the summary is
advanced afterwards and only for events that were genuinely new — so a duplicate never
inflates the count. A conflict rolls the whole transaction back, so a rejected event
never leaves an orphaned journey behind.

### Routes

`POST /v1/events` and `POST /v1/events/batch`, both delegating to the same per-event
path so single and batch ingestion cannot drift apart.

## 3. Schema additions (migration 010)

Two gaps found while designing this phase:

- `environments.capture_mode` exists, but no column holds **which paths to redact**, so
  "server-side redaction is authoritative" has nothing to be authoritative with.
- `allowlisted-fields` is a permitted capture mode with nowhere to store the allowlist.
  As specified it cannot be implemented.

Migration 010 adds `redaction_paths jsonb` and `capture_allowlist jsonb`, both
defaulting to an empty array.

Shipping a capture mode that silently degrades to a different mode would be worse than
either implementing it or removing it.

## 4. Capture policy

Applied server-side, after protocol validation and before persistence:

| Mode | Behavior |
|---|---|
| `metadata-only` | `input` and `output` are dropped entirely. |
| `allowlisted-fields` | Only paths in `capture_allowlist` are kept. |
| `redacted-payload` | Full payload minus redacted paths. |
| `full-payload` | Full payload, still minus redacted paths. |

Redaction paths are the built-in default secret list plus `environments.redaction_paths`.

**The built-in list cannot be disabled.** `SECURITY.md` section 3 requires that
`full-payload` never mean "skip secret detection". The default list covers
authorization, proxy-authorization, cookie, set-cookie, and common password, token, and
secret field names.

Server policy may capture less than the SDK requested; it never captures more.

## 5. Idempotency and conflicts

Each event stores a `content_hash`: SHA-256 over a canonical serialization with
recursively sorted object keys.

**The hash is computed over the event as received, before redaction.** ADR-021 exists to
catch a client reusing an event ID for different content, so the hash must reflect what
the client sent. Hashing after redaction would let a server-side policy change alter the
hash of an unchanged input and produce phantom conflicts.

Outcomes for an event whose `(project_id, id)` already exists:

- Same content hash: accepted, `duplicate: true`, no derived updates repeated.
- Different content hash: rejected with `event_id_conflict` (HTTP 409 for the single
  endpoint, a per-event rejection in a batch).

## 6. Journey summary

- `started_at` is the **minimum** event timestamp seen; `last_event_at` the **maximum**.
  Events arrive late and out of order, so last-write-wins would corrupt both.
- `event_count` increments only on genuinely new inserts, never on idempotent
  duplicates.
- Status follows the most recent status-affecting event **by event timestamp**: a
  `completed` operation sets `completed`; a `failed` operation or any event carrying an
  error sets `failed`; otherwise the journey stays `active`. An event only updates
  status if its timestamp is at least the journey's current `last_event_at`, so a
  late-arriving older event cannot clobber a newer status. This requires no extra column
  because the comparison happens before `last_event_at` is updated.
- Journey creation uses `INSERT ... ON CONFLICT DO NOTHING` followed by the update, so
  two events racing to create the same journey do not fail either request.

## 7. Aliases

Each alias in an event is stored as an HMAC search token plus an encrypted display
value, unique on `(project_id, journey_id, alias_type, alias_value_hash)`. Re-sending
the same alias is a no-op rather than an error.

The journey's `primary_entity_id_hash` and `encrypted_primary_entity_id` are derived
from `entity.id` using the same primitives.

## 8. Batch handling

One transaction per event, matching `ARCHITECTURE.md` section 8. A batch of twenty
produces twenty short transactions, which stays well inside the 250ms p95 target on
local PostgreSQL.

Every event yields a result: `accepted` with a duplicate flag, or `rejected` with a
stable error code. One event's failure never affects another's.

Batch size is bounded; an oversized batch is rejected before any event is processed.

## 9. Error handling

All errors use the envelope in `API_SPEC.md` section 2 with stable codes from the
protocol package. Human-readable messages may change; codes may not.

Validation failures return `400`, authentication failures `401`, environment
authorization failures `403`, and duplicate-ID conflicts `409`. Successful ingestion
returns `202`.

Internal errors never echo database driver messages, which can carry connection
strings.

## 10. Testing

- **`payload-diff` unit:** added, removed, changed, nested objects, index-based array
  comparison, reordered arrays reading as changed, redacted values, complexity limits,
  cyclic input.
- **Capture policy unit:** each of the four modes, built-in secrets redacted even under
  `full-payload`, environment additions applied.
- **Content hash unit:** stable across key order, differs on value change, handles
  nested structures.
- **API integration (Fastify inject + Testcontainers):** valid event accepted; identical
  resubmission returns `duplicate: true` without double-counting; conflicting duplicate
  returns `event_id_conflict`; missing, malformed, and revoked keys rejected; an event
  naming another environment rejected; a key from another project cannot read or write
  another project's journeys; oversized payload and batch rejected; partially invalid
  batch returns per-event results with valid events still stored; journey summary
  reflects min/max timestamps and correct counts; late-arriving older event does not
  change status; aliases stored once when resent.

## 11. Acceptance criteria

- A valid event creates a journey, an event row, and its aliases.
- The same event sent twice stores one event and counts it once.
- The same event ID with different content is rejected with `event_id_conflict`.
- An API key cannot reach another project's data.
- An event naming an environment the key is not scoped to is rejected.
- Configured and built-in secret paths are absent from stored payloads.
- A transformation event stores a diff identifying the changed field.
- A partially invalid batch stores the valid events and reports the rest per event.
- `pnpm test`, `pnpm test:integration`, and the CI pipeline all pass on a clean clone.

## 12. Not in this phase

Search, journey and event read endpoints, the timeline interface, the SDK, propagation,
the demo services, replay, and retention. Those belong to Phase 2 and later.
