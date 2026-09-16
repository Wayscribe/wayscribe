# API Specification

## 1. Conventions

Base path:

```text
/v1
```

Content type:

```text
application/json
```

Authentication for SDK ingestion:

```text
Authorization: Bearer <project-environment-api-key>
```

Authentication for reads:

```text
Authorization: Bearer <admin-token>
x-flight-project-id: <project-id>
```

The header is exactly the scheme, one space, and the token. The scheme is read in
any case; anything after the token, a trailing space included, is `401`.

An API key is scoped to one project and one environment and may ingest. An admin
token reads across every environment of one **named** project and may not ingest
(ADR-029).

`x-flight-project-id` selects that project. It may be omitted when the
installation has exactly one project, in which case the API resolves it; with
more than one, omitting it is a `404 project_not_found` rather than a guess. The
web interface stores the selection in its session.

`GET /v1/projects` lists them. It takes the admin token alone, because it
answers the question a caller has before it can name a project. Each item
carries the project's environment names, sorted, which is what the web
interface offers as the environment filter on the Journeys page:

```json
{
  "data": {
    "items": [
      {
        "id": "7d0c…",
        "name": "Acme Payments",
        "slug": "acme",
        "environments": ["development", "production"]
      }
    ]
  }
}
```

The web interface authenticates a person with `ADMIN_TOKEN` and holds an
HMAC-signed session cookie. The admin token itself never reaches the browser.

All timestamps are UTC ISO 8601 strings.

## 2. Error format

```json
{
  "error": {
    "code": "invalid_event",
    "message": "The event did not match protocol version 0.1.",
    "requestId": "req_123",
    "details": [
      {
        "path": "event.timestamp",
        "message": "Expected an ISO 8601 UTC timestamp."
      }
    ]
  }
}
```

Stable error codes are required. Human-readable messages may evolve.

Any route that queries the database can answer `503` with code `query_timeout`
when a statement runs past `DATABASE_STATEMENT_TIMEOUT_MS` (15 seconds by
default) and is cancelled. It is transient: retrying later, or narrowing the
request, is the right response. In a batch, an event whose statement was
cancelled is refused on its own with `query_timeout` and `httpStatus` 503
(section 4).

Every route that accepts the admin token (all but ingestion and the health
checks) answers `429` with code `too_many_attempts` and a `Retry-After` header,
in seconds, to a source address that has had five credentials refused within a
minute, for five minutes, whatever token it presents. The refusals themselves
are the ordinary `401` (`docs/OPERATIONS.md` §9). Only refused credentials
count: a request with no `Authorization` header does not, and neither does a
`500` from a database error while a key is looked up.

The lock is checked before any credential. Sent one after another, a sixth
guess is always `429`. Sent at once, requests that passed the check before the
fifth refusal was recorded still have their credential checked: on the
admin-only routes the comparison follows the check without waiting on anything,
while on the read routes an API key is looked up in the database, so a burst can
have up to its own concurrency checked before the lock takes effect. Every
request after that is `429`. Reads with a valid key are never held back, however
many arrive at once.

An unexpected failure is `500` with code `internal_error` and a generic message.
The code is never the database's own: a PostgreSQL SQLSTATE such as `22P02` is
not part of this contract and never appears in `error.code`.

Input the database would refuse is refused first, with a `4xx`, before any query
runs: an id that must be a uuid and is not (`404` in a path, `400
invalid_request` in a body), a null byte in a path id (`404`), in a query
parameter (`400 invalid_query`), in a cursor (`400 invalid_cursor`), or in a
replay or destination field or an erasure value (`400 invalid_request`), and a
missing body or a field of the wrong type (`400`). Ingestion is the exception, and its
refusals are listed in [`INGESTION_CONTRACT.md`](INGESTION_CONTRACT.md) section
4 rather than here: text PostgreSQL cannot store is discovered by the insert
rather than by a check in front of it, so it is answered per event.

A request that matches no route gets `404` with code `not_found`, in this shape.
Its message names the method and path, never the query string or matrix
parameters. A URL the router cannot read gets `400` with code `bad_url` when its
percent-encoding is malformed, and `414` with code `parameter_too_long` when a
path parameter is longer than any id the API accepts. Neither quotes the URL.

## 3. Ingest one event

```http
POST /v1/events
```

One envelope, `{ "protocolVersion": "0.1", "event": { … } }`, under an API key.
An accepted event answers `202` with
`{ "data": { "eventId", "journeyId", "status", "duplicate" } }`.

## 4. Ingest a batch

```http
POST /v1/events/batch
```

`{ "events": [ … ] }`, at most a hundred envelopes, under an API key. The
response is `202` with one result per sent event, in order and matched by
position, whether or not every event was accepted. Add `?dryRun=true` to
validate the batch and roll it back without storing anything.

