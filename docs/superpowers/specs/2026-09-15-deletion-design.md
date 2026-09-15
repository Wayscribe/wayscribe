# Deleting captured data — design

Date: 2026-09-15. Status: approved for planning (autonomous v1 work).

## Why

Flight Recorder stores what integrations carry, in the operator's own
PostgreSQL. Today the only way anything leaves is the retention sweep
(`packages/database/src/repositories/retention.ts`): time-based, per
environment, all or nothing. Its own debt declaration, `DEBT-N11B8K`, names the
two cases that leaves unanswered:

- **A redaction miss.** Redaction has already missed secrets twice. Fixing the
  matcher does nothing about rows already written; the operator needs to remove
  the journeys that hold the leaked value, now, without waiting out retention.
- **An erasure request.** A customer asks to be forgotten. The operator knows
  the customer's identifier and needs every journey that mentions it gone.

A third case follows from operating the tool: removing a noisy environment's
data from a time window (a load test, a misconfigured service) without dropping
the environment.

## Principles

- **Hard delete.** A soft delete keeps the data the operator asked to remove.
  Rows are deleted; child rows go with them through the existing `ON DELETE
  CASCADE` on the journey's composite key (`journey_events`, `entity_aliases`,
  and, through events, `replay_runs`).
- **Admin only.** API keys ingest; they never delete. The admin token, the web
  session, and the database CLI can.
- **Audited without the value.** Every deletion writes an `audit_events` row. An
  erasure request's identifier is personal data, so the audit row records the
  search token and counts, never the identifier itself.
- **Look before deleting.** The two deletions that select by criteria
  (identifier, time range) support a dry run that reports what would be deleted.
- **Honest about what remains.** Deleted rows stay in PostgreSQL pages until
  vacuum reclaims them, and in any backup taken before the deletion. The
  documentation says so plainly; the tool does not pretend otherwise.

## The four deletions

### 1. One journey

- API: `DELETE /v1/journeys/:journeyId`, admin token, project from the usual
  `x-flight-project-id` resolution. `204` on success, `404` when the journey is
  not in the resolved project (the same answer as a read, so it reveals nothing
  about other projects).
- CLI: `delete:journey <project-slug> <journey-id>`.
- Web: the journey page gains a "Delete this journey" link at the foot of the
  header. It opens `/journeys/:id/delete`, a confirmation page stating the entity,
  the event count, the environment, and that this cannot be undone, with a form
  that posts to a session-checked route handler. On success it redirects to the
  search page with a one-line notice. A link, never a one-click button, for the
  same reason replay is not one click (REPLAY_SPEC section 13).
- Audit: `action: "journey.deleted"`, `resource_type: "journey"`,
  `resource_id: <journey id>`, `metadata: { environment, eventCount }`.

### 2. Everything matching an identifier (erasure)

- Selection: journeys whose `primary_entity_id_hash` or any
  `entity_aliases.alias_value_hash` equals the identifier's search tokens under
  the keyring (both keys during a rotation), within the project, optionally one
  environment. This is exactly what search finds for that value, because it is
  the same token match; "delete what search shows" is the mental model.
- API: `POST /v1/erasures` with `{ value, environment?, dryRun? }`, admin token.
  Dry run returns `{ journeys: [{ id, environment, entityType, eventCount }],
  total }` without deleting. A real run deletes in one transaction per 500
  journeys and returns `{ deletedJourneys, deletedEvents }`.
- CLI: `delete:identifier <project-slug> <value> [--environment <name>]
  [--dry-run]`. It prints the dry-run table, and a real run prints counts.
- No web UI in v1. Erasure is deliberate operator work, and the CLI's dry run is
  the safer surface for it.
- Audit: `action: "erasure.completed"`, `resource_type: "identifier"`,
  `resource_id: null`, `metadata: { token: <current-key token>, environment,
  deletedJourneys, deletedEvents }`. A later erasure of the same value can be
  matched to this row by recomputing the token; the value itself is never
  stored.

### 3. An environment's time window

- Selection: journeys in one environment whose `last_event_at` falls in
  `[after, before)`. `before` is required; `after` defaults to the beginning of
  time. `last_event_at`, matching retention: a journey still receiving events is
  judged by its latest event.
