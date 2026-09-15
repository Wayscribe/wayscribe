# Recent journeys — design

Date: 2026-09-15. Status: approved for planning (autonomous v1 work).

## Why

Every way into the interface starts from an identifier: the search page asks for
one, and the API has no endpoint that lists journeys. That fits the scenario the
README opens with, a customer calling with their account id. It does not fit the
more common start of an investigation: an alert that deliveries are failing, or a
colleague saying "something broke in the sync worker this morning". Nobody has an
id yet. They need to see what failed, recently, where.

## What a reader gets

A **Recent** page, linked from the search page's heading, listing journeys newest
activity first, with filters:

| Filter | Values | Default |
| --- | --- | --- |
| Status | failed, active, completed, any | failed |
| Window | last hour, 24 hours, 7 days | 24 hours |
| Environment | the project's environments, or all | all |
| Service | a service name (exact), or any | any |

Each row shows what the search results show today (entity, status, event count,
last activity) plus the environment, and links to the journey. The page states
the filter in words ("Failed journeys in the last 24 hours, all environments")
and says how many are shown when a page limit is hit, with a link to the next
page.

The filters are a plain GET form. The page is server-rendered with no client
state, so it works without JavaScript, a filtered view is a shareable URL, and
the browser test is straightforward.

## API

`GET /v1/journeys`

| Query parameter | Meaning |
| --- | --- |
| `status` | `failed`, `active`, `completed`; omitted means any |
| `since` | ISO-8601 instant; journeys whose `last_event_at` is at or after it; required |
| `environment` | environment name; omitted means every environment the principal can read |
| `service` | exact service name; journeys with at least one event from it |
| `limit`, `cursor` | as on the other list endpoints |

- **Authentication and scope:** the same `readScope(principal)` as search. An API
  key sees its own environment only, and asking for another environment returns
  an empty page, not an error, matching how search treats scope. The admin token
  sees every environment of the resolved project.
- **`since` is required** so the query is always bounded by the recent-activity
  index. The web page always sends one.
- **Order:** `last_event_at desc, id desc`, keyset cursor, the same shape as
  search's cursor.
- **Response items:** `{ journeyId, entity: { type, id }, status, eventCount,
  startedAt, lastEventAt, environment }`, with the entity id decrypted through the
  keyring exactly as search presents it (including the unknown-key warning).
- **Validation:** unknown `status`, unparsable `since`, or a `since` in the future
  is `400` with the usual error envelope.

## Storage

- Existing index `journeys_recent_idx (project_id, environment_id,
  last_event_at)` serves an environment-scoped query.
- Migration `013_journeys_status_recent_index.js` adds `(project_id, status,
  last_event_at)` so the default view (failed, all environments, recent) does not
  scan every journey in the project. Verify with `EXPLAIN` on a seeded database
  with at least 100,000 journeys that the default query uses an index and reads a
  bounded number of rows.
- The service filter is `exists (select 1 from journey_events e where
  e.project_id = j.project_id and e.journey_id = j.id and e.service = ?)`. Check
  an index serves it (read `006_journey_events.js`); add one in the same
  migration only if `EXPLAIN` shows the filter scanning events.

## Boundaries

- `packages/database/src/repositories/journey-list.ts`: `listRecentJourneys(db,
  scope, filters, limit, cursor)`.
- `apps/api/src/routes/queries.ts` or a new `routes/journeys.ts`: the route,
  reusing search's authentication, scope, cursor parsing, and presentation
  helpers rather than copying them.
- `apps/web/src/lib/api.ts`: `listRecentJourneys`.
- `apps/web/app/(authenticated)/recent/page.tsx`: the page. A shared results-row
  component with the search page if the markup is the same.
- The web app needs the project's environment names for the filter: use the
  existing projects endpoint if it returns them, otherwise read them from the
  list response's distinct environments plus a small admin endpoint only if
  necessary. Prefer not adding an endpoint.

## Documentation

`docs/API_SPEC.md` (the endpoint), `README.md` ("What you actually get" gains one
sentence about starting from failures), `CHANGELOG.md`.

## Testing

- **Integration, database:** each filter alone and combined; scope (API key
  cannot see another environment); keyset pagination across a page boundary with
  equal `last_event_at` values; `since` bound inclusive.
- **Integration, API:** validation errors; response shape; entity id decrypted;
  admin sees all environments.
- **Performance:** the `EXPLAIN` evidence above, recorded in the task report and
  summarised in a comment on the migration.
- **Web:** Playwright: seed one failed and one completed journey (with the e2e
  seed's versioning), open Recent, see the failed one and not the completed one,
  switch status to any, see both, follow a row to its journey.

## Out of scope

- Aggregates (counts per service, charts).
- Saved views, alerts, notifications.
- Client-side filtering or live updates on this page (the journey page already
  follows a live journey).
