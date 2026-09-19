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

Authentication for reads, with the admin token:

```text
Authorization: Bearer <admin-token>
x-wayscribe-project-id: <project-id>
```

Authentication for reads, with an API key:

```text
Authorization: Bearer <project-environment-api-key>
```

The header is exactly the scheme, one space, and the token. The scheme is read in
any case; anything after the token, a trailing space included, is `401`.

**Either credential may read.** An API key is scoped to one project and one
environment: it may ingest, and it reads its own environment and nothing else.
An admin token reads across every environment of one **named** project and may
not ingest, because ingestion writes into a specific environment and an admin
token names none (ADR-029). A key names its own project, so it sends no
`x-wayscribe-project-id`; the header is how an admin names one.

The reads both credentials serve are search (section 5), the journey list
(section 6), a journey (section 7), its events (section 8) and an event
(section 9). The rest take the admin token alone: `GET /v1/projects` below,
every replay route (sections 10 to 13, 19) because replay sends stored data to
a destination and an API key must be refused outright rather than resolved
(ADR-032), and every deletion (sections 17 and 18) because keys ingest and
never delete (ADR-045).

`x-wayscribe-project-id` selects that project. It may be omitted when the
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
GET /v1/search?q=<query>&since=<instant>&until=<instant>&environment=<name>&limit=25&cursor=<cursor>
```

Resolves one value against every identifier it could be, project-scoped:

- primary entity ID
- alias
- journey ID
- trace ID
- span ID
- message ID
- correlation ID

| Parameter | Meaning |
| --- | --- |
| `q` | Required. The value to resolve. Surrounding white space is removed. |
| `since` | An ISO 8601 instant with a time zone, such as `2026-08-06T18:00:00Z`. Journeys whose last activity is at or after it. Omitted or empty means no lower bound. |
| `until` | An ISO 8601 instant with a time zone, after `since`. Journeys whose last activity is before it. Omitted or empty means no upper bound. |
| `environment` | An environment name. Omitted or empty means every environment the caller can read. |
| `limit` | Page size: a whole number of at least 1, 25 when omitted or empty; above 100 it is read as 100, and `nextCursor` says whether more remains. Anything else is refused. |
| `cursor` | `nextCursor` from the previous page. |

**Without a window the search spans the project's whole history.** There is no
default: `since` and `until` are optional here, unlike the journey list's
required `since` (section 6), because search is the endpoint a caller reaches
for with an identifier in hand and usually wants every trace of it. That is
safe for a value that never repeats, such as a journey ID or a trace ID, and
surprising for one that does. An alias drawn from a fixed set, an email address
or a phone number, is recorded again on every run, so searching for it returns
every journey that ever carried it, not the one from the run in hand. Give the
run's own `since` and `until` when that matters; they are the same bounds, on
the same `lastEventAt`, that section 6 takes, so one pair narrows both
endpoints.

The window selects journeys, not events: a journey whose matching event falls
inside the window but whose last activity is after `until` is outside it. The
bounds are half-open, `since` inclusive and `until` exclusive, so two adjacent
windows neither overlap nor skip a journey.

**What `environment` means depends on who is asking.** It is applied on top of
the caller's scope, never instead of it (ADR-029). An API key already reads its
own environment and nothing else, so naming that environment restates the
scope and changes nothing, and naming any other returns an empty page rather
than an error, because outside its scope nothing exists. It cannot widen what a
key can see. For the admin token, which reads every environment of the named
project, it picks one of them. Scope is otherwise the same as the journey
list's.

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
        "failedStep": "push-hubspot",
        "displayableAliases": [{ "type": "postingId", "value": "greenhouse:4567" }],
        "environment": "production"
      }
    ],
    "nextCursor": null
  }
}
```

`environment` is the name of the journey's environment. A search spans every
environment the caller can read, which for the admin token is every environment
of the project, so this is what tells two rows for the same identifier apart;
with the `environment` parameter it names the one that was asked for.