- CLI only: `delete:range <project-slug> <environment> --before <iso-8601>
  [--after <iso-8601>] [--dry-run]`. Batches of 1,000, sharing retention's
  advisory lock so a range deletion and a sweep never run at once. A second
  concurrent run reports the lock is held and exits non-zero.
- Audit: `action: "range.deleted"`, `resource_type: "environment"`,
  `resource_id: <environment id>`, `metadata: { after, before, deletedJourneys }`.

### 4. A replay destination

Found while documenting key rotation: a replay destination whose encrypted
headers no configured key can open keeps `rotate:status` at exit 1, the replay
route refuses it, and nothing can remove it short of editing the database.

- API: `DELETE /v1/replay-destinations/:destinationId`, admin token, project
  resolution as above. `204`, or `404` when not in the project.
- CLI: `delete:destination <project-slug> <destination-id>`.
- `replay_runs.destination_id` references the destination without a cascade.
  Deleting a destination deletes its replay runs in the same transaction: a run
  without its destination cannot be read or repeated, and the runs hold the
  replayed payloads, which are exactly what an operator removing data wants
  gone. The audit row records how many runs went with it.
- Audit: `action: "replay_destination.deleted"`, `resource_type:
  "replay_destination"`, `resource_id: <destination id>`, `metadata: { name,
  deletedRuns }`. The destination's base URL is not recorded: it can carry a
  hostname the operator considers internal, and the name is enough to recognise
  it.

## Implementation boundaries

- `packages/database/src/repositories/deletion.ts`: `deleteJourney`,
  `findJourneysByIdentifier`, `eraseIdentifier`, `deleteRange`,
  `deleteReplayDestination`, each returning
  counts and each writing its audit row in the same transaction as the delete,
  so a delete never commits without its record. `deleteRange` shares the
  retention sweep's advisory lock through the same dedicated-connection,
  transaction-scoped helper the sweep uses (the sweep's earlier session lock
  could leak onto an idle pooled connection; that was fixed on the rotation
  branch, and deletion must not reintroduce it).
- `apps/api/src/routes/deletions.ts`: the three admin routes, reusing the admin
  authentication the replay routes use (`apps/api/src/routes/replays.ts`) rather
  than a copy.
- `packages/database/src/cli.ts`: the four commands.
- `apps/web`: the confirmation page and route handler, using
  `requestSession` and the existing server-side API client.
- Event counts for audit and dry run come from `journeys.event_count` if it is
  maintained, otherwise a grouped count in the same transaction.

## Documentation

- `docs/OPERATIONS.md`: a "Deleting data" section covering the four deletions,
  dry runs, what the audit row holds, vacuum, and backups.
- `docs/API_SPEC.md`: the three routes.
- `docs/SECURITY.md`: erasure and the audit row's deliberate omission.
- `docs/DECISIONS.md`: ADR for hard, admin-only, value-free-audited deletion
  (numbered after the rotation ADR). README ADR count.
- CHANGELOG under Unreleased. Remove the `DEBT-N11B8K` declaration (retention
  stops being the only way to delete).

## Testing

- **Integration, database:** each repository function against PostgreSQL:
  cascades remove events, aliases, and replay runs and nothing in another
  journey, environment, or project; erasure matches by entity id and by alias
  value, and under the previous key's token during a rotation; dry run deletes
  nothing and reports the same set a real run deletes; range bounds are
  half-open; the advisory lock is shared with retention; every deletion writes
  exactly one audit row, and the erasure audit row does not contain the value
  (assert on the serialized metadata).
- **Integration, API:** admin token required (API key gets 401 with the usual
  body); 404 for another project's journey; dry run and real run shapes.
- **Web:** the confirmation page renders the journey's facts; the route handler
  requires a session; after deletion the journey page 404s.
- **Browser:** one Playwright test deletes a seeded journey through the UI and
  confirms search no longer finds it. It seeds its own journey so it cannot
  disturb the other specs.

## Out of scope

- Deleting events inside a journey. A journey is the unit a reader sees, and a
  partial journey is harder to reason about than none.
- Scheduled or rule-based deletion beyond retention.
- A web UI for erasure and range deletion.
- Sweeping `audit_events`.
