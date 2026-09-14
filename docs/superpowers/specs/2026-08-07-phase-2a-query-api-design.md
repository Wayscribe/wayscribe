# Phase 2a: Query API — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** The search-token correction, and the four read endpoints: search, journey,
journey events, and event detail. The web interface and admin sessions are Phase 2b.

## 1. Context

Phase 1b made ingestion work. Nothing can read the result back yet.

This phase also corrects a defect shipped in Phase 1a. `searchToken` includes the alias
type in the HMAC input, which makes value-only lookup impossible: computing the hash
requires already knowing the type. The `(project_id, alias_value_hash)` index exists
specifically for value-only lookup and is therefore unusable, and the product's central
promise — type an identifier into a search box and find the record — cannot work,
because a developer holding an ID from a log line does not know which alias type it was
stored under.

`DATABASE_SCHEMA.md` section 4 says to include the alias type in the HMAC input "when
appropriate". Reading that as "always" broke the primary use case.

## 2. ADR-028: Search tokens are type-independent

`searchToken(key, value)` computes `HMAC-SHA256(searchKey, normalizedValue)`. The alias
type is no longer part of the input.

`entity_aliases.alias_type` remains a plaintext column, used for display and for
type-qualified filtering. Both indexes become useful: `(project_id, alias_value_hash)`
for value-only search, `(project_id, alias_type, alias_value_hash)` for narrowing.

Two alias types carrying the same value now hash identically. That is the desired
behavior for "find anything matching this value", and `alias_type` disambiguates the
results at read time.

Migration 011 adds `(project_id, primary_entity_id_hash)` to `journeys`. The existing
entity index is `(project_id, entity_type, primary_entity_id_hash)`, which has the same
type-dependency problem: searching by entity ID would otherwise require knowing the
entity type.

No production data exists, so there is no backfill. The seed and tests regenerate their
tokens.

## 3. Search resolution

One query string may be any of seven things: journey ID, primary entity ID, alias, trace
ID, span ID, message ID, or correlation ID.

The repository computes the search token once and issues a single query, a CTE with
`OR` and `EXISTS` predicates across the candidate columns, rather than probing each in
turn. Cost scales with journey count rather than with the query (measured 33 ms at
12k journeys, 1.1 s at 120k); a `UNION` rewrite, where each branch would hit its own
index, is tracked as debt (DEBT-82X79Y). Results reduce to distinct journeys ordered
by `last_event_at desc`.

## 4. Pagination

Keyset, never offset.

- Search cursors encode `(last_event_at, id)`.
- Event cursors encode the full ordering tuple from `ARCHITECTURE.md` section 9:
  `(event_timestamp, received_at, id)`.

Cursors are opaque base64. `API_SPEC.md` section 14 forbids exposing database offsets as
a compatibility contract, and keyset pagination stays stable when new events arrive
mid-scroll — offset pagination silently skips or repeats rows when that happens.

A malformed cursor is rejected with a stable error code rather than being ignored,
because silently restarting from the beginning would present duplicate results as if
they were new.

## 5. Endpoints

| Endpoint | Returns |
|---|---|
| `GET /v1/search?q=&limit=&cursor=` | Matching journey summaries |
| `GET /v1/journeys/:journeyId` | One journey summary with aliases and services |
| `GET /v1/journeys/:journeyId/events?limit=&cursor=` | Ordered event list |
| `GET /v1/events/:eventId` | Full event detail including payloads and diff |

All read through repository functions taking `projectId` as their first parameter, the
same convention ingestion uses.

## 6. Scoping

Reads are scoped to the authenticated key's **project and environment**, not project
alone. A development key must not read production journeys.

The filter belongs in the query itself, not in a check applied to results afterwards: a
post-filter still fetches the rows, and a later refactor that forgets the check leaks
silently rather than failing.

Phase 2b's admin session will be project-wide. That is a deliberately broader grant to a
different kind of principal, and it is recorded there rather than assumed here.

## 7. Disclosure

`API_SPEC.md` is asymmetric here, deliberately:

- **Primary entity ID** is returned in full. It is what the user just searched for, so
  returning it reveals nothing they did not already have.
- **Alias values** are masked, e.g. `0018…ABC`. These are *other* identifiers the user
  may not be entitled to see in full.

Masking shows the first four and last three characters when a value exceeds eight
characters, and fully masks anything shorter — a short value is largely revealed by any
partial disclosure.

Event payloads are returned as stored. Redaction already applied at ingestion; there is
no second policy layer at read time, and the capture decision is not revisited.

## 8. Error handling

Stable codes in the `API_SPEC.md` section 2 envelope. A journey or event belonging to
another project returns `404`, not `403` — confirming existence to an unauthorized
caller is itself a disclosure.

## 9. Testing

- **Unit:** cursor encode and decode round-trip, malformed cursor rejected, masking rules
  at boundary lengths, search-token type-independence.
- **Integration:** search by each of the seven identifier kinds; a journey found by two
  different alias types with the same value; cross-project isolation returning 404;
  cross-environment isolation; deterministic event ordering including a timestamp tie
  broken by received_at then ID; cursor stability when a new event is inserted
  mid-pagination; alias display values masked; payload returned as stored.

## 10. Acceptance criteria

- A journey is findable by primary entity ID, by alias value, by journey ID, and by trace,
  span, message, and correlation ID.
- Searching an alias value without knowing its type succeeds. This is the defect ADR-028
  fixes and is the phase's central proof.
- A key cannot read another project's or another environment's data.
- Events return in deterministic order across pages.
- Alias display values are masked; primary entity IDs are not.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 11. Not in this phase

The web interface, admin-token sessions, the diff viewer, Playwright tests, the SDK,
propagation, the demo services, replay, and retention.