`label` is the journey's label, or null until an event carries one. `lastStep`
is the `name` of its latest event, or null for a journey no event has reached
since the server began storing it. `failedStep` is the `name` of the step that
failed the journey (ADR-063): of the failing events applied since the journey
last became `failed`, the one last in timeline order, `(timestamp, received at,
event id)`, the order `lastStep` uses. So while a retry is in flight,
`lastStep` moves on to the retry's steps and `failedStep` still names the step
that failed. It is null whenever `status` is not `failed`, and so is cleared by
a successful retry and by a completion. Two failures name the later-stamped
one whichever arrives first; a failure stamped before a clearing retry but
applied after it fails the journey again, and is the one named. A failed
journey whose failure predates the server storing it has `failedStep` null
until its next failure; show `lastStep` for it, as before. `displayableAliases` lists only the aliases
a reader may see in full (ADR-053), as `{ type, value }`, ordered by alias type
and then by value; a masked alias is never listed. A displayable alias written
before the server kept plain-text copies is listed once an event states it
again. A displayable value containing a NUL is never listed or matched by `q`,
because the server keeps no plain-text copy of it; the journey read shows it.

`400 invalid_query` when `q` is missing or empty, or is given more than once;
when `since` or `until` is not a full instant with a time zone (the message
gives an example of one) or names an impossible date; when `since` is more than
60 seconds ahead of the API's clock (a minute of skew between the caller and
the API is tolerated); when `until` is not after `since`; when any value holds
a NUL; when `since`, `until`, `environment` or `limit` is given more than once;
when `limit` is not a whole number of at least 1; or when the query names a
parameter this search does not have, so that a misspelt filter is not silently
ignored. `until` has no clock check: a range that ends
after now still searches everything up to now, whereas a future `since` could
only find nothing. A `cursor` given more than once, or a malformed one, is
`400` `invalid_cursor`, on every list endpoint.

A cursor holds a position only, `lastEventAt` and `journeyId`, and never the
filters, which always come from the request, so keep the window fixed while
paging, exactly as section 6 says.

## 6. List journeys

