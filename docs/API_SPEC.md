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

An API key is scoped to one project and one environment and may ingest. An admin
token reads across every environment of one **named** project and may not ingest
(ADR-029).

`x-flight-project-id` selects that project. It may be omitted when the
installation has exactly one project, in which case the API resolves it; with
more than one, omitting it is a `404 project_not_found` rather than a guess. The
web interface stores the selection in its session.

`GET /v1/projects` lists them. It takes the admin token alone, because it
answers the question a caller has before it can name a project.

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

## 3. Ingest one event

```http
POST /v1/events
```

Request:

```json
{
  "protocolVersion": "0.1",
  "event": {
    "id": "evt_01",
    "journeyId": "jrn_01",
    "environment": "development",
    "service": "customer-integration",
    "entity": {
      "type": "customer",
      "id": "18492"
    },
    "operation": "received",
    "name": "receive-salesforce-webhook",
    "timestamp": "2026-08-06T18:31:02.000Z",
    "aliases": {
      "salesforceAccountId": "0018Z00002ABC"
    }
  }
}
```

Accepted response:

```json
{
  "data": {
    "eventId": "evt_01",
    "journeyId": "jrn_01",
    "status": "accepted",
    "duplicate": false
  }
}
```

Idempotent duplicate response:

```json
{
  "data": {
    "eventId": "evt_01",
    "journeyId": "jrn_01",
    "status": "accepted",
    "duplicate": true
  }
}
```

Recommended status:

```text
202 Accepted
```

Validation errors use `400`. Authentication errors use `401` or `403`.

## 4. Ingest a batch

```http
POST /v1/events/batch
```

Request:

```json
{
  "events": [
    {
      "protocolVersion": "0.1",
      "event": {}
    }
  ]
}
```

Response:

```json
{
  "data": {
    "results": [
      {
        "eventId": "evt_01",
        "status": "accepted",
        "duplicate": false
      },
      {
        "eventId": "evt_02",
        "status": "rejected",
        "error": {
          "code": "payload_too_large",
          "message": "Event payload exceeded the configured limit."
        }
      }
    ]
  }
}
```

A partially invalid batch must not reject all valid events.

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
        "lastEventAt": "2026-08-06T18:34:38.000Z"
      }
    ],
    "nextCursor": null
  }
}
```

## 6. Get journey

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
    "aliases": [],
    "services": [],
    "eventCount": 8,
    "startedAt": "2026-08-06T18:31:02.000Z",
    "completedAt": null,
    "lastEventAt": "2026-08-06T18:34:38.000Z"
  }
}
```

## 7. List journey events

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

## 8. Get event details

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

## 9. Create replay destination

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

## 10. List replay destinations

```http
GET /v1/replay-destinations
```

Secrets are never returned.

## 11. Create replay

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

## 12. Get replay

```http
GET /v1/replays/:replayId
```

Returns:

- sanitized request
- response status
- sanitized response
- timing
- result diff
- audit metadata

## 13. Health endpoints

```http
GET /health
GET /ready
```

`/health` checks the process.

`/ready` verifies required dependencies such as PostgreSQL.

## 14. Pagination

Use cursor pagination for events and search results.

Do not expose database offsets as a compatibility contract.

## 15. Request limits

Initial configurable limits should cover:

- total request body
- event payload
- batch size
- metadata depth
- string lengths
- replay response body
- replay duration

Exact defaults belong in configuration documentation once implementation measurements exist.

## 16. Delete a journey

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
  512 characters.

## 17. Erase an identifier

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

## 18. Delete a replay destination

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
