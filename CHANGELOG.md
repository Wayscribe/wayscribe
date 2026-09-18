# Changelog

Notable changes to Wayscribe, which was called Flight Recorder until
2026-09-17. Dates are the day the work merged.

Versions follow [semantic versioning](https://semver.org). Before 1.0 the minor
version may carry breaking changes; the patch version will not.

The published artifacts are versioned together: the `api` and `web` images and
the `@wayscribe/node` package share a version, because the event protocol
is the contract between them and a mismatch is not something a user should have
to reason about. The protocol itself carries its own `protocolVersion`, which
changes far less often.

## [Unreleased]

This section describes the first release, a 0.x preview. Nothing has been
published before it, so there is no earlier release to upgrade from. Under
**Changed** and **Upgrade notes**, "changed" means changed from earlier
development builds of `main`, for anyone running one from a git checkout. A
shorter overview is in
[docs/RELEASE_NOTES_DRAFT.md](docs/RELEASE_NOTES_DRAFT.md).

### Renamed to Wayscribe (2026-09-17)

The product was called Flight Recorder until this change (ADR-057). The entries
below this one were written before it and use the old names; this table gives
the new one for each. There are no aliases: the old names are not read.

| What | Before | Now |
| --- | --- | --- |
| Product | Flight Recorder | Wayscribe |
| Packages | `@flight-recorder/*`, SDK `@flight-recorder/node` | `@wayscribe/*`, SDK `@wayscribe/node` |
| CLI binary | `flight-recorder` | `wayscribe` |
| HTTP headers | `x-flight-journey-id`, `x-flight-entity-type`, `x-flight-entity-id`, `x-flight-replay`, `x-flight-project-id`, `x-flight-api-key` | `x-wayscribe-journey-id`, `x-wayscribe-entity-type`, `x-wayscribe-entity-id`, `x-wayscribe-replay`, `x-wayscribe-project-id`, `x-wayscribe-api-key` |
| Queue message attributes | `flightJourneyId`, `flightEntityType`, `flightEntityId` | `wayscribeJourneyId`, `wayscribeEntityType`, `wayscribeEntityId` |
| Payload envelope key | `_flight` | `_wayscribe` |
| Environment variables | `FLIGHT_RECORDER_API_KEY`, `_URL`, `_TOKEN`, `_PROJECT`, `_ENVIRONMENT`, `_VERSION`, `_WEB` | `WAYSCRIBE_API_KEY`, `_URL`, `_TOKEN`, `_PROJECT`, `_ENVIRONMENT`, `_VERSION`, `_WEB` |
| Demo, acceptance and browser suite variables | `FLIGHT_API_KEY`, `FLIGHT_API_URL`, `FLIGHT_ENDPOINT`, `FLIGHT_ENVIRONMENT` | `WAYSCRIBE_API_KEY`, `WAYSCRIBE_API_URL`, `WAYSCRIBE_ENDPOINT`, `WAYSCRIBE_ENVIRONMENT` |
| Prometheus metrics (nine families) | `flight_recorder_*` | `wayscribe_*` |
| Alert rules | `FlightRecorderRetentionStalled`, `FlightRecorderRejectingEvents`, `FlightRecorderDatabaseStrained` | `WayscribeRetentionStalled`, `WayscribeRejectingEvents`, `WayscribeDatabaseStrained` |
| SDK print prefix | `[flight-recorder]` | `[wayscribe]` |
| Web session cookie | `flight_session` | `wayscribe_session` |
| New API keys | `fr_` and 32 characters | `wsk_` and 32 characters |
| Published demo key | `fr_demo...` | `wsk_demo...` |
| Images | `registry.gitlab.com/jojithedev/flight-recorder/{api,web}`, demo `flight-recorder-demo:local` | `registry.gitlab.com/jojithedev/wayscribe/{api,web}`, demo `wayscribe-demo:local` |
| Helm chart | `deploy/helm/flight-recorder`, example release `fr` | `deploy/helm/wayscribe`, example release `ws` |
| Compose project and network | `flight-recorder`, `flight-recorder_default` | `wayscribe`, `wayscribe_default` |
| Local database user, password and name | `flight` | `wayscribe` |
| GitLab project (moved 2026-09-17) | `jojithedev/flight-recorder` | `jojithedev/wayscribe` |

What keeps working:

- **Stored data.** The key-derivation labels did not change, so encrypted
  identifiers and search tokens from before the rename still work, and no
  migration was added.
- **API keys that start `fr_`.** The server never checked the prefix. Masking
  in error text and `doctor` accept both forms, and `doctor` still warns while
  the old published demo key is active.

What you have to do when upgrading a checkout or a deployment:

- **Rename what your services set:** the SDK dependency and imports, the
  environment variables, and any header or queue attribute a service other
  than the SDK reads or writes.
- **Update dashboards and alert rules** to the `wayscribe_*` metrics and the
  new alert names.
- **Sign in to the interface once more.** The session cookie is now
  `wayscribe_session`. A session is still signed with the same key, but the
  browser holds it under the old name, which is no longer read, so everyone
  signed in is asked to sign in again, once.
- **Pull images from the new path.** The old registry path does not redirect.
- **Start a local Compose stack afresh.** The project, volume and database
  user changed, so an old stack's database is not picked up
  ([LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md#upgrading-a-checkout-from-before-the-rename)).
  Copy `.env.example` to `.env` again, or change the user and name in
  `DATABASE_URL`.

### Added

#### Recording and the Node SDK

- **`@flight-recorder/node`**, the Node SDK, for Node 22.12 or later. No runtime
  dependencies; ESM, with one bundled file and one declaration file. A Stability
  section in the SDK README lists what is experimental.
- **Wrappers that record without changing what they wrap.** `transform`,
  `persist`, `publish` and `deliver` return the callback's value unchanged and
  rethrow its exact error. A synchronous callback returns and throws
  synchronously, and the types carry overloads that say so. `WrapOptions` is
  generic in the callback's result, so `captureOutput` and `isFailure` see the
  resolved value with its type. `operation` is a typed union, exported as
  `Operation`.
- **Projections.** `captureInput` and `captureOutput` choose what is recorded
  while the wrapper still returns the callback's own value, so a step that
  returns a PDF can record `{ bytes: buffer.length }`. `captureInput` records
  the input as it was when the projection ran. A projection that throws or
  returns a promise records `[UNCAPTURABLE]` and a `payload_omitted` diagnostic
  with code `projection_failed`.
- **The SDK cannot break the application it records.** Every entry point is
  inside the failure boundary, including the propagation helpers, and none
  throws over what it is given: missing options, throwing getters, Proxies or
  malformed values degrade to a new journey, a first attempt, or the setting's
  default, with a `capture_error` or `configuration_error`. A wrapper reads each
  option once. A callback returning any thenable gets a native promise back.
- **Every setting is checked at creation (SDK-60).** A timer, queue bound or
  byte budget that is not a whole number in range, a clamped `batchSize` or
  `maxConcurrentSends`, an unknown `captureMode` or `propagation`, a non-boolean
  `logDiagnostics`, and a `redact` that is not a list of strings are each
  reported as `configuration_error` and replaced by the default or clamped. A
  missing or non-string `endpoint`, `apiKey`, `serviceName` or `environment`
  prints one line per process even with `logDiagnostics` off, naming the
  setting and never its value. Every option type is named and exported, and
  every optional input accepts an explicit `undefined`.
- **Payloads are copied faithfully and safely.** A `Date` and anything with a
  `toJSON` serialise themselves; `Map`, `Set`, `Error`, `RegExp`, `Headers` and
  `URLSearchParams` keep their contents and are rendered inside the redaction
  walk (ADR-036); a cycle becomes `[CIRCULAR]`, a shared reference is not
  mistaken for one, and a `BigInt` becomes its decimal string (ADR-034). A
  `__proto__` key is kept as an ordinary key. NUL bytes and lone surrogates are
  repaired before an event leaves the process. A value that cannot be
  serialised reports `payload_omitted` with code `unserialisable`.
- **Every event is fitted to the server's limits before it is sent**
  (ADR-051), by the same check ingestion runs, `eventLimits` from
  `payload-security`. A string over 65,536 characters is cut to its start and
  `[TRUNCATED: <n> characters removed]`; a payload that still does not fit, or
  is too deep or too wide, becomes `[PAYLOAD_TOO_LARGE]`, the larger of `input`
  and `output` first and `metadata` last; and the event is always sent.
  `maxEventBytes` is the budget of one whole event and should match the server's
  `MAX_EVENT_PAYLOAD_BYTES`. A metadata key, alias or error field the server
  would refuse is left off or cut and reported as `key_dropped`, and the event
  is sent. `payload_truncated` and `payload_omitted` report cut and replaced
  payloads, naming the `field`.
- **Delivery that reports what the server stored.** The SDK reads the batch
  route's per-event verdicts. A refusal below 500 is permanent and counted as
  `rejected` with the server's error in `detail.serverError`; a poisoned event
  is refused alone rather than failing its batch. A per-event refusal of 500 or
  above (`storage_error`, `query_timeout`) is retried with backoff for up to 30
  seconds from its first refusal or 10 sends, then counted as `dropped`. A
  whole request that fails is retried behind a circuit breaker for as long as
  the outage lasts, bounded by `maxBufferedEvents`, whose overflow drops the
  oldest events. A 2xx without a usable verdict counts the events it does not
  cover as `dropped` with code `no_verdict` and does not resend them.
- **Bounded sending and shutdown.** `maxConcurrentSends`, default 4 and clamped
  to 1-16, caps concurrent batches, including those a public `flush()` starts.
  `flush()` and `shutdown()` are awaited; `shutdown()` races the final drain
  against its timeout, aborts a batch still in flight when the timeout wins,
  counts everything it could not deliver as `dropped`, and does not hold the
  process open once the drain finishes. The SDK README's "Sizing
  `maxConcurrentSends`" says when to raise it.
- **Counters add up.** `counters()` returns `recorded`, `sent`, `rejected`,
  `dropped` and the per-kind counts, and
  `sent + rejected + dropped === recorded` after `shutdown()`.
- **Diagnostics, when asked.** Each diagnostic has a `kind`, a stable `code` to
  match on, a `reason` for people, and a `detail`. `logDiagnostics: true` writes
  each to `console.error` as one `[flight-recorder]` line, at most one per kind
  per minute with a count of suppressed repeats, carrying a masked, bounded
  reason and never a payload or a key. `delivered_first` reports the first batch
  the server stored anything from, naming the endpoint's scheme, host and port
  only. `insecure_endpoint` reports an `http:` endpoint on a dotted name or an IP
  address once, at creation; `localhost`, loopback addresses, `.localhost`
  names and single-label names are not reported. Off by default: nothing
  reaches the console unless it is set, apart from the one-line warnings
  described in this section.
- **Journeys that can be found by more than their id.**
  `journey.identify(aliases, { displayableAliases })` adds identifiers the
  record answers to; aliases listed as displayable are shown in full (ADR-053).
  `journey.label(text)`, or `label` in `startJourney`, sets a public label the
  Journeys page shows and matches by partial text; a label over 200 code points
  is cut and reported, and an empty or non-string one is not set and is
  reported as `key_dropped` (SDK-58, SDK-59).
- **A stable journey id per record.** `recorder.journeyIdFor(entity)` derives
  the id under a `journeyIdSecret` of at least 32 bytes (ADR-052, SDK-55), so
  the same record lands in the same journey on every run and machine while the
  id cannot be guessed from the entity. It never throws: without a usable
  secret it reports a `configuration_error` and prints one warning line per
  process, and for an entity it cannot encode faithfully it reports why; either
  way it returns a random id. Test vectors are in
  `packages/protocol/fixtures/journey-id-derivation.json`.
- **One operation on many journeys.** `recorder.across(journeys)` gives a group
  with `record`, the four wrappers, `fail` and `finish`: each journey gets its
  own event, and the callback runs once.
- **Cross-process propagation** over HTTP headers (`injectHttpHeaders`,
  `extractHttpContext`, which also reads a fetch `Headers`), SQS message
  attributes (`injectSqsAttributes`, `extractSqsContext`) and a payload
  envelope (`injectPayload`, `extractPayload`), with three levels. The entity
  id does not propagate by default, and aliases never do.
  `recorder.continueJourney({ journeyId, entity })` resumes a journey from a
  context; an invalid journey id or entity is reported (`journey_id_invalid`,
  `entity_invalid`) and not used.
- **OpenTelemetry interoperability.** If OpenTelemetry is installed, the SDK
  reads the active trace and span ids onto each event. It does not write
  `traceparent`.
- **What the SDK costs is measured.** The package's `bench` script reports added latency per wrapped call, heap and event-loop delay under
  sustained load, and throughput by send concurrency, and `bench:fleet` models
  many processes against one API instance. `bench -- --awake` repeats the
  latency run with a core kept awake, and `bench/capture-cpu.mjs` reports the
  processor time per call without pacing. The SDK README's "What it costs" has
  the numbers and the machine they came from. `src/capture-walks.test.ts`
  counts how often capture checks, redacts and stores a payload, and
  `src/overhead.test.ts` trips on a gross slowdown of a wrapped call.

#### The server and the contract

- **Ingestion.** `POST /v1/events` and `POST /v1/events/batch`, authenticated by
  an API key scoped to one project and environment, with server-side redaction,
  structural payload diffs computed at ingestion (ADR-024), and idempotent
  duplicate handling; a conflicting duplicate is `409 event_id_conflict`
  (ADR-021). An event whose journey belongs to another environment is refused
  (see Security). A value PostgreSQL cannot store is `400 unstorable_payload`,
  and a `__proto__` key anywhere in a body is stored as an ordinary key.
- **Dry-run validation** (ADR-050). `POST /v1/events/batch?dryRun=true` runs the
  whole batch and rolls it back, answering `200` with `data.dryRun: true`, the
  per-event results a real send would give, and, for an accepted event, the
  event and journey as the read routes would return them. Nothing is written.
  The parameter is strictly `true` or `false`, given once, and
  `POST /v1/events` refuses it, so a client on the wrong route cannot store events
  while believing it validated them.
- **Journey labels and last steps** (ADR-054). Events carry an optional
  `journeyLabel`, 1 to 200 code points. A journey keeps the label, and the
  `name` of its last step, from the event with the latest `timestamp`, whatever
  order events arrive in, with ties broken as the timeline breaks them. The
  label is not redacted.
- **Displayable aliases** (ADR-053). Every alias is masked when read, except
  one whose type every event that stated it listed in `displayableAliases`; a
  later statement can mask it and nothing can unmask it. A displayable alias
  value also has a plain-text copy for matching, which the database refuses to
  keep for a masked alias (`entity_aliases_display_value_only_when_displayable`)
  and clears whatever writes the row (`entity_aliases_clear_masked_display_value`).
- **Errors in this API's own vocabulary.** Refusals before a route runs are
  `413 payload_too_large`, `415 unsupported_media_type` and
  `400 malformed_json`. No response carries a PostgreSQL SQLSTATE: a malformed
  id in a path is 404, a malformed body field or query value 400, and any other
  unexpected failure `500 internal_error`. `durationMs` above 2147483647 is
  refused as `invalid_event`.
- **A statement timeout.** `DATABASE_STATEMENT_TIMEOUT_MS`, 15000 by default,
  cancels any statement the API runs past it and answers
  `503 query_timeout`; the log names the route and never the query. `0`
  disables it. Deletions lift it for their own bounded transactions.
- **[`docs/INGESTION_CONTRACT.md`](docs/INGESTION_CONTRACT.md)**, normative for
  the two ingestion routes and written for somebody building a client that is
  not this repository's Node SDK: routes and authentication, limits with their
  configuration names and defaults, every refusal with its status and whether to
  retry it, idempotency and the keyed content hash, the dry run, and the
  conformance case format. Its tables are asserted against the code (ADR-049).
- **[`docs/SDK_SPEC.md`](docs/SDK_SPEC.md)**, what a recorder in any language
  must do: sixty-two numbered requirements in RFC 2119 wording, each with a
  source, and each with either the conformance case that checks it or a place in
  section 14, which lists what no fixture can express.
  `docs/NODE_SDK_SPEC.md` is the Node appendix.
- **Conformance fixtures**, under
  [`packages/protocol/conformance/`](packages/protocol/conformance): forty-four
  `wire` cases and thirty-seven `sdk` cases that any implementation can run
  through the dry run, loaded in order of id. Cases can expect diagnostics
  (`expect.diagnostics`) and text no diagnostic may contain
  (`expect.absentFromDiagnostics`). A fixture change is a contract change
  (ADR-049).
- **Generated JSON Schema for the wire shapes**, under
  `packages/protocol/schemas/0.1/`, exported as `./schemas/*`: nine files in
  draft 2020-12, generated from the Zod schemas and checked byte for byte by a
  unit test. `MAX_JOURNEY_LABEL_LENGTH` is also exported from the import-free
  subpath `@flight-recorder/protocol/limits`, so the SDK bundle does not carry
  Zod.

#### Finding a record

- **Search.** Find a record by any identifier it is known by, then read its
  timeline across services. Alias search is independent of alias type (ADR-028).
  Each kind of identifier is one index lookup, so a value matching a few
  journeys takes about 0.1 ms at a million journeys (`docs/OPERATIONS.md`
  section 10).
- **Event metadata on screen.** The event detail lists the step's custom,
  deployment and runtime metadata, `metadata`, `deployment` and `runtime` on the
  event the SDK sent, as plain keys and values, one group per kind. Before this
  the API returned all three and the web app showed none of them, so an HTTP
  status moved from a step's output into its metadata, as the SDK advises,
  disappeared from the screen (F-044). Keys and values are shown as escaped
  text, never as markup; at most 50 entries per kind and 300 characters per key
  or value are shown, and the page says how many entries it left out.
- **An event shows the same payload keys however it is reached.** On an
  event's first load, with or without JavaScript, a payload or diff value key
  named `__proto__`, at any depth, was dropped, so a stored `{"__proto__":1}`
  showed as `{}`, while choosing the same step on the timeline showed every
  key. The web app now writes payloads, the error, diff values and metadata as
  text on the server, in one function every page and the timeline read an
  event through, so both ways show the same text. The text is unchanged:
  payloads and errors pretty-printed, diff values compact, and a missing side
  of a change shown as a dash.
- **The Journeys page** (ADR-054). `/journeys` lists what happened in a period,
  any status and the last 24 hours by default, as a table of last activity,
  status, entity type, what the journey is shown as, last step and events. It
  filters by an hour, a day, a week, 30 days or a custom range, and by status,
  entity type, environment, service and a Contains box; a Failures shortcut
  shows only what failed; and a filtered view is a short, shareable link. A
  journey is shown as its label, else its displayable alias values, else its
  entity type and identifier. The navigation link reads Journeys.
- **`GET /v1/journeys`** behind it (`docs/API_SPEC.md` section 6): a required
  `since` (the refusal names the format), `until`, `status`, `environment`,
  `service`, `entityType`, and `q`, 2 to 200 characters, which matches ignoring
  case part of a journey's label or of a displayable alias value and nothing
  else. Rows carry `label`, `lastStep` and `displayableAliases`, as do rows of
  `GET /v1/search`. `GET /v1/projects` names each project's environments.
  Measured at 120,000 journeys in `docs/OPERATIONS.md` section 10, with
  `scripts/measure-journey-list.mjs` to reproduce the figures.
- **`GET /v1/search` takes a window and an environment** (`docs/API_SPEC.md`
  section 5): `since`, `until` and `environment`, all optional, beside the `q`,
  `limit` and `cursor` it already read. `since` and `until` bound a journey's
  last activity, the same column and the same half-open range `GET /v1/journeys`
  takes, so one pair of bounds narrows both endpoints. `environment` is a name,
  applied on top of the caller's scope and never instead of it (ADR-029): for
  the admin token it picks one environment of the named project, and for an API
  key, which already reads its own environment and nothing else, naming that
  environment changes nothing and naming another returns an empty page rather
  than an error. With none of the three the search spans the project's whole
  history, as it always has, which is what made a repeated alias value return
  every journey that ever carried it. No index was needed: measured at 200,000
  journeys, the bounds filter the plan the search already had, and a window
  narrow enough to be worth an index is served by `journeys_project_recent_idx`.
- **The search box narrows too.** Under the search box, Time (any time, the
  last hour, day, week or 30 days, or a custom range in UTC) and Environment
  (all, or one of the project's) send `since`, `until` and `environment` to
  `GET /v1/search`, in the same plain form, so a narrowed search works without
  JavaScript and is a link. Time starts on any time, which is what the API
  searches without a window; a custom range the API would refuse is set aside
  with a note saying the search spans all time. The page says what the results
  are narrowed to, and that the window is on a journey's last activity. Each
  result row names its environment when the API's search rows carry it (F-036);
  against an API whose rows do not, it shows none. On an installation with more
  than one project and none chosen, the search box still shows, with only "all"
  environments and a link to choose a project; a search goes to the project
  picker and back, as before.
- **A search row names its environment** (F-036, `docs/API_SPEC.md` section 5):
  `environment`, the environment's name, as a `GET /v1/journeys` row already
  had. The admin token's search spans every environment of the project, so the
  same identifier recorded in development and in production came back as two
  rows with nothing to tell them apart, and a search narrowed by `environment`
  could not say which one it gave. Both lists now build their rows from one
  presenter, so the two cannot drift again. Measured at 200,000 journeys, the
  join this needs on every search costs nothing outside the run-to-run spread.
- **An event read says which aliases it stated** (F-042, `docs/API_SPEC.md`
  section 9). `GET /v1/events/:eventId` gains `aliases`, each as the journey
  read shows it, `{ type, displayValue, displayable }`, from the same stored
  alias and masked the same way (ADR-053), so an `identified` event read on its
  own finally says what it identified. `[]` means the event stated none;
  `null` means the server did not record it, which is every event stored
  before this release. A dry run's `stored.event` carries the same field.
  Aliases are still stored once per journey; migration 020 adds
  `journey_events.stated_alias_ids`, the ids of the alias rows the event
  stated, written with the event's own insert. Ingestion now stores an event's
  aliases before the event, which costs an event with aliases one more
  statement: 2.3 to 2.7 ms at the median, measured in process.
- **A failed journey names the step that failed it** (F-047, ADR-063,
  `docs/API_SPEC.md` section 5). `GET /v1/journeys/:journeyId`, each item of
  `GET /v1/journeys` and `GET /v1/search`, and a dry run's `stored.journey`
  gain `failedStep`: the `name` of the failing event last in timeline order
  among the failures since the journey last became failed, and null whenever
  `status` is not `failed`. `lastStep` still follows the timeline's last row, so
  while a retry is in flight it names the retry's latest step and `failedStep`
  still names the step that failed. A successful retry that clears the failure
  and a completion clear it. Migration 021 adds the four columns behind it; it
  costs no statement, being part of the update that sets the status.
- **A timeline row names the build that recorded it** (F-043, `docs/API_SPEC.md`
  section 8). `GET /v1/journeys/:journeyId/events` rows gain
  `deploymentMetadata`, the event's `deployment` as the event read returns it,
  or null. Whether a journey's events all came from one build used to take one
  full event read per event, each carrying its whole payloads. Measured at
  10,000 events in one journey, a page of 100 goes from 0.068 to 0.100 ms in
  the database and from 15 to 28 kB; listing the distinct builds on the
  journey read instead would have read every event of the journey on every
  read, 5.0 ms at that length.
- **The journey page.** Headed by the journey's label when it has one, with the
  entity type and identifier beneath, and a back link to the list it was opened
  from. `GET /v1/journeys/:journeyId` returns the environment's name, `label`,
  `lastStep`, and each alias with a `displayable` field; masked values are
  marked as masked.
- **An interactive timeline.** Every event of a journey, however long: the page
  renders the first hundred and reads the rest on request. Each row leads with the step's name, with the operation as
  a badge and the service after it, and carries a full UTC timestamp; the date
  appears when a journey spans more than one day, and an event whose recorded
  time is more than two minutes from its arrival carries a clock warning. Filter
  to one service or to failures, move through events with the arrow keys while
  the detail panel follows, and turn on Live to follow a journey that is still
  recording. The address keeps `?event=` in step. The browser talks only to
  session-checked route handlers in the web app, never to the API (ADR-029).
- **Field-level transformation diffs**, which is the point of the product: what
  a step received against what it produced, shown as a field table rather than
  a text diff (ADR-030). Long diffs collapse to eight rows behind a button.
- **Replay** to development destinations (ADR-008, ADR-032): destination
  management, request preparation, and safety checks (an exact host allowlist,
  DNS pinned to the resolved address, refusal of the cloud metadata range, a
  header blocklist, response caps and timeouts), with the prepare and result
  pages. The payload is reviewed before sending and sent as recorded.
- **A read-only CLI**, `packages/cli`: `search`, `journey`, `event --diff` and
  `projects`, over HTTP, with `--json` on everything (`pnpm cli`).
- **No blank error pages.** An error boundary explains the likely cause, and a
  401 says the token does not match.

#### Operating it

- **`GET /ready` says what the API is running** (`docs/API_SPEC.md` section 14):
  `version`, `commit` when the build recorded one, and `source`, which is
  `build` when the published image baked the values in and `package` when
  nothing was baked in, so a source run or a hand-built image says so instead
  of naming a release it is not. All three are on the 503 answers as well as
  the 200, because when something is wrong the first question is what is
  running. The values come from the `WAYSCRIBE_BUILD_VERSION` and
  `WAYSCRIBE_BUILD_COMMIT` build arguments that `scripts/publish-image.sh` fills
  with the release tag and the commit; there is no runtime shell-out to git,
  which the image has no history, working tree or binary for. `GET /health`
  is unchanged and stays a bare liveness check.
- **The web app says what it is running.** A line under every signed-in page
  names the web app's version and commit and the API's, read from the API's
  `GET /ready`, and says when the two are different builds, which is what a
  partial upgrade looks like (F-045). The web image takes the same
  `WAYSCRIBE_BUILD_VERSION` and `WAYSCRIBE_BUILD_COMMIT` build arguments as the
  API image; without them it says "not a release build". An API that does not
  answer leaves the line saying its version is unknown, and the page renders
  as usual.
- **Bring your own database** (ADR-037). `DATABASE_URL` points at a PostgreSQL
  15 or later that your team already runs. Migrations need privileges on their
  own schema only and install no extensions. `infrastructure/compose.bundled.yaml`
  is an overlay that runs PostgreSQL alongside, for evaluation and local work.
- **Install shapes.** `infrastructure/compose.published.yaml` pulls the images
  and migrates on first boot. It requires `FLIGHT_RECORDER_VERSION`, the
  release tag to run, and has no `latest` fallback, so a pull cannot move the
  database across a release nobody chose. A Helm chart runs the stack on a local
  single-node cluster (ADR-042, `deploy/helm/README.md`); its migrate Job
  retries a connection failure, retries any other failure once with
  `migration failed ... see the error above`, and stops after
  `migrations.activeDeadlineSeconds`, 30 minutes by default.
- **`project:create` and `project:list`**, and **`key:create`, `key:revoke`,
  `key:list`**, all in the API image, so a new installation needs no checkout.
  `key:create` and `key:revoke` write `api_key.created` and `api_key.revoked`
  audit rows in the same transaction as the key, naming it by prefix
  (`docs/SECURITY.md` section 13).
- **`doctor`** checks an installation and says what to fix, one line per check
  (`PASS`, `WARN`, `FAIL`, `SKIP`): the database and its PostgreSQL version,
  pending migrations (naming a missing schema grant as such), published default secrets, stored data the
  configured keys cannot read, projects and unrevoked keys (warning while the
  published demo key is active), journeys stored across environments,
  secret-looking names in a sample of stored payloads, and with `--api-key` and
  `--api-url`, whether a key authenticates and the API reports ready. Exits 1
  when anything failed, and prints no secret beyond an API key's prefix. It is
  in the API image beside `key:create`, and runs as `pnpm run doctor` from a
  checkout (`docs/OPERATIONS.md` section 12). It takes the key to check from
  `WAYSCRIBE_API_KEY` when `--api-key` is absent, so the key need not sit in the
  container's process list; the flag wins when both are given. A variable that
  is set but empty, which is what a Compose file's
  `WAYSCRIBE_API_KEY: ${WAYSCRIBE_API_KEY}` gives it on a host without one,
  reports the key check as `SKIP` with that reason rather than leaving it out
  of a report that then read as all passed (F-032).
- **`key:create --json`** prints one JSON object with the key, its prefix, the
  project and the environment, and nothing else, so a script capturing a new key
  parses no prose. Without the flag the human form is unchanged.
- **`--help`** for the database CLI and for each of its commands, listing the
  arguments and flags, including `key:create --json` and the four fields it
  prints (`apiKey`, `keyPrefix`, `projectSlug`, `environmentName`). The
  top-level help names both ways to run the CLI:
  `node packages/database/dist/cli.js` in the API image, and
  `pnpm run <script>` in a checkout. It replaces a usage line that named
  `tsx src/cli.ts`, which the image does not have and which appeared only for
  an unknown command (F-033).
  Help needs no `DATABASE_URL` and never runs the command, however many `--`
  pnpm and the operator put before it; `--help` or `-h` after the value
  separator is refused rather than read as a value. Every flag is declared once
  in the CLI's command registry, which the parsers read their flags from by
  type and every usage line and help text is built from. A command that takes
  no flags now refuses one, as `key:create` and `doctor` already did, rather
  than ignoring it, and a name that begins with a dash goes after `--` for
  `project:create` and `key:create` as it does for the deletion commands.
  `help <command>` prints a command's help, as does a bare `help`, in any letter
  case, on every command but `project:create`, `key:create` and `key:list`; on
  the deletion commands a value that is really `help` goes after `--`. An
  argument containing a dash other than the ASCII hyphen, which smart
  punctuation or a full-width keyboard makes of a typed `--`, is refused, and so
  is an argument beyond those a command declares. With the `--` of `--help` turned
  into an em dash, `rollback` used to roll back and `key:revoke <prefix>` to
  revoke.
- **`ENCRYPTION_KEY_FILE`, `ENCRYPTION_KEY_PREVIOUS_FILE` and
  `ADMIN_TOKEN_FILE`** read each value from a file at startup instead of from
  the environment, the way Docker's own secrets mechanism mounts one.
  `infrastructure/compose.secret-files.yaml` is an overlay that wires this up
  for either Compose stack. The API, the web app, `doctor` and the key rotation
  commands all read them. Whitespace at the end of the file is ignored, an empty
  file is refused rather than read as an unset setting, and a setting given both
  as a variable and as a file is refused by name with no value printed.
- **`APP_URL` and `API_URL` read from the environment in the Compose files**,
  with the same localhost defaults, so a second stack on other ports can say
  where it is reached. Every other setting in those files already did.
- **Both images declare a health check**, so `docker compose up -d --wait`
  waits on a served request rather than a started process: the API answers
  `GET /health` and the web app answers its own `GET /health`, which loads its
  configuration and answers 503 when that fails, so for the web app "healthy"
  also means configured. Each is probed every two seconds during its start
  period, which returns `--wait` about two seconds sooner on a cold start
  (11.2 s to 8.8 s, measured on a laptop).
- **The web app refuses to start misconfigured**, as the API does. It loads its
  configuration once when the server starts and, when that fails, writes the
  reason naming the setting and never its value, and exits 1. Before this, a
  web container given both `ADMIN_TOKEN` and `ADMIN_TOKEN_FILE`, or a token file
  that was not there, started, passed a health check that probed `/login`, and
  failed the first sign-in with a 500; `up --wait` reported it `Healthy`. It now
  reports `container <name> exited (1)` within a second (F-030, measured on the
  built image in both cases). `API_URL` must be an `http://` or `https://` URL:
  `api:8080`, the host and port without a scheme, used to be accepted as a URL
  with the scheme `api:`, and a container started with it was healthy while
  every data page said the API could not be reached.
- **`ENCRYPTION_KEY` rotation without losing data** (ADR-044). Every encrypted
  value names the key that wrote it; `ENCRYPTION_KEY_PREVIOUS` keeps old data
  readable and searchable, and API keys authenticating, through a grace period;
  `rotate:reencrypt` moves stored data across in resumable batches; and
  `rotate:status` exits 0 when the previous key can come out
  (`docs/OPERATIONS.md` section 6).
- **Deletion on demand** (ADR-045). `delete:journey`, `delete:identifier`,
  `delete:range` and `delete:destination`, and the admin routes
  `DELETE /v1/journeys/:journeyId`, `POST /v1/erasures` and
  `DELETE /v1/replay-destinations/:destinationId`, with a confirmation page on
  each journey. Deletion is hard and admin-only; the selecting deletions have a
  dry run; every deletion writes its audit row in the same transaction, and an
  erasure's row holds the search token, never the value
  (`docs/OPERATIONS.md` section 8).
- **Retention**, swept hourly inside the API process, per environment, behind an
  advisory lock (`docs/OPERATIONS.md` section 7).
- **Prometheus metrics, on their own port** (ADR-047). `METRICS_PORT`, unset by
  default, serves `/metrics` and nothing else: requests by route pattern,
  events accepted, duplicate and rejected, query timeouts, pool connections,
  retention outcomes, the boot check's unreadable counts, memory and event loop
  lag (`docs/OPERATIONS.md` section 13).
- **Indexes built without blocking ingestion.** Migrations 013, 014, 016 and 019
  build their indexes concurrently. `migrate:unlock` releases the migration lock
  a killed `migrate` leaves behind (`docs/OPERATIONS.md` section 10).
- **Measured sizing.** `scripts/measure-storage.mjs` and
  `scripts/measure-journey-list.mjs` report disk per event by capture mode and
  journey list latency against a scratch database; `docs/OPERATIONS.md`
  section 10 has the results and a sizing formula.
- **An upgrade test gates every release.** `scripts/upgrade-test.mjs` records
  journeys, aliases, a diff, an error and a replay destination with an earlier
  build, then runs this build's migrations and API against the same database
  and checks that everything reads back. `publish-images` needs it
  (`docs/OPERATIONS.md` section 4).
- **Signed images with an SBOM.** `publish-images` pushes each image by digest,
  attaches a CycloneDX SBOM per platform as a cosign attestation, signs with
  Sigstore keyless signing from the pipeline's GitLab OIDC token, verifies, and
  only then creates the version tag and `latest`. The SDK is published with npm
  trusted publishing and provenance through `scripts/publish-sdk.sh`. Release
  jobs run only for `vMAJOR.MINOR.PATCH` tags; `v*` tags must be protected
  before the first release (`docs/OPERATIONS.md` section 11, `SECURITY.md`).
- **The demo**, four services proving the reference journey end to end, and
  `pnpm test:demo`, which asserts all ten events, the diff, the retries, and the
  dead-letter state against a running stack.
  [`examples/instrument-a-service`](examples/instrument-a-service) runs from a
  clean clone and lists every step.
- **Operations and security documentation**, a security disclosure policy, and
  [the decision log](docs/DECISIONS.md). The 2026-08-09 first-contact audit and
  what it changed in how this is tested are in
  [docs/WHAT_RUNNING_IT_FOUND.md](docs/WHAT_RUNNING_IT_FOUND.md).

### Changed

- **`counters()` keeps settings and options apart.** `rejectedSettings` now
  names only what `createRecorder` refused, and is fixed once it returns; a
  new `rejectedOptions` names what a later call was refused (`entity`,
  `context`, `journeyId`, `journeyIdSecret`, `entityFallback`, `displayable`).
  A correctly configured process used to end its shutdown line with
  `rejected settings: journeyId` after one odd call (F-038, ADR-062).
  `configurationErrors` still counts every report. `journeyIdFor` now names
  `entity` when it refuses one, and refuses an entity whose type or id is
  empty, as its documentation and the protocol already said. The derivation
  fixture lists those entities under a new `refusedEmpty`, so another SDK's
  conformance run checks it too.

- **`deployment` is reported by field.** A refused field is named
  `deployment.gitCommit`, `deployment.version` or `deployment.image`; keys the
  protocol does not have are `deployment.*`, never by their own names; and
  `deployment` means events carry none of it. So a partial refusal no longer
  reads like a total one (F-031, ADR-062). A field that is only whitespace is
  now refused as empty, `{}` and `{ gitCommit: undefined }` are now reported,
  and `constructor` or `toString` beside a valid field is now caught.

- **An error whose fields cannot be read no longer costs its step.**
  `record({ error })` with a `message`, `type`, `code` or `stack` getter that
  throws, or a revoked Proxy as the error, lost the whole event with one
  `capture_error`. Each field is now read on its own; a field that throws
  costs that field. A message that cannot be read, or is not a non-empty
  string, is sent as `The error's message could not be read.` instead of a
  value the server would refuse, and only `message`, `type`, `code` and
  `stack` are sent, each a string.

- **`createRecorder` no longer throws or hangs for a list setting it cannot
  read.** A revoked Proxy given as `deployment`, `redact` or `knownSafeNames`,
  an array Proxy whose reads throw, an array with a hostile `Symbol.species`
  or an overridden `filter`, threw out of `createRecorder` into the host's
  startup, against SDK-6, and an array Proxy claiming a `length` of a trillion
  hung it. `redact` and `knownSafeNames` are now copied by index into an array
  the SDK owns, at most 1,000 entries, and nothing of the host's runs after
  that. A list that cannot be read, or holds more than 1,000 entries, is
  reported as that setting, and `redact` keeps the built-in secret names.

- **An error message that looks like personal data is warned about**, as a
  journey label and a displayable alias already were (F-041, ADR-062). A
  thrown error's, a `FailureReason`'s, `fail()`'s and `record()`'s message is
  masked for credential shapes only, and a timeline shows it to every reader;
  an email address or an international telephone number in it now raises
  `personal_data_in_public_value` with `detail.field` `errorMessage`, and the
  message is sent unchanged. A stack is not examined. The warning is now given
  once per process, field and shape, so `personalDataInPublicValues` is at most
  6 rather than 2, and a warning about an error message never silences a
  later one about a label or an alias. The email shape no longer matches a
  module path, a versioned package, a masked URL, a git remote, an ssh target
  or an image digest, and a timezone offset such as `+0000` is not a telephone
  number.

- **Every event names the SDK that recorded it.** The protocol's `runtime`
  block gains an optional `sdk: { name, version, commit? }`, exported as
  `runtimeSdkSchema` (limits 128, 64 and 128), and the Node SDK now sends
  `runtime` on every event: `language` `"node"`, `version` the Node version, and
  `sdk` with `@wayscribe/node`, the package version and the commit it was built
  from, both baked in when the bundle is built. So during an upgrade, which
  services still run the old SDK is on every event, where both builds used to
  say `0.1.0` and send no `runtime` at all (F-046, ADR-063, SDK-64). The commit
  comes first from `packages/sdk-node/BUILD_COMMIT`, which `git archive` fills
  through a new `export-subst` rule in `.gitattributes`, then from
  `WAYSCRIBE_BUILD_COMMIT` or `CI_COMMIT_SHA` (a malformed one fails the
  build), then from `git rev-parse HEAD` in the package's own repository. Nothing is read from
  host settings, and `hostname` and `processId` are not sent. The protocol
  version stays `0.1`: a server from before this strips `runtime.sdk` and
  stores the rest, and each event is about 152 bytes larger with a commit and
  about 100 without one.

- **`dropped` names its cause, and a reply with no verdict counts toward the
  breaker.** `counters().droppedByCause` counts `dropped` by the diagnostic's
  code, `queue_full`, `after_shutdown`, `shutdown`, `retry_budget` and
  `no_verdict`, every key present from creation at zero and summing to
  `dropped`; the type of its keys is exported as `DroppedCause`. Four faults
  that ended with the same `recorded 12, dropped 12` now read apart (F-048). A
  send in which no reply gave a verdict for any event now counts toward the
  circuit breaker, so a proxy answering 2xx with the wrong body opens it after
  five sends instead of losing every event with the breaker shut: Leadline
  measured `recorded 16000, dropped 16000` and `breakerOpened` 0. Such a send
  reports no `transport_error`. A reply with some verdicts resets the count as
  before (ADR-063, SDK-65).

- **The telephone shape finds a number in a field and not a signed count.**
  The `+` of a telephone number may now follow `=`, `:`, a quote, `,`, `;`,
  `>` or `)` as well as whitespace, `(`, `[` and `<`, so `phone=+19195551234`,
  `tel:+19195551234` and `{"phone":"+19195551234"}` raise
  `personal_data_in_public_value`, which they did not. Digits written as one
  unbroken run now need 10 to 15 rather than 8 to 15, so
  `Received +12345678 bytes` no longer does; a number with separators still
  needs 8. A number of 8 or 9 digits written with no separator is no longer
  found. A `+` and four digits is skipped as a timezone offset only when it is
  one, hours 00 to 14 and minutes 00, 15, 30 or 45, so `+0530 2026` is still
  skipped and `+4930 1234567` is now found (ADR-063).

- **Four SDK declarations say what the code does.** `WrapResult` says the
  assignment of a second implementation needs no cast and its body's return
  still does (F-037). `ContinueJourneyOptions` names all four steps of the
  journey id, the id derived under `journeyIdSecret` included (F-039).
  `metadataFrom` says it runs on a result `isFailure` calls a failure, not when
  the callback throws or rejects, and once per call or per journey of an
  `across()` group (F-040). `FailureReason` says its message is masked for
  credential shapes and not for personal data (F-041). Each statement is pinned
  by a test. No behaviour changed.

- **`hasJourney` takes `unknown`.** It was declared as taking a
  `PayloadEnvelope<T>` while documented as taking anything, so a body off a
  queue, typed `unknown`, needed the cast the guard exists to remove (F-034).
  It is now `hasJourney(envelope: unknown): envelope is
  ContextEnvelope<unknown>`, with no type parameter, since the guard never
  reads `data` and a type argument would assert the payload's type unchecked
  (ADR-062). A `PayloadEnvelope<T>` still narrows to `ContextEnvelope<T>`
  inside the guard and to `NoContextEnvelope<T>` in its `else`. Its
  documentation now says that `false` covers both a value that is not an
  envelope and an envelope with no journey. Nothing changes at run time.

- **`injectPayload` returns `PayloadEnvelope<T>`, not `ContextEnvelope<T>`.**
  Without a context to inject it produces an envelope with an empty
  `_wayscribe`, which did not satisfy `ContextEnvelope` and which the SDK cast
  its own value to get past (ADR-060). `PayloadEnvelope<T>` is
  `ContextEnvelope<T>` or the new `NoContextEnvelope<T>`, so the declared type
  is now what the call can actually return. A new exported type guard,
  `hasJourney(envelope)`, narrows one to `ContextEnvelope<T>`: a nested
  `journeyId` check does not narrow a union, which the SDK README's propagation
  section explains.

- **Capture is about a quarter faster.** Fitting an event to the server's limits
  (ADR-051) had made a wrapped call about 40 percent slower: it checked the whole
  event a second time and walked each payload again to cut long strings. The
  event is now measured with plain serialisation when it is certainly within
  its budget, and strings are cut in the walk that makes a payload storable,
  with the same results. In a tight loop on an Apple M3 Pro, a 1 KiB `transform`
  went from 41 to 32 µs and a 64 KiB one from 2,122 to 1,769 µs. While the
  circuit breaker is open the recorder no longer starts a send for every event
  recorded, which cost about 6 µs a call against a refusing endpoint.

- **Events arrive in order after an outage.** Those failed sends overlapped and
  put their batches back out of order, so once the endpoint recovered a few
  batches arrived out of order, and with the queue full a batch from the middle
  of the outage could arrive after thousands of newer events had been dropped.
  The events kept are now the newest, and they arrive in the order recorded.

- **A payload far over budget is refused quickly.** The size check serialised
  a payload in full before comparing it with the budget, and shared references
  expand when serialised: an object 24 levels deep holding the next level twice
  took `record()` about 2 seconds and 245 MB. The check now stops once the
  payload is certainly too large.

- **A long string replaced by a colliding key is not reported as cut.** Two
  keys that differ only by a NUL or a broken character are stored as one, and
  a long value the later one replaced no longer counts in `payloadsTruncated`.

- **An event whose payload is a function or a Symbol is sent.** When another
  payload pushed such an event over budget, weighing it threw and the event was
  lost as a capture error.

- **A blank required setting is reported as missing (SDK-60).** An empty or
  whitespace-only `endpoint`, `apiKey`, `serviceName` or `environment`, such as
  `process.env.FLIGHT_RECORDER_API_KEY ?? ""` with the variable unset, now
  prints `configuration_error: <setting> is empty, ...` once per process, even
  with `logDiagnostics` off, instead of only a 401 from the server.

- **CI tests the versions the project claims.** The SDK and CLI run on Node
  22.12.0 and 24, including `import` and `require()` of the packed tarball in
  fresh projects, and the integration suite runs on PostgreSQL 15, 17 and 18.
  `doctor` no longer warns on PostgreSQL 15 or 16 and warns instead on a release
  newer than 18. The CLI's `engines` floor is Node 22.12, matching the SDK. The
  README has a Supported versions table, checked against the CI configuration.

- **The Node SDK's public API is settled for its first release** (ADR-056).
  The wire format is unchanged, but a host that installed the SDK from an
  earlier tarball has to follow these renames:

  | Before | After |
  | --- | --- |
  | `recorder.consume({ context, entityFallback })` | `recorder.continueJourney({ context, entity })` |
  | `recorder.continueJourney(context)` | `recorder.continueJourney({ journeyId, entity })`, the same object; `label` may be added |
  | `recorder.diagnostics()` | `recorder.counters()` |
  | `recorder.toQueueAttributes(context)` | `recorder.injectSqsAttributes({}, context)`, which copies the attributes it is given |
  | `recorder.fromQueueAttributes(attributes)` | `recorder.extractSqsContext(attributes)` |
  | `recorder.wrapPayload(payload, context)` | `recorder.injectPayload(payload, context)` |
  | `recorder.unwrapPayload(body)` | `recorder.extractPayload(body)` |
  | `journey.fail(name, error, metadata)` | `journey.fail(name, error, { metadata })` |
  | `journey.identify(aliases, { displayable })` | `journey.identify(aliases, { displayableAliases })` |
  | `startJourney({ displayable })` | `startJourney({ displayableAliases })` |
  | option `maxPayloadBytes` | `maxEventBytes` |
  | option `propagate` | `propagation` |
  | diagnostic kind `breaker_open`, printed `[flight-recorder] breaker_open:` | `breaker_opened` |
  | `{ kind, reason, detail? }` | `{ kind, code, reason, detail }`: match on `code`, never on `reason` |
  | `delivered_first`'s `endpoint`, `accepted` | `detail.endpoint`, `detail.accepted` |
  | `insecure_endpoint`'s `scheme`, `host` | `detail.scheme`, `detail.host` |
  | `payload_omitted`'s `detail.reason` (`payload_too_large`, `max_depth_exceeded`, `max_keys_exceeded`, `projection_failed`) | `code` (`too_large`, `too_deep`, `too_wide`, `projection_failed`, and `unserialisable`, now also reported for a payload whose getter throws) |
  | `dropped` reasons `queue_full`, `no_verdict: ...`, `shutdown: ...` | codes `queue_full`, `no_verdict`, `shutdown`, and `after_shutdown`, `retry_budget` |
  | `rejected`'s `detail`, the server's error | `detail.serverError`; a whole request refused is code `request_refused` with `detail.events` and `detail.httpStatus` |
  | `capture_error` and `transport_error` `detail`, the thrown value | `detail.error` |
  | `keysDropped` counted keys | counts `key_dropped` reports; `detail.keys` still counts keys |
  | no such counter | `recorded`; `sent + rejected + dropped === recorded` after `shutdown()` |
  | types `FailureDiagnostic`, `FailureKind`, `TraceContext` | removed; one interface per kind (`DroppedDiagnostic`, `PayloadTruncatedDiagnostic`, ...) |
  | `engines.node` `>=20.19.0` | `>=22.12.0` |
  | `pnpm --filter @flight-recorder/node pack` | `pnpm --filter @flight-recorder/node run pack:release <absolute directory>` |

  An option passed under its old name is reported as `setting_renamed`, and
  `maxPayloadBytes` and `propagate` are printed once per process. A TypeScript
  `switch` over `kind` should keep a `default` branch: new kinds and codes may be
  added in any minor release.
- **The SDK no longer converts numeric strings in its options (SDK-60).**
  `maxBufferedEvents: "5000"`, as read from `process.env`, falls back to the
  default with a `configuration_error` report instead of taking effect.
- **`GET /v1/journeys` refuses a query key it does not read**, with
  `400 invalid_query` naming the start of the key and listing the parameters
  the route reads. A misspelt filter such as `entity_type=order` used to return
  an unfiltered list that looked filtered.
- **`GET /v1/search` refuses a query key it does not read**, with
  `400 invalid_query` naming the start of the key and listing the parameters the
  route reads, as `GET /v1/journeys` already did. **This changes an answer:**
  `?q=CUST-1&status=failed` was a `200` that silently ignored `status` and is
  now a `400`, which is the point, because a filter that is dropped without a
  word returns an unnarrowed search that looks narrowed. A caller that sends
  only `q`, `limit` and `cursor`, which is every caller in this repository, sees
  no change; one that sends anything else now sees a refusal. A parameter name
  holding a NUL is refused without being echoed back.
- **`limit` is refused, not reinterpreted** (F-029), on `GET /v1/search`,
  `GET /v1/journeys` and a journey's timeline. It was read with `parseInt`,
  which stops at the first character that is not a digit, so a repeated
  `limit=1&limit=99` returned one row and `limit=99&limit=1` ninety-nine, and
  `limit=2%005` returned two. Now `limit` given more than once, or holding a
  NUL, is `400 invalid_query` with the words every other parameter gets
  (`limit must be given once.`, `limit must not contain a null byte.`). **This
  changes an answer:** a value that is not a whole number of at least 1, such as
  `abc`, `0`, `-1` or `5abc`, is refused with `limit must be a whole number of
  at least 1; above 100 it is read as 100.`, where it used to become 25 without
  a word. A whole number above 100 is still read as 100, as before, and
  `nextCursor` says whether more remains. Omitted or empty is still 25.
- **A journey's timeline refuses a query key it does not read**, as search and
  the journey list do: `GET /v1/journeys/:journeyId/events?limt=5` is
  `400 invalid_query` naming the key and listing `limit` and `cursor`, where it
  returned the default page as if the key had been understood. This lands with
  the `limit` change, so the route changes its error behaviour once.
- **The read-only CLI reads `--limit` strictly.** `wayscribe search x --limit
  5abc` sent a limit of 5, because it too was read with `parseInt`. A value
  that is not a whole number of at least 1 is now refused before anything is
  sent, with `--limit must be a whole number of at least 1`, and `--help` says
  the server reads one above 100 as 100.
- **The refusal of a future `since` states the real rule** (F-035), on
  `GET /v1/search` and `GET /v1/journeys`: `since must not be more than 60
  seconds ahead of the API's clock.` It said `since must not be in the future.`,
  which a caller whose clock ran 30 seconds fast saw contradicted by a `200`,
  and it left out the tolerance that explains a refusal caused by clock skew.
  The check itself is unchanged. The message is built from the tolerance, so
  the two cannot drift apart.
- **Dry runs that share a journey wait for each other** (ADR-063,
  `docs/INGESTION_CONTRACT.md` section 8). Two dry runs naming the same
  journeys in opposite orders deadlocked, and PostgreSQL cancelled one, which
  answered `storage_error` for events a real send would store; a reviewer saw
  it in 50 runs of 50. A dry run now takes a transaction-scoped advisory lock
  per distinct journey it names, one statement each in ascending key order,
  before its first event, so the second waits at its start. A wait past
  `DATABASE_STATEMENT_TIMEOUT_MS` answers the request `503 query_timeout`.
  Batches sent for real take no such lock.
- **The journey id shapes are documented** (F-049, ADR-063,
  `docs/EVENT_PROTOCOL.md` section 4). The Node SDK's random ids are `jrn_` and
  a lowercase hyphenated UUID, 40 characters; its derived ids are `jrn_` and 32
  lowercase hex characters, 36 characters. The section recommended
  `jrn_<uuidv7>`, which neither is. A journey id stays an opaque string of 1 to
  128 characters, and a reader must not parse or validate its shape.
- **A successful retry clears a failed journey** (ADR-061). A `retried` event
  carrying no error returns the journey's status from `failed` to `active`
  instead of leaving it failed until something else says otherwise. An SDK
  records a retried call as `retried` whichever way it comes out (ADR-022), so
  a step that failed on its first attempt and succeeded on its second used to
  leave the journey failed until `finish()` landed. It clears rather than
  completes: a journey that retried successfully and then died without
  finishing must not read as completed, so `completed` still means a
  `completed` operation at or after the newest event's timestamp. A retry that
  fails again is still a failure, an older successful retry still cannot clear
  a newer one, and a journey already completed is never knocked back.
- **Both ingestion routes refuse a query parameter they do not know**, with
  `400 invalid_query` naming the key. `POST /v1/events` accepts none and
  `POST /v1/events/batch` accepts only `dryRun`, so `?dryrun=true` can no longer
  store a batch the client believed it had only validated.
- **Refusals before a route runs use this API's codes.** They were Fastify's
  `FST_ERR_CTP_BODY_TOO_LARGE`, `FST_ERR_CTP_INVALID_MEDIA_TYPE`,
  `FST_ERR_CTP_INVALID_JSON_BODY` and `FST_ERR_CTP_EMPTY_JSON_BODY`; they are now
  `payload_too_large`, `unsupported_media_type` and `malformed_json`. The HTTP
  statuses and the error body are unchanged.
- **Three protocol error codes are gone** (ADR-049). `missing_required_field`,
  `invalid_timestamp` and `invalid_operation` were listed and never sent; those
  refusals are `invalid_event` with the failing field in `details`. Code that
  imported `PROTOCOL_ERROR_CODES.missingRequiredField`, `.invalidTimestamp` or
  `.invalidOperation` no longer compiles; treat an unrecognised code by its HTTP
  status.
- **The Recent page is now the Journeys page** (ADR-054). `/recent` redirects to
  `/journeys` with its query string, adding `status=failed` when the link named
  no status, which is what Recent showed.
- **The database is yours by default** (ADR-037). `DATABASE_URL` is required,
  and the bundled database moved to the `infrastructure/compose.bundled.yaml`
  overlay. See the upgrade notes.
- **`infrastructure/compose.yaml` takes its keys from files.** `ENCRYPTION_KEY`
  and `ADMIN_TOKEN` come from `infrastructure/defaults.env` and then the
  repository-root `.env`, which wins, instead of the shell.
  `compose.published.yaml` still reads the shell.
- **The Helm migrate Job says why a migration failed, and is bounded.** It
  printed `database not ready` after every failed attempt and retried every
  failure 30 times. See the upgrade notes for its deadline.
- **Database CLI commands that take no flags refuse one.** `migrate --dry-run`,
  for one, used to ignore the flag and migrate; it now prints
  `Unknown argument: --dry-run` with the command's usage and exits 1, changing
  nothing. A script passing such a flag should drop it. `key:create` and
  `project:create` likewise refuse an argument beginning with a dash, which
  `key:create` took as the key's name; such a name goes after `--`, which
  `project:create` used to fold into the name. Every command refuses an
  argument it does not declare, which `migrate`, `rollback`, `seed`,
  `key:revoke` and the others without a parser of their own used to ignore.

### Security

- **Secrets need not sit in the container's environment.** With the Compose
  paths `ENCRYPTION_KEY` and `ADMIN_TOKEN` are part of the container's
  `Config.Env`, so anything able to run `docker inspect` on the host can read
  the key that decrypts every stored payload and the token that signs every
  admin session, which is the access starting the stack already needs. The
  trade-off is stated next to the settings table (`docs/OPERATIONS.md` section
  6) and in `docs/SECURITY.md` section 7, and the `_FILE` settings above are the
  Compose equivalent of the `existingSecret` a Helm install already has. The
  boot warning about published default secrets is found in the values the API
  is running on, so a default that arrives through a file warns exactly as one
  in the environment does.
- **The secrets scanner is pinned.** The `secrets` job ran
  `zricethezav/gitleaks:latest`, so a new gitleaks release could change the
  gate without anyone choosing it. It now runs `v8.30.1`, pinned by digest, as
  Trivy, Syft and cosign already were.
- **LICENSE and NOTICE ship with the package and the images.** The npm package
  and the API and web images now include the project's LICENSE and NOTICE, as
  Apache-2.0 asks of anyone redistributing it; in the images they are at
  `/licenses/`. The release checks fail if either file is missing, and the web
  image now carries the same OCI labels as the API image.
- **Next.js telemetry is off wherever Next runs.** `next build` reports
  anonymous usage data to Vercel unless `NEXT_TELEMETRY_DISABLED` is set, and
  the README's quick start builds the web image on the reader's machine. The web
  Dockerfile (build and runtime stages), the web package's `dev`, `build` and
  `start` scripts, and CI all set it. The running services send no telemetry;
  building the images still downloads base images and packages.
- **Redaction matches built-in secret names at any depth** (ADR-035), in the SDK
  before an event leaves the process and again at ingestion, in every capture
  mode. Rules of the form `**.name` match a key wherever it appears; a bare
  `authorization` still matches the top level only. A secret name is one name
  however it is spelled (ADR-039).
- **Header credentials are redacted in the shapes clients produce**: a
  two-element `[name, value]` array, a plain object with a string `name` or
  `key` beside a `value` (other fields are kept), a flat string array that reads
  as a header list, Node's `rawHeaders`, and a `Name: value` line in a
  CRLF-delimited header block, including one the SDK cut to the string limit.
  A value that is itself a header name is kept. `SECURITY.md` section 4 lists
  exactly which shapes are covered.
- **Webhook signature headers are redacted by default** (ADR-055).
  `stripe-signature`, `x-hub-signature`, `x-hub-signature-256`,
  `x-slack-signature`, `x-hubspot-signature`, `x-hubspot-signature-v3`,
  `x-twilio-signature` and `x-shopify-hmac-sha256` are built-in secret names, in
  the SDK and on the server, in every capture mode. A stored signature with its
  body is a request the receiver accepts, and GitHub's has no timestamp.
- **A warning for secret-looking field names no redaction rule covers**
  (ADR-055, SDK-61, SDK-62). The SDK reports `unredacted_secret_name` when an
  event carries a number or a plausible string under a name that looks like a
  secret, as an object key or in a header shape, naming the field, the name and
  its path and never the value. It prints one line per process and name even
  with `logDiagnostics` off, counts `unredactedSecretNames`, and sends the event
  unchanged: nothing is redacted on a guess. `knownSafeNames` silences a false
  positive without changing redaction. The rule is `looksLikeSecretName` and
  `looksLikeSecretValue` in `payload-security`, written out in `SDK_SPEC.md`
  section 13. `doctor` runs the same check over a sample of stored payloads, for
  senders that are not the Node SDK.
- **Credentials inside error text are masked by shape** (ADR-046), by the SDK
  before sending and by ingestion before storing: URL userinfo, Slack and
  Discord webhook URLs, `Bearer`, `Basic` and `Digest` credentials, values
  assigned to a secret name, JSON Web Tokens, PEM and PGP private keys, and
  provider-prefixed keys. It does not guess at entropy; `SECURITY.md` section 4
  lists the known misses. `metadata` and payload strings keep name-based
  redaction only.
- **Stack traces are stored only under full capture.** Ingestion drops
  `error.stack` unless the environment's capture mode is `full-payload` and
  `ALLOW_FULL_PAYLOAD_CAPTURE` is set, and masks a stack it keeps. The Node SDK
  does not send one.
- **What is stored in plain text** (ADR-054): payloads, after redaction, as
  `jsonb`; journey labels, which are not redacted and must not hold personal
  data; and copies of the values of aliases marked displayable. Entity ids and
  masked aliases are encrypted and tokenised, and `q` never matches them. When
  an alias is masked the live row's copy is removed at once, but earlier row
  versions keep the text until vacuum, it stays in WAL, replicas and backups,
  and destroying `ENCRYPTION_KEY` does not cover it; `docs/SECURITY.md`
  section 6 says how to purge it.
- **The stored content hash is keyed** (ADR-048): an HMAC-SHA256 under a
  subkey of `ENCRYPTION_KEY`, stored as `h1.<keyId>.<hex>`, so a database reader
  cannot confirm a guess at a masked value by hash match.
- **An API key cannot write into another environment's journey** (ADR-038).
  Such an event is refused with `409 journey_environment_mismatch` and nothing
  is stored for it. Journey ids an application chooses itself must be
  unpredictable, and a journey id propagated from one environment to another is
  refused (`docs/EVENT_PROTOCOL.md` section 4).
- **Replay does not leak its destination's credentials.** A replay whose
  destination headers cannot be decrypted is refused and audited as
  `replay.blocked`, never sent without them. A run stores each destination
  header, and any blocklisted header, by name with the value `[REDACTED]`, and
  each destination header value of 8 or more characters is replaced in the
  stored response body and error message (exact matching only). A destination's
  audit row does not record its base URL.
- **Replay's default allowlist is `localhost`** in `compose.published.yaml` and
  the Helm chart, not `host.docker.internal`, which reaches every service on the
  Docker host. The development stack and `values-local.yaml` keep it
  (`docs/OPERATIONS.md` section 9).
- **Logs carry no request values or row contents.** Request log lines carry the
  path and parameter names with every value `[REDACTED]`, so a searched
  identifier is not logged; a request matching no route is `404 not_found`
  naming only the path. A request Node's parser rejected is logged without its
  raw bytes. A database error is logged without PostgreSQL's `detail`, `where`
  and `internalQuery`, which can print the refused row.
- **Admin token guesses are throttled.** The API counts failed authentication
  per source address on every route that accepts the token and answers
  `429 too_many_attempts` after five failures in a minute, for five minutes;
  ingestion is not throttled. The web login's limiter keys on the socket
  address. `TRUSTED_PROXY_COUNT` (default 0) honours `X-Forwarded-For` that many
  hops from the right. An IPv6 address counts as its /64, and each throttle's
  memory is bounded (`docs/OPERATIONS.md` section 9).
- **`Authorization` must be exactly the scheme, one space, and the token.**
  Anything after the token is `401`.
- **Redirects stay on the host.** The project picker's return path is checked
  after normalisation, and every redirect the web app builds is a 303 with a
  path-only `Location` held to its own host, which also keeps sign-in working
  behind a TLS proxy that sends no `X-Forwarded-Proto`.
- **The web interface sends a Content-Security-Policy** allowing scripts only
  from its own origin and by a per-response nonce, with
  `frame-ancestors 'none'`, `base-uri`, `form-action` and `style-src` all `'self'`, and
  `object-src 'none'`, plus `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. A
  browser test fails on any policy violation.
- **The Helm chart runs every pod locked down**: non-root users,
  `seccompProfile: RuntimeDefault`, no privilege escalation, all capabilities
  dropped, and a read-only root filesystem. `networkPolicy.enabled`, off by
  default, adds a NetworkPolicy per pod; replay destinations go in
  `networkPolicy.apiExtraEgress` (`deploy/helm/README.md`).

### Upgrade notes

These apply to an installation or a host application built from an earlier
development build of `main`. A new installation can skip them.

- **Upgrade the server before the services.** A new SDK sends `runtime.sdk`,
  which a server from before ADR-063 strips before it takes the event's content
  hash. An event whose first delivery reached the old server and whose response
  was lost, resent after the server was upgraded, is answered
  `event_id_conflict`: it is stored, and the SDK counts it `rejected`. Upgrading
  the server first never meets this.

- **`counters()` has `droppedByCause`, and a proxy that answers without verdicts
  opens the breaker.** A test that compares the whole counters object adds the
  new key. A service behind a proxy that rewrites the API's replies now shows
  `breakerOpened` above zero and loses events as `queue_full` or `shutdown`
  once the queue fills or the process ends, where it lost them all as
  `no_verdict` before.

- **`rejectedSettings` no longer holds call-time names.** A test or health
  check that expected `entity`, `context`, `journeyId`, or a `journeyIdSecret`
  that a call needed but was never configured, in `rejectedSettings` reads
  `rejectedOptions` instead. A check that stops recording on any refused
  setting keeps working, and can now let a single `deployment.<field>` through
  while still stopping on `deployment`.

- **`deployment` problems have new names.** One that was reported as
  `deployment` is now `deployment.<field>`, `deployment.*`, `deployment`, or
  several of them, in that order. `{ gitCommit: process.env.GIT_SHA }` with
  the variable unset now reports `deployment`; it sent nothing before too, in
  silence. A value that is only whitespace is refused instead of being sent.

- **`hasJourney` takes no type argument.** A call written
  `hasJourney<Job>(body)` drops the `<Job>`: a typed envelope keeps its payload
  type through the guard without one, and a body typed `unknown` narrows to
  `ContextEnvelope<unknown>`, whose `data` is yours to check.

- **`personal_data_in_public_value` has a third `detail.field`.** Besides
  `journeyLabel` and `displayableAliases` it can be `errorMessage`. A handler
  that switches on the field exhaustively needs the new case; one that logs it
  needs nothing.

- **A type annotation on an injected payload.** If you declared a value or a
  queue's job payload as `ContextEnvelope<T>`, annotate it as
  `PayloadEnvelope<T>` instead, which is what `injectPayload` returns and what
  the consumer can actually receive. Nothing changes at run time, and
  `extractPayload` takes either. To narrow one to `ContextEnvelope<T>`, use the
  exported `hasJourney` guard.

- **`compose.published.yaml` needs `FLIGHT_RECORDER_VERSION`.** It used to fall
  back to `latest`. Export the release tag, such as
  `FLIGHT_RECORDER_VERSION=v0.1.0`, beside `COMPOSE_FILE`.

- **Empty journeys left by development builds.** Before this release, an event
  refused with `event_id_conflict` and a journey id that did not exist yet
  created that journey with no events, and it appeared in the journey list. A
  refused event now leaves no trace. Journeys left behind this way have
  `eventCount` 0; remove any you find with `delete:journey` (OPERATIONS
  section 8).

- **`ADMIN_TOKEN` is trimmed now**, as `ENCRYPTION_KEY` already was. Two
  consequences for a deployment whose token carries whitespace. A token of 31
  characters padded to 32 is refused at startup, naming `ADMIN_TOKEN`, where it
  used to be accepted: set a real 32-character token (`openssl rand -hex 32`).
  And a token with a space, a newline or a byte-order mark around it is now the
  trimmed value everywhere: existing web sessions stop verifying once the API
  and the web app are both on this release, which signs anyone in again at the
  login form, and a script that sends the admin token to the API has to send
  the trimmed value in its `authorization` header. Upgrade the two together, as
  the release expects: a stack running one of each would have the web app
  signing sessions the API refuses until it catches up. A token with no
  surrounding whitespace is unaffected.

- **Rename SDK calls and options** as in the table under Changed. Convert
  numeric SDK options before passing them:
  `maxBufferedEvents: Number(process.env.MAX_BUFFERED)`, not the string.
- **Migration 020 adds a column to `journey_events`** with a five-second
  `lock_timeout`, as 017 did; run `migrate` again if it gives up behind a long
  transaction (`docs/OPERATIONS.md` section 4). There is no backfill: events
  stored before it read `aliases: null`.
- **Migration 021 adds four columns to `journeys`** with the same five-second
  `lock_timeout` (`docs/OPERATIONS.md` section 4). There is no backfill: a
  journey failed before it reads `failedStep: null` until its next failure;
  show its `lastStep` meanwhile.
- **Send `limit` once, as a whole number of at least 1.** A client that sent
  `limit=0` or an empty-looking value such as `limit=abc` to get the default
  now gets `400 invalid_query`; leave `limit` out instead. `limit=1000` still
  works and is read as 100.
- **Drop unknown query keys.** A client that sends keys `GET /v1/journeys` does
  not read, or any query parameter to the ingestion routes other than `dryRun`
  on the batch route, gets `400 invalid_query`. A client that branched on the
  `FST_ERR_*` codes or the three removed protocol codes should branch on the HTTP
  status.
- **Migration 015 rewrites every replay run row.** It replaces each value in
  `replay_runs.request_headers` with `[REDACTED]` in one transaction (about 2
  seconds for 100,000 runs, blocking updates to existing runs but not inserts,
  and doubling the table's size until vacuum), including headers Flight
  Recorder set itself. Its down migration does nothing. A backup taken before it
  still holds destination credentials; rotate any that matter at the
  destination (`docs/OPERATIONS.md` section 4). Responses stored before the
  upgrade are not scrubbed.
- **Migration 017 adds a column to `entity_aliases`.** It is a catalogue change
  on PostgreSQL 11 and later and finishes at once, but it gives up after five
  seconds if a long transaction holds the table. Run `migrate` again if it does
  (`docs/OPERATIONS.md` section 4).
- **Migration 018 adds columns, a constraint and a trigger.** The columns are
  nullable with no default, a catalogue change with no table rewrite; the
  constraint is added unvalidated and then validated in a second transaction
  that does not block writes. The trigger clears a masked alias's plain-text
  copy, so the previous API can keep ingesting and rotating keys alongside the
  new one during a rolling upgrade. Each lock request gives up after five
  seconds, so in the worst case writes to `journeys` stall for about ten
  seconds; run `migrate` again if it gives up. There is no backfill: journeys
  recorded before the upgrade show no label or last step until new events
  arrive, and older displayable aliases are not matched by text until an event
  states them again.
- **Migration 019 builds two indexes concurrently.** It does not block
  ingestion, but it waits for transactions that started before it, and gives
  up with `canceling statement due to lock timeout` after 10 minutes if one (a
  long retention batch, an admin deletion, a `pg_dump`) is still running. Run
  `migrate` again once it ends; the rerun drops what the interrupted build left
  and builds it afresh. Run it against PostgreSQL directly, not through a
  transaction-pooling PgBouncer. `docs/OPERATIONS.md` section 10 has a query
  that shows what the build is waiting for.
- **The Helm migrate Job has a deadline**, `migrations.activeDeadlineSeconds`,
  1800 seconds by default. Upgrade with `helm upgrade --timeout 30m` to match,
  raise the value if your migrations need longer, or set it to null.
- **Values written before key ids carry none.** They read as before.
  `rotate:status` counts them as legacy and exits 1 until they are rewritten.
  Run `rotate:reencrypt` once with only `ENCRYPTION_KEY` set to upgrade them
  under the same key. API keys issued earlier show
  `key id not recorded yet; recorded on next use` and do not hold the exit code at 1 unless a rotation is
  under way.
- **There is no rolling back once `fr1.` values are written.** An earlier build
  cannot read them, and it would send replays without their destination
  headers. To roll back, restore the backup taken before upgrading.
- **Keys are trimmed of surrounding whitespace.** An `ENCRYPTION_KEY` configured
  with surrounding whitespace, usually a trailing newline from a secrets file
  such as a Kubernetes secret created with `--from-file`, derives different keys
  after the upgrade, so earlier data stops decrypting and earlier API keys
  answer 401. `ENCRYPTION_KEY_PREVIOUS` is trimmed the same way. Check before
  upgrading:

  ```bash
  kubectl get secret <name> -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d | od -c | tail -2
  ```

  A `\n` before the final offset means the key has one.

- **Content hashes need no migration.** Rows written before keyed hashes keep
  their unkeyed hash, and a resend is still compared against it, so a delivery
  that straddles the upgrade dedupes. Those rows remain an oracle for what they
  masked until they are deleted or retention removes them. After a key rotation
  completes, a duplicate delivery of an event recorded under the removed key is
  answered `409 event_id_conflict`, which the SDK treats as permanent; the
  stored event is unaffected. Resending one event id from a fleet running SDK
  builds that render a value differently can also be answered 409.
- **Rows are not rewritten by new redaction or masking.** Payloads, error
  messages, stacks and webhook signature headers stored by an earlier build keep
  what they held, including any credential. Treat such rows as holding it,
  rotate what they hold, and remove them with `delete:journey`,
  `delete:identifier` or `delete:range` (`docs/OPERATIONS.md` section 8,
  ADR-045). Logs kept from earlier builds may hold searched identifiers, and
  replay destination audit rows written earlier keep the base URL;
  `docs/OPERATIONS.md` sections 8 and 13 say what to do about each.
- **Redaction reaches further, so expect more `[REDACTED]`.** If a key name on
  the built-in list appears somewhere it is not a secret, scope it with a dotted
  path in your own `redact` list.
- **A client that sends `error.stack` stops having it stored** unless the
  environment uses `full-payload` on an installation with
  `ALLOW_FULL_PAYLOAD_CAPTURE`.
- **Run `doctor` after upgrading.** Its `Journey environments` check fails when
  an earlier build stored events across environments, and
  `docs/OPERATIONS.md` section 12 lists them.
- **`REPLAY_ALLOWED_HOSTS` defaults to `localhost`** in `compose.published.yaml`
  and the Helm chart. An installation that replays to `host.docker.internal`
  without setting the variable must now set it
  (`REPLAY_ALLOWED_HOSTS=localhost,host.docker.internal`, or
  `api.replayAllowedHosts`); replays to it are otherwise refused with
  `host_not_allowed`.
- **An installation that used the bundled database** should add
  `-f compose.bundled.yaml` to keep the same behaviour.
- **Shell exports no longer reach `infrastructure/compose.yaml`.** A stack that
  was configured with `export ENCRYPTION_KEY=…` now starts on the published
  defaults instead. Move the values into the repository-root `.env`, and
  recreate the containers with `docker compose … up -d`;
  `docker compose restart` does not re-read `env_file`.
- **Conformance cases are loaded in order of id**, not of file name. A harness
  comparing with the manifest has to sort the same way.

### Known limitations

- The admin token is a single shared secret that reads every project, with no
  user accounts and no record of who used it.
- Propagated journey context is validated for shape but is not authenticated.
- Of the five verbs in the product promise, **changed** and **rejected** are
  demonstrated end to end. Duplication and loss are not yet first-class.
- The diff compares a step's own input and output, and arrays by position
  (ADR-025, ADR-030). Replay targets development destinations only.
- `audit_events` is never swept, and the login limiter is per process.
  [docs/ROADMAP.md](docs/ROADMAP.md) lists what else is known to be open.