```http
GET /v1/journeys?since=<instant, required>&until=<instant>&status=failed&environment=<name>&service=<name>&entityType=<type>&q=<text>&minDurationMs=<milliseconds>&minStepDurationMs=<milliseconds>&inactiveBefore=<instant>&limit=25&cursor=<cursor>
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
| `status` | `active`, `completed` or `failed`. Omitted or empty means any status. See the status vocabulary below. |
| `environment` | An environment name. Omitted or empty means every environment the caller can read. |
| `service` | An exact service name. Journeys with at least one event recorded by that service. |
| `entityType` | An exact entity type, at most 128 characters, after surrounding white space is removed. Omitted, empty or white space alone means any entity type. A type stored with surrounding white space cannot be matched. |
| `q` | Text of 2 to 200 characters, after surrounding white space is removed. Journeys whose label, or the value of one of whose displayable aliases, contains it, ignoring case. Omitted, empty or white space alone means no text filter. |
| `minDurationMs` | A whole number from 0 through 2,147,483,647. Journeys whose recorded first-to-last event-start span is strictly greater than this many milliseconds. |
| `minStepDurationMs` | A whole number from 0 through 2,147,483,647. Journeys with at least one stored event duration strictly greater than this many milliseconds. An unknown duration does not match. |
| `inactiveBefore` | An ISO 8601 instant with a time zone, no later than the API's clock. Active journeys whose last activity is strictly before it. It implies `status=active`; an explicit `completed` or `failed` status is refused. |
| `limit` | Page size: a whole number of at least 1, 25 when omitted or empty; above 100 it is read as 100, and `nextCursor` says whether more remains. Anything else is refused. |
| `cursor` | `nextCursor` from the previous page. |

**What a journey's status means.** A journey is `active` until an event says
otherwise, and every read that returns a journey returns one of three values.

| Status | What it means |
| --- | --- |
| `active` | The journey is running, or has been running and nothing has said it ended. |
| `completed` | The run reached its end: a `completed` operation at or after the newest event's timestamp, which in practice is the SDK's `finish()`. Nothing else sets it. |
| `failed` | Some event carried an error or the operation `failed`. A failure registers whatever its timestamp says, because a step that fails slowly is stamped before it arrives. `failedStep` names the step (section 5). |

A **successful retry clears a failure and does not complete the journey**
(ADR-061). A `retried` event carrying no error is the success of a step that
failed before, since an SDK records a retried call as `retried` whichever way
it comes out, and it returns the status to `active` rather than to
`completed`. A journey that retried successfully and then died without
finishing must not read as completed: a falsely reassuring status is worse
than a stale alarming one. A `retried` event that carries an error is an
ordinary failure. The clearing follows the same ordering rules as any other
status change, so a retry stamped before the newest event changes nothing.

**`completedAt` does not track the status.** It is set only by a `completed`
operation, so a retry never sets one, and it is **never cleared**, so a journey
that completed, then failed, then was cleared back to `active` by a successful
retry keeps the `completedAt` it was given. Read it as "when this journey last
recorded a completion", not as "this journey is complete"; the status is the
field that answers that. A journey that never completed has `completedAt` null.

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

Journey duration is `lastEventAt - startedAt`, the span between recorded event
starts. It is not a sum of step durations, completion latency, or time since
the journey was created. A one-event journey has a measured span of zero, even
when that event has its own nonzero duration. Timestamps from different hosts
can disagree.

Scope is the same as search. An API key reads its own environment only; naming
another environment returns an empty page, not an error. The admin token reads
every environment of the named project.

`400 invalid_query` when `since` is missing, is not a full instant with a time
zone (the message gives an example of one), names an impossible date, or is more than 60 seconds ahead of the API's
clock (a minute of skew between the caller and the API is tolerated); when
`until` is not a full instant, names an impossible date, or is not after
`since`; when `status` is not one of the three values; when either duration
threshold is not a whole number from 0 through 2,147,483,647; when
`inactiveBefore` is not a full instant, is in the future, or is combined with
an explicit status other than `active`; when `entityType` is
longer than 128 characters; when `q` is shorter than 2 or longer than 200
characters; when `limit` is not a whole number of at least 1; when any value
holds a NUL; when any parameter is given more than
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

Response items have the same fields as search results (section 5):

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
        "failedStep": "push-hubspot",
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
    "failedStep": "push-hubspot",
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

`completedAt` is when the journey last recorded a `completed` operation at or
after the newest event's timestamp, and null when it never has. It is never
cleared, so it can be set on a journey whose `status` is `failed` or `active`:
the two fields answer different questions, and section 6 has the rule.

`label`, `lastStep` and `failedStep` are as in a search result (section 5).
`journeyId` is an opaque string; EVENT_PROTOCOL.md section 4 describes the
shapes the Node SDK makes, and a client must not parse or validate them. An alias's
`displayValue` is masked unless `displayable` is true, which it is
only when every event that stated the alias listed it in `displayableAliases`
(ADR-053, `docs/SECURITY.md` section 6). It is null when the key that encrypted
it is no longer held.

## 8. List journey events

```http
GET /v1/journeys/:journeyId/events?limit=100&cursor=<cursor>
```

`limit` is the page size: a whole number of at least 1, 25 when omitted or
empty; above 100 it is read as 100, and `nextCursor` says whether more
remains. `400 invalid_query` when it is anything else, holds a NUL, or is given
more than once, and when the query names a parameter this route does not have;
a malformed `cursor`, or one given more than once, is `400 invalid_cursor`.

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
        "receivedAt": "2026-08-06T18:31:02.140Z",
        "durationMs": 18,
        "hasInput": true,
        "hasOutput": false,
        "hasError": false,
        "deploymentMetadata": { "version": "1.4.2", "gitCommit": "3f9c2e1" },
        "timingContext": {
          "queue": "customer-updates",
          "queueWaitMs": 0,
          "queueWaitBasis": "initial-enqueue",
          "attempt": 1
        },
        "recordedHost": "customer-integration-7d9c"
      }
    ],
    "nextCursor": null
  }
}
```

Every item carries all thirteen fields. `receivedAt` is when the server received
the event, as opposed to `eventTimestamp`, which is when the instrumented
service says it happened; it is the second term of the ordering above, so a
caller that reproduces the order needs it. `durationMs` is null when the event
recorded no duration.

`deploymentMetadata` is the build that recorded the event, the same value
section 9 returns: the event's `deployment` as stored (`gitCommit`, `version`
and `image`, each optional), or null when the event carried none. It is on the row so that whether a
journey's events all came from one build can be read from the timeline, rather
than from one full event read per event. The payloads stay off the row.

`timingContext` contains only valid bounded keys from the event's already-redacted
custom metadata; it is `{}` when no timing evidence is usable. A measured zero
stays zero. `recordedHost` is the bounded already-redacted `runtime.hostname`,
or null when none is usable. Arbitrary custom metadata, runtime metadata, and
payloads stay off timeline rows. Older API versions may omit both added fields.

## 9. Get event details

```http
GET /v1/events/:eventId
```