**[`INGESTION_CONTRACT.md`](INGESTION_CONTRACT.md) is normative for both
routes** and is where a client author should start: the limits and their
configuration names, every refusal code with its status and whether to retry it,
idempotency and the content hash, what the server does to an accepted event, the
dry run, and the conformance case format. It is the one file that owns
ingestion, so that the two documents cannot answer the same question differently
(ADR-049).

## 5. Search

```http
GET /v1/search?q=<query>&limit=25&cursor=<cursor>
```

Searches project-scoped:

- primary entity ID
- alias
- journey ID
- trace ID
- span ID
- message ID
- correlation ID

Response:

```json
{
  "data": {
    "items": [
      {
        "journeyId": "jrn_01",
        "entity": {
          "type": "customer",
          "id": "18492"
        },
        "status": "failed",
        "eventCount": 8,
        "startedAt": "2026-08-06T18:31:02.000Z",
        "lastEventAt": "2026-08-06T18:34:38.000Z",
        "label": "Acme renewal, 2026",
        "lastStep": "sync-account",
        "displayableAliases": [{ "type": "postingId", "value": "greenhouse:4567" }]
      }
    ],
    "nextCursor": null
  }
}
```

`label` is the journey's label, or null until an event carries one. `lastStep`
is the `name` of its latest event, or null for a journey no event has reached
since the server began storing it. `displayableAliases` lists only the aliases
a reader may see in full (ADR-053), as `{ type, value }`, ordered by alias type
and then by value; a masked alias is never listed. A displayable alias written
before the server kept plain-text copies is listed once an event states it
again. A displayable value containing a NUL is never listed or matched by `q`,
because the server keeps no plain-text copy of it; the journey read shows it.

A missing or empty `q`, or `q` given more than once, is `400` `invalid_query`. A
`cursor` given more than once is `400` `invalid_cursor`, on every list endpoint.

## 6. List journeys

```http
GET /v1/journeys?since=<instant, required>&until=<instant>&status=failed&environment=<name>&service=<name>&entityType=<type>&q=<text>&limit=25&cursor=<cursor>
```

**`since` is required, and has no default.** The list is always a window: it
holds journeys whose last activity is at or after `since`, an ISO 8601 instant
with a time zone, such as `2026-08-06T18:00:00Z`. For the last 24 hours, send
the instant 24 hours before now, computed once and kept for every page.
Without it the answer is `400 invalid_query` with a message saying so.

For an investigation that starts without an identifier: what failed, recently,
where. Journeys are ordered by last activity, newest first (`lastEventAt`, then
`journeyId`, both descending).

| Parameter | Meaning |
| --- | --- |
| `since` | Required. An ISO 8601 instant with a time zone, such as `2026-08-06T18:00:00Z`. Journeys whose last activity is at or after it. |
| `until` | An ISO 8601 instant with a time zone, after `since`. Journeys whose last activity is before it. Omitted or empty means no upper bound. |
| `status` | `active`, `completed` or `failed`. Omitted or empty means any status. |
| `environment` | An environment name. Omitted or empty means every environment the caller can read. |
| `service` | An exact service name. Journeys with at least one event recorded by that service. |
| `entityType` | An exact entity type, at most 128 characters. |
| `q` | Text of 2 to 200 characters, after surrounding white space is removed. Journeys whose label, or the value of one of whose displayable aliases, contains it, ignoring case. Omitted, empty or white space alone means no text filter. |
| `limit` | Page size, 25 by default, at most 100. |
| `cursor` | `nextCursor` from the previous page. |

