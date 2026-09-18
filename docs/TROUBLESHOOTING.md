# Troubleshooting

Most problems with a new installation look the same from the outside: the
service runs, and no journeys appear. This page is a path through that
symptom, one question at a time, and then the neighbouring problems: refusal
codes, the journey list, clock warnings, labels on older journeys, and the
secret-name warning.

The commands below assume the stack from the README's *Try it* section, with
the API on `http://localhost:8080`. If you moved it with `API_PORT`, use that
port. The outputs shown were taken from a local stack on 2026-09-16.

## No journeys appear

Work through these in order. Each step either finds the problem or rules out a
whole layer.

```text
1. Is the API up and ready?            curl /health, curl /ready
2. Is the installation sound?          doctor
3. Did the SDK reach the API?          logDiagnostics: delivered_first
4. Did the API store what it was sent? counters(), and the refusal codes
5. Are you looking in the right place? project, environment, time window
```

### 1. Is the API up and ready?

```bash
curl -s http://localhost:8080/health
curl -s -w ' %{http_code}\n' http://localhost:8080/ready
```

`/health` answers `{"status":"ok"}` whenever the process is running; it does not
touch the database. `/ready` is the one that matters:

| `/ready` answers | Means | Fix |
| --- | --- | --- |
| `{"status":"ready"}` 200 | the API can serve | go to step 2 |
| `{"status":"not_ready","reason":"migrations_pending","pendingCount":19}` 503 | the schema is older than the build | run the migrations: `pnpm db:migrate` from a checkout, or the `migrate` command in [Operations §1](OPERATIONS.md#schema-changes) |
| `{"status":"not_ready","reason":"database_unreachable"}` 503 | the API cannot reach PostgreSQL | check `DATABASE_URL`; the API's log has the driver error, which is never returned over HTTP |
| connection refused | nothing listens on that port | `docker compose ps`; check `API_PORT` |

A stack started from `infrastructure/compose.yaml` alone does not migrate, so
its first `/ready` is `migrations_pending`. That is the intended answer, not a
fault. The demo profile and the published images migrate on boot.

### 2. Run `doctor`

`doctor` checks the database, the migrations, the secrets, the keys, and the
API, and prints a fix under every line that did not pass. It changes nothing.
[Operations §12](OPERATIONS.md#12-checking-an-installation) lists every check.

From the published images, with `COMPOSE_FILE` set as in Operations §1:

```bash
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js doctor --api-url http://api:8080 --api-key wsk_…
```

From a checkout, where it reads the repository-root `.env`. Keep the `run`:
without it, pnpm runs its own built-in command of the same name, which checks
pnpm and never looks at the database.

```bash
pnpm run doctor --api-url http://localhost:8080 --api-key wsk_…
```

Pass the key your service uses. `doctor` checks it locally and never sends it
anywhere, and it tells you which environment the key belongs to:

```text
PASS  API key                 Key wsk_LVrC_lHO authenticates for docs/development. Events it sends must name environment "development".
PASS  API reachable           GET http://localhost:8080/ready answered 200.
```

A key that this database does not know fails like this, which usually means
the key was issued against another database:

```text
FAIL  API key                 No key with prefix wsk_notAReal exists in this database.
                              Fix: Check that DATABASE_URL is the database the key was issued in (key:list shows every prefix), or issue a new key.
```

The exit code is 1 when anything failed. Two `FAIL` lines are expected on a
local stack that still uses the published development secrets
(`ENCRYPTION_KEY` and `ADMIN_TOKEN`); they do not stop ingestion, but fix them
before the stack holds anything real.

**The key names the environment.** If `doctor` says `Events it sends must name
environment "development"` and your service is configured with
`environment: "production"`, that is the problem; see
[Key and environment mismatches](#key-and-environment-mismatches).

### 3. Did the SDK reach the API?

Turn on `logDiagnostics` while you set up:

```typescript
const recorder = createRecorder({
  // ...
  logDiagnostics: true
});
```

When the server stores the first batch, the SDK prints one line:

```text
[wayscribe] delivered_first: Connected to http://localhost:8080; the server accepted 3 events.
```

If that line never appears, the lines that do appear say why. These were all
produced against a local stack with `logDiagnostics: true`. With it off, the
`configuration_error` lines still print, and end with a note in parentheses
saying why they were printed unasked:

| First line you see | Cause | Fix |
| --- | --- | --- |
| `rejected: Ingestion responded 401.` | the API key is wrong, revoked, or is the admin token | see [401](#401-unauthorized) |
| `rejected: unauthorized_environment (the server's message goes to onDiagnostic)` | `environment` is not the key's environment | see [403](#403-unauthorized_environment) |
| `transport_error: fetch failed`, then `dropped: The recorder shut down before this event was delivered.` | nothing answered at `endpoint`: wrong host or port, or the API is down | check `endpoint` against step 1; inside Compose the API is `http://api:8080`, from the host it is `http://localhost:8080` |
| `configuration_error: apiKey is not a string, so the server refuses every request, and the events are counted as rejected.` | `apiKey` was `undefined`, usually an unset environment variable | set the variable; this line prints even with `logDiagnostics` off |
| `configuration_error: apiKey is empty, so the server refuses every request, and the events are counted as rejected.` | `apiKey` was `""` or blank, usually `process.env.WAYSCRIBE_API_KEY ?? ""` with the variable unset | set the variable; this line prints even with `logDiagnostics` off |
| `insecure_endpoint: The endpoint is http: to ingest.internal, ...` | a warning, not a failure: the key travels unencrypted | put TLS in front of the API |
| nothing at all | the process exited before the first send, or no event was recorded | call `await recorder.shutdown()` before exit, then read the counters (step 4) |

**An empty setting counts as missing.** `apiKey: process.env.WAYSCRIBE_API_KEY ?? ""`
compiles, and when the variable is unset the SDK gets `""`. An empty or blank
`endpoint`, `apiKey`, `serviceName` or `environment` is reported like a missing
one: the `configuration_error` line above, printed once per process, and then
`rejected: Ingestion responded 401.` for the events.

A refusal's console line carries the server's code and never its message. The
message reaches `onDiagnostic`:

```typescript
onDiagnostic: (d) => {
  if (d.kind === "rejected") console.error(d.reason, d.detail.serverError);
}
```

For a 403 that prints
`unauthorized_environment: This key is not authorized for environment production.`
and the server's error object.

Each kind prints at most one line a minute, and the next line of that kind says
how many were suppressed (`rejected: 2 repeats suppressed since the last line`).

### 4. Read the counters

`recorder.counters()` returns the counts at any time, and `shutdown()` returns
them at the end. Once `shutdown()` has returned,
`sent + rejected + dropped === recorded`.

```text
{"recorded":3,"sent":0,"dropped":0,"rejected":3,"transportErrors":0,"captureErrors":1,
 "breakerOpened":0,"payloadsOmitted":0,"payloadsTruncated":0,"keysDropped":1,
 "configurationErrors":2,"unredactedSecretNames":1}
```

| Pattern | Means |
| --- | --- |
| `recorded` is 0 | no instrumented code ran; the recorder you are reading is not the one the code uses, or the code path was not reached |
| `sent` equals `recorded` | everything was stored; the problem is where you are looking (step 5) |
| `rejected` > 0 | the server refused events and will not take them again; the `rejected` diagnostics carry the code (see [Refusal codes](#refusal-codes)) |
| `dropped` > 0, `transportErrors` > 0 | the API could not be reached or could not store events for now, and they were given up |
| `dropped` > 0, `transportErrors` 0 | the queue filled (`queue_full`), or events were recorded after `shutdown()` (`after_shutdown`) |
| `breakerOpened` > 0 | five sends failed in a row, and sending paused for 30 seconds |
| `configurationErrors` > 0 | a setting or argument could not be used; the `configuration_error` diagnostics name it |

A test can assert the counters, so a missing setting fails before it ships:

```typescript
expect(recorder.counters().configurationErrors).toBe(0);
```

### 5. Are you looking in the right place?

- **The project.** An admin token reads one project at a time. With more than
  one project, the interface asks you to choose one at `/projects`, and every
  search is inside that choice.
- **The environment.** A journey belongs to the environment of the key that
  recorded its first event. An API key reads its own environment only; naming
  another returns an empty page, not an error.
- **The time window.** The Journeys page shows the last 24 hours by default,
  and the list API has no default at all (see
  [The journey list needs `since`](#the-journey-list-needs-since)).
- **The identifier.** Search matches the entity id, an alias, or a journey,
  trace, span, message or correlation id by exact value. The Journeys page's
  text filter matches part of a label or of an alias marked displayable, and
  nothing else: typing part of an entity id there finds nothing, by design
  ([Security §6](SECURITY.md#what-the-journey-lists-text-filter-can-match)).

## Diagnostics by code

Every diagnostic is `{ kind, code, reason, detail }`. Match on `kind` and
`code`; `reason` is a sentence whose wording may change in any release. New
codes may arrive in a minor release, so keep a `default` branch. The source of
this table is `packages/sdk-node/src/diagnostics.ts`.

| Kind | Code | Means | Fix |
| --- | --- | --- | --- |
| `delivered_first` | `first_delivery` | the server stored events from this recorder for the first time | nothing; this is the good news, and you can turn `logDiagnostics` off |
| `insecure_endpoint` | `unencrypted_endpoint` | `endpoint` is `http:` to a dotted name or an IP address off this machine | use `https:`, or terminate TLS on the same machine as the service |
| `rejected` | `event_refused` | the server refused one event; `detail.serverError` has its code | find the code under [Refusal codes](#refusal-codes) |
| `rejected` | `request_refused` | the server refused a whole request with a 4xx, reported once per event in it | a 401 is the key (see [401](#401-unauthorized)); read `detail.httpStatus` |
| `transport_error` | `request_failed` | a request failed: connection refused, timeout, or a 5xx for the whole request | check the endpoint and the API; the batch is retried while the outage lasts, within the queue's bound |
| `transport_error` | `refused_for_now` | the server answered `storage_error` or `query_timeout` for some events | check the database's load; those events are retried for up to 30 seconds or 10 sends |
| `transport_error` | `unexpected_error` | the SDK's own send path threw | report it, with `detail.error`; recording carries on |
| `payload_omitted` | `too_large` | a payload did not fit `maxEventBytes` and was replaced with `[PAYLOAD_TOO_LARGE]` | record a smaller view with `captureInput` or `captureOutput`; if you raised the server's `MAX_EVENT_PAYLOAD_BYTES`, raise `maxEventBytes` to match |
| `payload_omitted` | `too_deep` | nested more than 30 levels | record a projection of the value |
| `payload_omitted` | `too_wide` | an object or array with more than 1,000 entries | record a count or a sample instead |
| `payload_omitted` | `unserialisable` | reading the value threw, as a getter or a `toJSON` can | record a plain copy of the fields you need |
| `payload_omitted` | `projection_failed` | a `captureInput` or `captureOutput` threw or returned a promise | make the projection synchronous and total |
| `payload_truncated` | `strings_cut` | a string over 65,536 characters was cut; the event was sent | usually nothing; record less if the cut hides what you need |
| `payload_truncated` | `label_cut` | a label over 200 code points was cut to 199 and `…` | shorten the label |
| `key_dropped` | `aliases_not_object` | `aliases` was not an object | pass `{ type: value }` |
| `key_dropped` | `alias_invalid` | an alias type over 128 characters, or a value that is not a string of at most 512 | convert ids to strings; shorten the type |
| `key_dropped` | `displayable_alias_invalid` | an entry of `displayableAliases` could not be used | pass alias type names as strings |
| `key_dropped` | `metadata_key_too_long` | a top-level metadata key over 128 characters was left off | shorten the key |
| `key_dropped` | `label_invalid` | `label()` was given something that is not a non-empty string; the earlier label stays | pass visible text |
| `dropped` | `queue_full` | the queue passed `maxBufferedEvents` (1,000 by default) and shed its oldest event | the API is unreachable or slower than you record; see the `transport_error` lines |
| `dropped` | `after_shutdown` | an event was recorded after `shutdown()`; `detail` names it | shut down after the last recording, not before |
| `dropped` | `shutdown` | still undelivered when `shutdown()` finished; the server may have stored it | give `shutdown({ timeoutMs })` longer, or find why sends are slow |
| `dropped` | `retry_budget` | the server refused an event for now for 30 seconds or 10 sends | check the database; `doctor`'s statement timeout line |
| `dropped` | `no_verdict` | a 2xx reply gave no result for an event, so it was not sent again | a proxy between the SDK and the API is rewriting responses |
| `capture_error` | `unexpected_error` | something threw inside the SDK; your call was unaffected | report it, with `detail.error` |
| `capture_error` | `not_a_journey` | `across` was given something that is neither a journey nor a context | pass journeys or `journey.context()` |
| `capture_error` | `invalid_options` | a call's options were not an object, or held keys it does not read; `detail.call` names the call | check the call's options; `fail(name, error, { metadata })` takes metadata under `metadata` |
| `capture_error` | `context_missing` | an inject helper got no context; nothing was added | pass `journey.context()` as the last argument |
| `configuration_error` | `setting_unusable` | an optional setting had the wrong type or range; the default was used | fix the value; nothing is converted, so `"5000"` from `process.env` is not a number |
| `configuration_error` | `required_setting_unusable` | `endpoint`, `apiKey`, `serviceName` or `environment` is missing, empty, blank, or not a string | set it; nothing is stored until you do, and this prints even with `logDiagnostics` off |
| `configuration_error` | `setting_renamed` | a setting under its old name (`maxPayloadBytes`, `propagate`), which is not read | use the new name the line gives |
| `configuration_error` | `journey_id_secret_missing` | `journeyIdFor` was called without a `journeyIdSecret`; it returned a random id | set a secret of at least 32 bytes; until then each run starts a new journey |
| `configuration_error` | `journey_id_secret_unusable` | the secret is shorter than 32 bytes, or is not a string | use a longer secret |
| `configuration_error` | `entity_invalid` | an entity was missing, or its type or id was not a non-empty string; events are filed under `unknown`/`unknown` | pass `{ type, id }` with string values |
| `configuration_error` | `journey_id_invalid` | `continueJourney` got a context or `journeyId` without a usable id, as when a journey handle is passed instead of `journey.context()` | pass what an extract helper returned, or `journey.context()` |
| `breaker_opened` | `consecutive_failures` | five sends failed in a row, and sending paused for 30 seconds | see the `transport_error` lines before it |
| `unredacted_secret_name` | `secret_like_name` | a field whose name looks like a secret was sent in plain text | see [The secret-name warning](#the-secret-name-warning) |
| `personal_data_in_public_value` | `personal_data_shape` | a journey label, or an alias marked displayable, holds what looks like an email address or a telephone number; the value was sent unchanged | take the personal data out of the label or the alias, or stop marking the alias displayable; once per process and shape |

## Key and environment mismatches

### 401 `unauthorized`

```json
{"error":{"code":"unauthorized","message":"A valid API key is required.","requestId":"req-j"}}
```

The API answers this to a missing key, an unknown key, a revoked key, and the
admin token, which may not ingest. The response is the same for all of them, so
check each:

- `pnpm key:list` (or `key:list` in the image) shows every key by prefix, its
  project and environment, when it was last used, and `[REVOKED]` after a
  revoked one. The prefix is the first twelve characters of the key:

  ```text
  PREFIX        PROJECT/ENVIRONMENT            NAME                 LAST USED
  wsk_LVrC_lHO  docs/development               docs-check           2026-09-17 00:01:50
  wsk_KxaI9KTD  docs/staging                   docs-staging         2026-09-16 23:58:09  [REVOKED]
  ```
- `doctor --api-key wsk_…` says whether this database knows the key and which
  environment it belongs to.
- The admin token reads; it never ingests. Issue an API key with `key:create`.
- A key moves to a new `ENCRYPTION_KEY` the next time it authenticates. One that
  had not authenticated before `ENCRYPTION_KEY_PREVIOUS` was removed no longer
  verifies; `rotate:status` lists it ([Operations §6](OPERATIONS.md#6-key-rotation)).

### 403 `unauthorized_environment`

The key belongs to one environment, and every event names one. They must be the
same. `POST /v1/events/batch`, which the SDK uses, answers the request with 202
and refuses the event inside it:

```json
{"data":{"results":[{"eventId":null,"status":"rejected","error":{"code":"unauthorized_environment","message":"This key is not authorized for environment production.","httpStatus":403}}]}}
```

`POST /v1/events` answers the same refusal as a 403 for the whole request. Fix
the service's `environment`, or issue a key for the environment it names:

```bash
pnpm key:create <project> production <key-name>
```

A service that writes to two environments needs two keys and two recorders.

### 409 `journey_environment_mismatch`

```json
{"data":{"results":[{"eventId":null,"status":"rejected","error":{"code":"journey_environment_mismatch","message":"This journey id is already in use by another environment of this project, and a journey cannot span environments. Use a journey id unique to this environment.","httpStatus":409}}]}}
```

A journey belongs to the environment whose key recorded its first event, and an
event for it from another environment is refused, with nothing stored. It
happens when a journey id crosses environments:

- a staging worker consuming a message a production service published, with the
  journey in its headers or attributes; keep queues per environment
- a journey id written by hand, or reused from a fixture, in two environments;
  let the SDK choose ids, or use `journeyIdFor`, whose ids already differ by
  environment

## Refusal codes

The normative list is [the ingestion contract](INGESTION_CONTRACT.md#4-per-event-refusals-and-which-to-retry).
A status below 500 is permanent: the SDK counts the event as `rejected` and does
not send it again. The SDK fits every event to the limits before sending it, so
the size and structure codes below mostly come from other clients.

| Code | Status | Fix |
| --- | --- | --- |
| `invalid_event` | 400 | `details[].path` names the field; compare the event with the [JSON Schema](../packages/protocol/schemas/0.1) |
| `unsupported_protocol_version` | 400 | send `"protocolVersion": "0.1"` |
| `payload_too_large` | 400 | the envelope exceeded `MAX_EVENT_PAYLOAD_BYTES` (262,144 bytes by default), or the batch held more than 100 events; send less, or raise the server limit and the SDK's `maxEventBytes` together |
| `max_depth_exceeded` | 400 | nest no more than 32 levels, envelope included |
| `max_keys_exceeded` | 400 | no more than 1,000 keys or elements in one object or array |
| `max_string_length_exceeded` | 400 | no string over 65,536 UTF-16 code units |
| `unstorable_payload` | 400 | remove NUL bytes and unpaired surrogates; the SDK repairs both |
| `invalid_query` | 400 | a query parameter the route does not take; `POST /v1/events/batch?dryrun=true` answers `dryrun is not a query parameter this route accepts. Did you mean dryRun?` |
| `unauthorized_environment` | 403 | see [403](#403-unauthorized_environment) |
| `event_id_conflict` | 409 | the event id is stored with different content; generate a new id per event, and resend an event only unchanged |
| `journey_environment_mismatch` | 409 | see [409](#409-journey_environment_mismatch) |
| `storage_error` | 500 | transient; the SDK retries the event. If it persists, check the API's log and the database |
| `query_timeout` | 503 | transient; a statement ran past `DATABASE_STATEMENT_TIMEOUT_MS`. Check the database's load before raising the timeout ([Operations §13](OPERATIONS.md#statement-timeout)) |

Before the route runs, a whole request can be refused:

| Status | Code | Fix |
| --- | --- | --- |
| 413 | `payload_too_large` | the body passed the server's body limit; send smaller batches |
| 415 | `unsupported_media_type` | send `Content-Type: application/json` |
| 400 | `malformed_json` | the body was empty or not JSON |
| 431 | none; Node's own body | headers too large; send fewer or smaller headers |

`Content-Type: text/plain` is parsed rather than refused, so it arrives as a
string and is answered `400 invalid_event` (`Body must contain an events array.`).
Send `application/json`.

## The journey list needs `since`

`GET /v1/journeys` has no default window, so a request without `since` is
refused:

```json
{"error":{"code":"invalid_query","message":"since is required: the earliest last activity to list, as an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z.","requestId":"req-r"}}
```

Send a full instant with a time zone. For the last 24 hours, compute it once:

```bash
SINCE=$(node -e 'console.log(new Date(Date.now() - 864e5).toISOString())')
curl -s "http://localhost:8080/v1/journeys?since=$SINCE" \
  -H "authorization: Bearer $WAYSCRIBE_API_KEY"
```

The other refusals of `since`:

| Sent | Answer |
| --- | --- |
| `since=2026-09-01T00:00:00` (no zone) | `since must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z.` |
| a `since` more than 60 seconds ahead of the API's clock | `since must not be in the future.` |

Keep the same `since` for every page. A cursor continues the list it came from,
and recomputing "24 hours ago" per page moves the window under it
([API specification §6](API_SPEC.md#6-list-journeys)).

## A clock warning on the timeline

A step marked **⚠ clock** was received by the API more than 120 seconds after the
time the service recorded for it. Hovering it shows both times. The timeline
orders steps by the service's time, so a service whose clock is behind can put
its steps before the steps that caused them.

The marker has three usual causes:

- **The service's clock is behind.** Check NTP on that host or container. Fix
  the clock; nothing needs to change in Wayscribe.
- **The event waited to be sent.** The SDK keeps events while the API is
  unreachable, within its queue of `maxBufferedEvents`, and retries a refused
  event for up to 30 seconds. A step recorded during an outage is received late,
  and marked, although its time is right.
- **The step ran for a long time.** A wrapped step is timestamped when it
  started, so a `deliver` that took three minutes is received more than two
  minutes after its timestamp.

A service clock that runs *ahead* is not marked: its steps are received before
the time they carry, and the marker only looks the other way.

## Labels or last step missing on older journeys

The journey browsing release added a label and a last step to each journey, with
no backfill ([Operations §4](OPERATIONS.md#upgrading-to-the-journey-browsing-release-migrations-018-and-019)).
A journey recorded before the upgrade shows no last step until its next event,
and no label until an event carrying a label arrives. Until then the Journeys
page shows it by entity type and identifier. The list API returns both as
`null`.

On a new journey, a missing label has its own causes:

- `label()` records nothing by itself. Only events recorded after it carry the
  label, so a journey whose last event came before the call has none.
- A second handle for the same journey, from `continueJourney`, carries no label
  until you set one; pass `label` to `continueJourney`.
- A label that is empty or only whitespace is not set, and reported as
  `key_dropped` with code `label_invalid`.
- `recorder.across` given journey contexts, rather than journeys, records
  without labels.

## The secret-name warning

This line prints once per name per process, whether or not `logDiagnostics` is
on. This is the form printed with `logDiagnostics: true`; with it off, the line
ends with a note in parentheses saying why it was printed:

```text
[wayscribe] unredacted_secret_name: A field named "sessionCredential" (at input.sessionCredential) looks like a secret and was sent unredacted. If it holds a secret, add "**.sessionCredential" to the redact option; if it does not, add "sessionCredential" to knownSafeNames.
```

Redaction goes by name, and no rule covers this one, so its value was stored in
plain text. The SDK never redacts on a guess.

- **If it holds a secret**, add a rule, and rotate the secret:

  ```typescript
  createRecorder({
    // ...
    redact: ["**.sessionCredential"]
  });
  ```

  Values already stored stay until they are deleted or expire. Find the
  journeys and delete them ([Operations §8](OPERATIONS.md#8-deleting-data)).
- **If it does not**, say so, and the warning stops:

  ```typescript
  createRecorder({
    // ...
    knownSafeNames: ["sessionCredential"]
  });
  ```

`doctor` runs the same check over recently stored events from every sender, and
warns without failing:

```text
WARN  Secret-looking names    1 key name that looks like a secret holds plain values in the 4 most recent events sampled: sessionCredential (in 1).
```

`knownSafeNames` does not silence `doctor`, which has no such list.
[Operations §12](OPERATIONS.md#secret-looking-names-stored-in-plain-text) has
a query that looks further back than its sample.

## See also

- [Operations §14, When something is wrong](OPERATIONS.md#14-when-something-is-wrong), for the server side
- [The Node SDK's README](../packages/sdk-node/README.md#is-it-sending), for every diagnostic's `detail`
- [FAQ](FAQ.md)