The response is the stored event, as
[`stored-event.schema.json`](../packages/protocol/schemas/0.1/stored-event.schema.json)
describes it: its ids (`id`, `journeyId`, `parentEventId`, `traceId`, `spanId`,
`messageId`, `correlationId`), `operation`, `name`, `service`,
`eventTimestamp`, `receivedAt`, `durationMs`, `hasInput`, `hasOutput`,
`hasError`, `inputPayload` and `outputPayload` as the capture mode stored them,
`payloadDiff`, `error`, the runtime, deployment and custom metadata, and
`aliases`. It also returns the same `timingContext` and `recordedHost`
interpretation as a timeline row while preserving the raw custom and runtime
metadata. An API key reads events of its own environment only.

`aliases` is what the event stated, which is what an `identified` event exists
to record: each alias as section 7 shows it, `{ type, displayValue,
displayable }`, from the same stored alias and masked the same way, in alias
type order. An alias is stored once per journey, so its display flag is the
journey's: when a later event masks an alias, every event that stated it shows
it masked (ADR-053). `aliases` is `[]` for an event that stated none, and
`null` for an event stored before the server recorded which aliases an event
stated (`docs/OPERATIONS.md` section 4, migration 020); the journey still has
those aliases.

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

`environmentType` must be `local`, `development` or `test`; anything else is
`400 invalid_environment_type`. The host is not checked when the destination is
created: `REPLAY_ALLOWED_HOSTS` is applied to every replay, when it is sent
(section 12). `headers` are encrypted at rest with a key derived from
`ENCRYPTION_KEY`. Creating a destination writes a `replay_destination.created`
audit row that records its name and not its base URL. There is no route that
updates a destination.

## 11. List replay destinations

```http
GET /v1/replay-destinations
```

Configured header values are never returned.

## 12. Create replay

```http
POST /v1/replays
```

Request:

```json
{
  "eventId": "evt_transform_01",
  "destinationId": "7d0c…",
  "method": "POST",
  "path": "/replay/customer"
}
```

`method` is `POST`, `PUT` or `PATCH`, and `POST` when omitted. There is no
`payload` or `headers` field: the body sent is the event's recorded input,
exactly as stored (ADR-032), and the headers are the destination's own plus
`content-type`, `user-agent` and `x-wayscribe-replay` (`SECURITY.md` section 9).
`path` is appended to the destination's base URL; absolute URLs,
protocol-relative URLs and path traversal are refused (ADR-019).

The replay runs synchronously, with a 10-second timeout, and reads at most
256 KiB of the response. The answer is the stored run: `200` when the
destination was reached or the request failed, `422` when it was blocked (a host
outside `REPLAY_ALLOWED_HOSTS`, or destination headers that cannot be
decrypted).

```json
{
  "data": {
    "id": "5b1e…",
    "eventId": "evt_transform_01",
    "destinationId": "7d0c…",
    "method": "POST",
    "path": "/replay/customer",
    "requestPayload": { "id": "0018Z00002ABC", "phone": "+1 919 555 1234" },
    "requestHeaders": { "content-type": "application/json", "user-agent": "wayscribe-replay", "x-wayscribe-replay": "true" },
    "status": "completed",
    "responseStatus": 200,
    "responsePayload": { "phone": "+1 919 555 1234" },
    "durationMs": 83,
    "error": null,
    "createdAt": "2026-08-06T18:40:00.000Z",
    "completedAt": "2026-08-06T18:40:00.083Z",
    "comparison": []
  }
}
```

`comparison` is the diff of the event's recorded output against the response,
or null when the run did not complete or the event recorded no output.

An unknown event or destination is `404 not_found`, an event with no captured
input is `409 no_captured_input`, and a disabled destination is
`409 destination_disabled`. None of these writes a run or an audit row.

A missing body, a field that is not a string, a `destinationId` that is not a
uuid, or a null byte in `eventId` or `path` is `400` `invalid_request`.

Unknown keys in the body are ignored, not refused. The parser reads `eventId`,
`destinationId`, `method` and `path`, and any other key is dropped without a
warning, so a body carrying `payload` or `headers` gets an ordinary replay of
the recorded input and no sign that those fields meant nothing. This is not a
promise of symmetry with ingestion. Ingestion also accepts and drops an unknown
field, but there it is a decided rule that makes an additive optional field a
compatible change (ADR-049), and here it is only what this parser does today.

## 13. Get replay

```http
GET /v1/replays/:replayId
```

A `replayId` that is not a uuid is `404` `not_found`, the same answer as an
unknown replay.