**What `q` matches.** Only the two values stored in plain text: the journey's
`label` and the values of its displayable aliases (ADR-053). It never matches
a masked alias value, the entity id, a journey id or an entity type, even when
the text is exactly one of them: those are stored as ciphertext and search
tokens, and are found by exact value through search (section 5). `%`, `_` and
`\` are ordinary characters in `q`, not wildcards. Characters are counted as
Unicode code points.

**What "ignoring case" means.** The comparison is PostgreSQL's `ILIKE`, which
lowers both sides using the database's character classification (`LC_CTYPE`,
fixed when the database was created). Under a UTF-8 locale such as
`en_US.utf8`, the default of the official PostgreSQL images and the one the
tests run on, `CAFÉ` finds `Café` and `été` finds `Été`. Accents are not
removed: `cafe` does not find `Café`. A database created with the `C` locale
lowers ASCII letters only, so there `CAFÉ` would not find `Café`. Run
`select datctype from pg_database where datname = current_database()` to see
which applies.

`q` filters the journeys inside the `since`/`until` window, so its cost grows
with the number of journeys in the window, not with the size of the table.

Scope is the same as search. An API key reads its own environment only; naming
another environment returns an empty page, not an error. The admin token reads
every environment of the named project.

`400 invalid_query` when `since` is missing, is not a full instant with a time
zone (the message gives an example of one), names an impossible date, or is more than 60 seconds ahead of the API's
clock (a minute of skew between the caller and the API is tolerated); when
`until` is not a full instant, names an impossible date, or is not after
`since`; when `status` is not one of the three values; when `entityType` is
longer than 128 characters; when `q` is shorter than 2 or longer than 200
characters; when any value holds a NUL; when any parameter is given more than
once; or when the query names a parameter this list does not have, so that a
misspelt filter is not silently ignored. `until` has no clock check: a range
that ends after now lists everything up to now, whereas a future `since` could
only list nothing. A malformed cursor is `400 invalid_cursor`.

Keep `since` fixed while paging: a cursor continues the list it came from, and
recomputing "24 hours ago" for each page moves the window under it.
A cursor holds a position in the list, the last row's `lastEventAt` and
`journeyId`, and nothing about the filters, which always come from the request.
Sent with different filters, it is not refused: it lists the rows those filters
match that come after that position. To start a changed filter from the top,
leave the cursor out. That is also
why the server does not default it: a default would be recomputed on every
request. A journey
that receives an event between two page requests moves to the top of the list,
above the cursor, and does not appear on later pages. Search pages behave the
same way.

Response items are search results with the environment added:

```json
{
  "data": {
    "items": [
      {
        "journeyId": "jrn_01",
        "entity": {
          "type": "customer",
          "id": "18492"
        },
        "status": "failed",
        "eventCount": 8,
        "startedAt": "2026-08-06T18:31:02.000Z",
        "lastEventAt": "2026-08-06T18:34:38.000Z",
        "label": "Acme renewal, 2026",
        "lastStep": "sync-account",
        "displayableAliases": [],
        "environment": "production"
      }
    ],
    "nextCursor": null
  }
}
```

## 7. Get journey

```http
GET /v1/journeys/:journeyId
```

Response:

```json
{
  "data": {
    "journeyId": "jrn_01",
    "environment": "production",
    "entity": {
      "type": "customer",
      "id": "18492"
    },
    "status": "failed",
    "label": "Acme renewal, 2026",
    "lastStep": "sync-account",
    "aliases": [
      { "type": "salesforceAccountId", "displayValue": "0018…ABC", "displayable": false },
      { "type": "postingId", "displayValue": "greenhouse:4567", "displayable": true }
    ],
    "services": [],
    "eventCount": 8,
    "startedAt": "2026-08-06T18:31:02.000Z",
    "completedAt": null,
    "lastEventAt": "2026-08-06T18:34:38.000Z"
  }
}
```

`label` and `lastStep` are as in a search result (section 5). An alias's
`displayValue` is masked unless `displayable` is true, which it is
only when every event that stated the alias listed it in `displayableAliases`
(ADR-053, `docs/SECURITY.md` section 6). It is null when the key that encrypted
it is no longer held.

## 8. List journey events

```http
GET /v1/journeys/:journeyId/events?limit=100&cursor=<cursor>
```

Ordering:

1. event timestamp
2. server received timestamp
3. event ID

Response:

```json
{
  "data": {
    "items": [
      {
        "id": "evt_01",
        "operation": "received",
        "name": "receive-salesforce-webhook",
        "service": "customer-integration",
        "eventTimestamp": "2026-08-06T18:31:02.000Z",
        "durationMs": 18,
        "hasInput": true,
        "hasOutput": false,
        "hasError": false
      }
    ],
    "nextCursor": null
  }
}
```

## 9. Get event details

```http
GET /v1/events/:eventId
```

Response may include:

- payloads according to permission and capture policy
- structural diff
- error
- runtime metadata
- deployment metadata
- technical identifiers
- replay eligibility

## 10. Create replay destination

```http
POST /v1/replay-destinations
```

Request:

```json
{
  "name": "Local integration API",
  "baseUrl": "http://host.docker.internal:3200",
  "environmentType": "development",
  "headers": {
    "x-replay-key": "configured-secret"
  }
}
```

`baseUrl` is an origin with an optional base path. The relative `path` supplied on a
replay request is appended to it. Path traversal, absolute URLs, and protocol-relative
URLs are rejected. See ADR-019.

The server must validate the destination against configured host policy.

Sensitive headers must be encrypted at rest or loaded from environment-backed secret configuration.

## 11. List replay destinations

```http
GET /v1/replay-destinations
```

Secrets are never returned.

## 12. Create replay

```http
POST /v1/replays
```

Request:

```json
{
  "eventId": "evt_transform_01",
  "destinationId": "rpd_01",
  "method": "POST",
  "path": "/replay/customer",
  "payload": {
    "id": "0018Z00002ABC",
    "phone": "+1 919 555 1234"
  },
  "headers": {
    "content-type": "application/json"
  }
}
```

Response:

```json
{
  "data": {
    "replayId": "rpl_01",
    "status": "completed",
    "responseStatus": 200,
    "durationMs": 83
  }
}
```

V0 may execute synchronously with a strict timeout. A background replay worker can be introduced later.

A missing body, a field that is not a string, a `destinationId` that is not a
uuid, or a null byte in `eventId` or `path` is `400` `invalid_request`.

## 13. Get replay

```http
GET /v1/replays/:replayId
```

A `replayId` that is not a uuid is `404` `not_found`, the same answer as an
unknown replay.

Returns:

- sanitized request, including `requestHeaders`: every header sent, by name,
  with `[REDACTED]` as the value of each destination header and blocked name
  (`REPLAY_SPEC.md` section 8)
- response status
- sanitized response
- timing
- result diff
- audit metadata

## 14. Health endpoints

```http
GET /health
GET /ready
```

`/health` checks the process.

`/ready` verifies required dependencies such as PostgreSQL.

Metrics are not on this port. With `METRICS_PORT` set, the API serves
`GET /metrics` on that port alone (`docs/OPERATIONS.md` §13); `/metrics` on the
API port is 404.

## 15. Pagination

Use cursor pagination for events, search results and the journey list.

Do not expose database offsets as a compatibility contract.

## 16. Request limits

Initial configurable limits should cover:

- total request body
- event payload
- batch size
- metadata depth
- string lengths
- replay response body
- replay duration

Exact defaults belong in configuration documentation once implementation measurements exist.

## 17. Delete a journey

```http
DELETE /v1/journeys/:journeyId
Authorization: Bearer <admin-token>
x-flight-project-id: <project-id>
```

Admin token only. An API key gets `401 unauthorized` with the same body as the
replay routes: API keys ingest and never delete (ADR-045).

Deletes the journey, its events, its aliases, and the replay runs of its events,
and writes a `journey.deleted` audit row in the same transaction.

- `204` with no body when deleted.
- `404 not_found` when the journey is not in the named project, the same answer
  as a read, so it reveals nothing about other projects.
- `400 invalid_request` for a journey id containing a null byte or longer than
  the protocol's 128 characters.
- `404 project_not_found` when `x-flight-project-id` is not a UUID, names no
  project, or is omitted while more than one project exists.

A path parameter longer than 1,152 characters as encoded in the URL, nine for
each of the protocol's 128, is refused with `414` before any route runs.

## 18. Erase an identifier

```http
POST /v1/erasures
Authorization: Bearer <admin-token>
x-flight-project-id: <project-id>
```

Request:

```json
{
  "value": "customer-42@example.com",
  "environment": "production",
  "dryRun": true
}
```

Selects every journey in the project whose entity id or any alias matches
`value` under the configured keys, which is what search finds for it by
identifier. `environment` is optional and limits it to one environment by name.
Only journeys that existed when the request started are selected.

Dry run response, `200`. Nothing is deleted and no audit row is written.
`journeys` lists at most 1,000, most recent first; `total` counts every match.

```json
{
  "data": {
    "journeys": [
      {
        "id": "jrn_01",
        "environment": "production",
        "entityType": "customer",
        "eventCount": 8,
        "lastEventAt": "2026-08-06T18:34:38.000Z"
      }
    ],
    "total": 1
  }
}
```

Real run response, `200`, after deleting in transactions of 500 journeys and
writing one `erasure.completed` audit row that holds the search token and counts,
never the value:

```json
{
  "data": {
    "deletedJourneys": 1,
    "deletedEvents": 8,
    "complete": true
  }
}
```

When some batches committed and a later one failed, the response is still `200`,
with `complete: false`, the counts of what was deleted, and a `message` saying to
run the erasure again. The audit row also says `complete: false`.

Errors:

- `400 invalid_request` when `value` is missing, not a string, longer than 512
  characters, only whitespace, or contains a null byte; when `environment` is
  empty, not a string, or contains a null byte; or when `dryRun` is not a
  boolean.
- `404 environment_not_found` when the project has no environment with that
  name.
- `404 project_not_found` when `x-flight-project-id` is not a UUID, names no
  project, or is omitted while more than one project exists.

## 19. Delete a replay destination

```http
DELETE /v1/replay-destinations/:destinationId
Authorization: Bearer <admin-token>
x-flight-project-id: <project-id>
```

Deletes the destination and every replay run sent to it, in one transaction. A
run cannot be read or repeated without its destination, and runs hold the
replayed payloads. The `replay_destination.deleted` audit row records the name
and the number of runs, not the base URL or the headers.

- `204` with no body when deleted.
- `404 not_found` when the destination is not in the named project, or the id is
  not a UUID.
- `400 invalid_request` for an id containing a null byte or longer than 512
  characters.
- `404 project_not_found` when `x-flight-project-id` is not a UUID, names no
  project, or is omitted while more than one project exists.