Returns the stored run, in the shape section 12 shows. `requestHeaders` holds
every header sent, by name, with `[REDACTED]` as the value of each destination
header and blocked name (`REPLAY_SPEC.md` section 8). `responsePayload` has
had every destination header value of at least 8 characters replaced
(`SECURITY.md` section 7).

## 14. Health endpoints

```http
GET /health
GET /ready
```

`/health` checks the process and nothing else. It answers `{ "status": "ok" }`,
it never touches the database, and it carries no version: a load balancer hits
it every few seconds and it stays the cheapest possible answer.

`/ready` verifies required dependencies such as PostgreSQL, and says what the
API is running:

```json
{
  "status": "ready",
  "version": "v0.1.0",
  "commit": "27f4d64e0b5a63f0d0b3e2a1c4d5e6f708192a3b",
  "source": "build"
}
```

| Field | Meaning |
| --- | --- |
| `status` | `ready`, or `not_ready` with a `reason` and a 503. |
| `version` | What this process is running. |
| `commit` | The commit the image was built from. Absent when the build recorded none. |
| `source` | `build` when the published image baked the value in at build time, so it is a fact about the artefact; `package` when nothing was baked in, which means a source run or a hand-built image, and the value is only the workspace's own version. |

The three fields are on the 503 answers too, because when something is wrong
the first question is what is running.

**Where the value comes from.** The published image bakes it in: the
`WAYSCRIBE_BUILD_VERSION` and `WAYSCRIBE_BUILD_COMMIT` build arguments, which
`apps/api/Dockerfile` and `apps/web/Dockerfile` both declare, and which the
release fills in both images with the tag it is about to create and the commit
it built. An image you build yourself needs both arguments on both builds;
`docs/OPERATIONS.md` section 1, *Building the images yourself*, has the
commands. There is no runtime shell-out to git, because
the image carries no git history, no working tree and no git binary; a
shell-out could only answer for whichever machine ran the container. A build
that passes neither argument reports `"source": "package"` and the version in
`apps/api/package.json`, which is `0.0.0`: not a release, and saying so.

The answer is unauthenticated, as both endpoints already are. It repeats what
the image tag says in the registry and is derived from no stored data.

The web app shows it under every signed-in page, beside its own version, which
it reads from the same two build arguments in `apps/web/Dockerfile`, and says
when the two name different builds: a different version, or the same version
from a different commit. It compares only two builds that both carry the
arguments. A side built without them reports its package version, `0.0.0`,
whatever commit it came from, so when exactly one side has none the line says,
in the muted style, that the page cannot tell whether the web app and the API
are the same build, and names the image that lacks them. When neither has
them, as in the source stack, both halves say "not a release build" and
nothing is compared. It asks at most once every 30 seconds, and when
`/ready` does not answer within 1.5 seconds the line says the API version is
unknown and the page renders as usual.

Metrics are not on this port. With `METRICS_PORT` set, the API serves
`GET /metrics` on that port alone (`docs/OPERATIONS.md` §13); `/metrics` on the
API port is 404.

## 15. Pagination

Use cursor pagination for events, search results and the journey list.

Do not expose database offsets as a compatibility contract.

## 16. Request limits

Ingestion's limits, with their defaults and configuration names, are in
[`INGESTION_CONTRACT.md`](INGESTION_CONTRACT.md) section 3, which a test holds
to the code. A replay waits at most 10 seconds and reads at most 256 KiB of the
response; neither is configurable. List endpoints return 25 items by default
and at most 100.

## 17. Delete a journey

```http
DELETE /v1/journeys/:journeyId
Authorization: Bearer <admin-token>
x-wayscribe-project-id: <project-id>
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
- `404 project_not_found` when `x-wayscribe-project-id` is not a UUID, names no
  project, or is omitted while more than one project exists.

A path parameter longer than 1,152 characters as encoded in the URL, nine for
each of the protocol's 128, is refused with `414` before any route runs.

## 18. Erase an identifier

```http
POST /v1/erasures
Authorization: Bearer <admin-token>
x-wayscribe-project-id: <project-id>
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
- `404 project_not_found` when `x-wayscribe-project-id` is not a UUID, names no
  project, or is omitted while more than one project exists.

## 19. Delete a replay destination

```http
DELETE /v1/replay-destinations/:destinationId
Authorization: Bearer <admin-token>
x-wayscribe-project-id: <project-id>
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
- `404 project_not_found` when `x-wayscribe-project-id` is not a UUID, names no
  project, or is omitted while more than one project exists.
