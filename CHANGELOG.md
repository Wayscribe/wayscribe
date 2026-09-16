# Changelog

Notable changes to Flight Recorder. Dates are the day the work merged.

Versions follow [semantic versioning](https://semver.org). Before 1.0 the minor
version may carry breaking changes; the patch version will not.

The published artifacts are versioned together: the `api` and `web` images and
the `@flight-recorder/node` package share a version, because the event protocol
is the contract between them and a mismatch is not something a user should have
to reason about. The protocol itself carries its own `protocolVersion`, which
changes far less often.

## [Unreleased]

### Changed

- **The SDK fits every event to the server's limits before sending it**
  (ADR-051). It used to measure each payload on its own and scale its string
  limit with `maxPayloadBytes`, while the server measures the whole envelope and
  never scaled anything, so a 70,000 character string, two payloads that each
  fit, or a payload 31 levels deep left the SDK and were refused, losing the
  whole event. Now a string over 65,536 characters is cut to its start and
  `[TRUNCATED: <n> characters removed]`; a payload that still does not fit, or
  is too deep or too wide, becomes `[PAYLOAD_TOO_LARGE]`, the larger of `input`
  and `output` first and `metadata` last; and the event is always sent. The SDK
  runs the same check as ingestion, `eventLimits` from `payload-security`.
  **`maxPayloadBytes` is now the budget of one whole event**, and should be set
  to the server's `MAX_EVENT_PAYLOAD_BYTES`; the default is unchanged. A new
  diagnostic, `payload_truncated`, and counter, `payloadsTruncated`, report cut
  payloads separately from omitted ones, and `payload_omitted` now names the
  `field` in its detail.
- **The refusals that happen before a route runs carry codes this API owns.**
  A body over the limit was `413 FST_ERR_CTP_BODY_TOO_LARGE`, a content type
  with no parser `415 FST_ERR_CTP_INVALID_MEDIA_TYPE`, and a body that is not
  JSON or is empty `400 FST_ERR_CTP_INVALID_JSON_BODY` or
  `FST_ERR_CTP_EMPTY_JSON_BODY`. Those are Fastify's vocabulary, and publishing
  them in a contract another implementation is meant to satisfy says that
  swapping the web framework is a wire change. They are now `payload_too_large`,
  `unsupported_media_type` and `malformed_json` (which covers both 400s: both
  mean the body could not be read, and the message says which). The HTTP
  statuses and the error body are unchanged, and the status is still what a
  client should branch on.
- **Both ingestion routes refuse a query parameter they do not know**, with
  `400 invalid_query` naming the key. `POST /v1/events` accepts none and
  `POST /v1/events/batch` accepts only `dryRun`. `?dryrun=true` was previously
  ignored and the batch stored, so a client believed it had validated events it
  had in fact written, which is exactly what refusing `dryRun` on the
  single-event route exists to prevent. Reading the name loosely would have
  rescued `dryrun` and not `dryRum`, and nothing legitimate adds a query
  parameter to ingestion. A client that appends one has to stop.
- **Three protocol error codes are gone.** `missing_required_field`,
  `invalid_timestamp` and `invalid_operation` were in the public list in
  `packages/protocol` and in `EVENT_PROTOCOL.md` section 12, and no code path
  ever sent one: a missing field, an unparseable timestamp and an operation
  outside the eleven all come back as `invalid_event` with the failing field in
  `details`. They are removed rather than reserved (ADR-049), because a registry
  that lists codes nothing sends tells the author of a client to branch on
  something that never arrives. Nothing observable on the wire changes. Code
  that imported `PROTOCOL_ERROR_CODES.missingRequiredField`,
  `.invalidTimestamp` or `.invalidOperation` no longer compiles; a client should
  treat any code it does not recognize by its HTTP status instead.
- **Bring your own database.** `DATABASE_URL` is required and points at the
  PostgreSQL your team already runs — the one somebody backs up, monitors, and
  can restore. The bundled database moves to
  `infrastructure/compose.bundled.yaml`, an overlay for evaluation and local
  work (ADR-037). An installation that used the bundled database should add
  `-f compose.bundled.yaml` to keep the same behaviour.
- **`infrastructure/compose.yaml` takes its keys from files.** `ENCRYPTION_KEY`
  and `ADMIN_TOKEN` come from `infrastructure/defaults.env` and then the
  repository-root `.env`, which wins. They used to be interpolated in
  `environment:`, which reads the shell and never the root `.env`, so a key set
  in `.env` as the README says never reached the API, the web app, or the demo
  bootstrap: they ran on the published defaults. `compose.published.yaml` is
  unchanged and still reads the shell.
- **The SDK's `Diagnostic` type is a union.** It is now
  `FailureDiagnostic | DeliveredFirstDiagnostic | InsecureEndpointDiagnostic`,
  for the new `delivered_first` kind, which carries `endpoint` and `accepted`,
  and `insecure_endpoint`, which carries `scheme` and `host`. Reading `kind`, `reason`, and
  `detail` compiles as before. TypeScript code must change if it switches over
  `kind` exhaustively with a `never` default, which now needs
  `delivered_first`, `insecure_endpoint`, and `payload_omitted` cases (the last
  a new `FailureKind`, which a payload over `maxPayloadBytes` reports instead of
  `dropped`), or if it builds a `Diagnostic` from a `kind` typed as
  `DiagnosticKind` with only `reason`, which must use `FailureDiagnostic` or
  `FailureKind` instead.
- **The SDK retries an event the server could not store for now.** A per-event
  refusal with a status of 500 or above (`storage_error`, `query_timeout`) was
  treated as permanent, so a database hiccup lost the event and reported it as
  `rejected`. That event is now sent again on its own with the transport's
  backoff, three times a send, and requeued for later sends while it is still
  refused, for up to 30 seconds from its first refusal or 10 sends, whichever
  comes first; only then is it given up and counted as `dropped`. Each send
  that ends with it refused reports a `transport_error`. Refusals below 500
  stay permanent. A send in which the server stored other events no longer
  counts toward the circuit breaker, so one unstorable event cannot pause
  delivery of the rest. The 30-second and 10-send bounds apply only to these
  per-event refusals: a whole request that fails (refused connection, timeout,
  or a 5xx for the request itself) is retried for as long as the outage lasts,
  bounded by the queue's `maxBufferedEvents`, whose overflow is dropped and
  counted.
- **SDK counters add up.** `sent + rejected + dropped` now equals the events
  recorded. A payload too large to capture is no longer counted as `dropped`,
  since its event is still sent with `[PAYLOAD_TOO_LARGE]` in its place; it has
  its own `payload_omitted` diagnostic and `payloadsOmitted` counter. `shutdown()` counts everything it could not deliver as `dropped`
  (events still refused for now, the queue left behind an unreachable endpoint,
  and a batch in flight when its timeout wins, whose request it aborts); these
  vanished before, 1,000 of 3,000 in one probe. A batch the server refuses
  outright counts one `rejected` per event rather than one per batch. A 2xx
  whose body is not JSON, has no results, or has fewer results than events
  counts each event without a result as `dropped` with reason `no_verdict` and
  does not resend it, because the server may have stored it; a body that was
  not JSON used to resend the whole batch and print the parser's message,
  which quotes the body. `shutdown()` also no longer holds the process open for
  the rest of its timeout after the drain finishes.
- **`delivered_first` names the endpoint's scheme, host, and port only**, not
  its path or query, which can carry a credential. Printed diagnostic lines also
  strip U+061C with the other bidirectional formatting characters.
- **A public `flush()` counts against `maxConcurrentSends`.** Its sends were
  not tracked, so a burst during a flush could exceed the cap by one set.

### Added

- **Instrumenting code can mark aliases displayable** (ADR-053). Every alias is
  still masked when read, except one whose type the recording event listed in
  the new optional `displayableAliases` field; it is shown in full only while
  every event that stated it listed it, so a later statement can mask it and
  nothing can unmask it. The SDK takes the list as
  `identify(aliases, { displayable })`, on `startJourney`, and as
  `displayableAliases` on `record()`. `GET /v1/journeys/:journeyId` and the dry
  run return each alias with a new `displayable` field, and the journey page
  marks masked values as masked. Stored in a new column,
  `entity_aliases.displayable`, by migration 017.
- **`recorder.journeyIdFor(entity)` derives a stable journey id** under a new
  `journeyIdSecret` option of at least 32 bytes (ADR-052), so the same record
  lands in the same journey on every run and machine while the id cannot be
  guessed from the entity. The environment is part of the derivation. It never
  throws: without a usable secret it reports a new `configuration_error`
  diagnostic, counts it in `configurationErrors`, and returns a random id. The
  derivation is SDK-55, with test vectors in
  `packages/protocol/fixtures/journey-id-derivation.json`. Rotating the secret
  starts new journeys.
- **`recorder.across(journeys)` records one operation on many journeys.** A
  digest written once for many records is one call:
  `recorder.across(journeys).persist("write-digest", digest, write)`. Each
  journey gets its own event and id, the events share one timestamp and
  duration, and the callback runs once with the wrappers' usual guarantees. A
  group has `record`, the four wrappers, `fail` and `finish`, and no `identify`.
  Nothing on the wire changes. `Journey` now extends a new `JourneyOperations`
  interface, which `JourneyGroup` extends too.
- **Wrappers can record a projection of what they wrap.** `captureInput` and
  `captureOutput` choose what is recorded while the wrapper still returns the
  callback's own value, so a step that returns a PDF can record
  `{ bytes: buffer.length }` and hand the caller the `Buffer`. `WrapOptions` is
  now generic in the callback's result, so `captureOutput` and `isFailure` see
  the resolved value with its type. A projection that throws or returns a
  promise records `[UNCAPTURABLE]` and a `payload_omitted` diagnostic with
  reason `projection_failed`, and never reaches the host. The conformance format
  gains two tags for it, `$projection` and `$throwingProjection`.
- **Dry-run validation.** `POST /v1/events/batch?dryRun=true` runs the whole
  batch and rolls it back, answering `200` with `data.dryRun: true` and the same
  per-event results a real send would have given. An accepted, non-duplicate
  result also carries `stored`: the event as `GET /v1/events/:eventId` returns
  it, without `receivedAt`, and the journey as `GET /v1/journeys/:journeyId`
  returns it, both read inside the transaction through the same presenters the
  read routes use. Nothing is written: no event, journey, alias, summary or
  audit row. The key's `last_used_at` still moves and a verifier under the
  previous key is still migrated, because a key a conformance job uses is a key
  in use. Dry-run events are not counted in the ingested-events metric. The
  parameter is strictly `true` or `false` and may be given once; anything else
  is `400 invalid_query`, and `POST /v1/events` refuses it outright rather than
  ignoring it, so a client that guessed the wrong route cannot store events
  while believing it validated them (ADR-050).
- **[`docs/SDK_SPEC.md`](docs/SDK_SPEC.md)**, what a recorder in any language
  must do: fifty numbered requirements in RFC 2119 wording, each with a source
  naming the decision or the document section it comes from, and each with
  either the conformance case that checks it or a place in section 13, which
  lists what no fixture can express and what a test for each has to do.
  `docs/NODE_SDK_SPEC.md` keeps its path and becomes the Node appendix, and is
  reconciled with what is actually built: the default batch size is 50 and not
  20, the queue policy is drop-oldest only, and `maxConcurrentSends`,
  `logDiagnostics`, `onDiagnostic` and `propagate` exist. It says nothing about
  header, queue attribute or environment variable names, which the rename will
  change; section 10 states only the propagation rules that survive it.
- **Conformance fixtures**, under
  [`packages/protocol/conformance/`](packages/protocol/conformance): thirty-seven
  `wire` cases and twenty-two `sdk` cases that any implementation can run
  through the dry run. A fixture change is a contract change (ADR-049).
- **[`docs/INGESTION_CONTRACT.md`](docs/INGESTION_CONTRACT.md)**, normative for
  the two ingestion routes and written for somebody building a client that is
  not this repository's Node SDK: the routes and authentication, the refusals
  that happen before a route runs, the limits with their configuration names and
  defaults, every per-event refusal with its status and whether to retry it,
  the two 409s, idempotency and the keyed content hash with its rotation
  consequence, what the server does to an accepted event, the dry run, and the
  conformance case format. Its limit table is asserted against the constants and
  its refusal tables against a registry in `packages/protocol/src/errors.ts`, so
  neither can drift. `API_SPEC.md` sections 3 and 4 are now a summary and a
  link, so one file owns ingestion (ADR-049).
- **Generated JSON Schema for the wire shapes**, under
  `packages/protocol/schemas/0.1/`, exported from the package as `./schemas/*`.
  Nine files in draft 2020-12, generated from the Zod schemas and checked byte
  for byte by a unit test, covering the event, the envelope, the batch request
  and response, one per-event verdict, the single-event 202, the error body, and
  the stored event and journey a dry run previews (ADR-049).
- **The SDK says when it is connected, when asked.** `logDiagnostics: true`
  writes each diagnostic to `console.error` as one `[flight-recorder]` line, at
  most one per kind per minute with a count of suppressed repeats, and a new
  `delivered_first` diagnostic reports the first batch the server stored
  anything from. Lines carry the kind and a masked, bounded reason, never a
  payload or a key; a refusal prints the server's error code and field path,
  and its message goes only to `onDiagnostic`. Off by default: nothing reaches the console unless it is
  set. The quick start and `examples/instrument-a-service` turn it on while
  setting up.
- **The SDK warns about an unencrypted endpoint.** An `http:` endpoint on a
  dotted name or an IP address sends the API key and payloads across a network
  in cleartext; the recorder now reports one `insecure_endpoint` diagnostic
  when it is created, naming only the scheme and host. It still starts and
  sends. `localhost`, `127.0.0.1`, `[::1]`, `.localhost` names, and
  single-label names such as `api`, which resolve only through container or
  cluster DNS, are not reported.
- **`maxConcurrentSends` in the SDK**, default 4 and clamped to 1-16: how many
  batches one process sends at once. Across every process sending to an
  installation, the total should stay under API instances times database pool
  size (10 per instance); past that, requests time out and are resent while the
  server finishes them. The SDK README's "Sizing `maxConcurrentSends`" says
  when to raise it.
- **What the SDK costs is measured.** `pnpm --filter @flight-recorder/node bench`
  reports added latency per wrapped call, heap and event-loop delay under
  sustained load, and throughput by send concurrency; the SDK README's "What it
  costs" has the numbers and the machine they came from.
- **An upgrade test gates every release.** `scripts/upgrade-test.mjs` builds
  the API at the previous release tag (`vMAJOR.MINOR.PATCH`; before the first
  release, main just before the key rotation merge), records journeys, aliases, a transformation diff, an
  error, and a replay destination with headers through it, then runs this
  build's migrations and API against the same database. Every recorded search
  and detail must read back unchanged, the old API key must authenticate and
  record its key id, `rotate:reencrypt` must convert the legacy values, and
  erasure and recent journeys must work on the old rows. The `upgrade-test` job
  runs it on release tags and schedules, and `publish-images` needs it.
- **Released images are signed and carry an SBOM.** `publish-images` pushes
  each image by digest, generates a CycloneDX SBOM per platform with Syft,
  attaches each as a cosign attestation, signs the images with Sigstore keyless
  signing from the pipeline's GitLab OIDC token, verifies them, and only then
  creates the version tag and `latest`, so a release whose signing failed has no
  tag. Release jobs run only for `vMAJOR.MINOR.PATCH` tags. The `sbom` job
  builds the images and keeps their SBOMs as artifacts on the default branch and
  schedules. How to verify a pulled image and extract its SBOM, and why `v*` tags
  must be protected before the first release, is in `docs/OPERATIONS.md` §11 and
  `SECURITY.md`.
- **`doctor` checks an installation and says what to fix.** One line per check,
  `PASS`, `WARN`, `FAIL` or `SKIP`: the database and its PostgreSQL version,
  pending migrations, published default secrets, stored data the configured
  keys cannot read, whether a project and an unrevoked key exist, and with
  `--api-key` and `--api-url`, whether a key authenticates (checked locally)
  and whether the API reports ready. Exits 1 when anything failed. It prints
  neither the database password, the admin token, the encryption keys, nor
  more of an API key than its prefix. In the API image beside `key:create`;
  `pnpm run doctor` from a checkout (`docs/OPERATIONS.md` §12).
- **A statement timeout.** `DATABASE_STATEMENT_TIMEOUT_MS`, 15000 by default,
  cancels any statement the API runs past it, so one runaway query, from a
  pathological search to a table scan behind a missing index, can no longer
  hold a connection ingestion needs. The request gets 503 `query_timeout`; the
  log names the route and never the query. `0` disables it. The database CLI
  does not apply it, and deletions lift it for their own transactions: each
  retention batch, and an admin's journey deletion, erasure, or destination
  deletion, is bounded by its batch size, and under the timeout a large
  retention batch failed on the same journeys every hour.
- **Deleting a journey no longer scans every replay run for each of its
  events.** `replay_runs (project_id, journey_event_id)`, the foreign key the
  cascade from `journey_events` looks up, had no index. Migration
  `016_replay_runs_event_index.js` adds it, built concurrently. A retention
  batch of 1,000 journeys with 200 events each, beside 5,000 replay runs, went
  from 41.6 seconds to 2.6.
- **Prometheus metrics, on their own port.** `METRICS_PORT`, unset by default,
  starts a listener serving `/metrics` and nothing else: request counts and
  durations by route pattern, events accepted, duplicate and rejected, query
  timeouts, pool connections, retention sweep outcomes and last success, the
  boot check's unreadable counts, memory and event loop lag. Compose and Helm
  do not publish it. No new dependency (ADR-047, `docs/OPERATIONS.md` §13).
- **Captured data can be deleted on demand.** Retention was the only way
  anything left the database, so a redaction miss stayed stored until it aged
  out and an erasure request had no answer. `delete:journey`,
  `delete:identifier`, `delete:range`, and `delete:destination` remove one
  journey, every journey matching an identifier, an environment's journeys by
  last activity, or a replay destination with its runs. The admin API has
  `DELETE /v1/journeys/:journeyId`, `POST /v1/erasures`, and
  `DELETE /v1/replay-destinations/:destinationId`, and a journey's page links to
  a confirmation that deletes it. Deletion is hard and admin-only; the selecting
  deletions have a dry run; every deletion writes its audit row in the same
  transaction, and an erasure's row holds the search token, never the value. An
  erasure or range deletion leaves journeys created while it ran for the next
  run, and marks its audit row `complete: false` if it stops part way. Deleted
  rows remain until vacuum and in earlier backups. The procedure is in
  `docs/OPERATIONS.md` §8 (ADR-045).
- **`GET /v1/journeys/:journeyId` includes the environment's name.**
- **Start from what failed, not from an identifier.** A Recent page, linked
  from the search heading, lists journeys by latest activity. It shows failed
  journeys from the last 24 hours by default, and can be filtered by status,
  window (an hour, a day or a week), environment and service. The filter is
  stated in words and the view is a shareable URL. The API behind it is
  `GET /v1/journeys` with a required `since` (`docs/API_SPEC.md` §6), and
  `GET /v1/projects` now names each project's environments. Migration
  `013_journeys_status_recent_index.js` adds two indexes for it, built
  concurrently so upgrading does not block ingestion while they build.
- **`ENCRYPTION_KEY` can be rotated without losing data.** Every encrypted value
  now names the key that wrote it, and `ENCRYPTION_KEY_PREVIOUS` holds the key
  being replaced while the new one takes over. Through that grace period old
  journeys still decrypt and still search, and every API key still
  authenticates, moving to the new key the next time it does.
  `rotate:reencrypt` moves the stored data across in resumable batches, and
  `rotate:status` exits 0 once nothing is left under the old key, which is when
  the previous key comes out. If it comes out early, the API still starts and
  logs how much it cannot read. The procedure is in `docs/OPERATIONS.md` §6
  (ADR-044). Compose, the Helm chart, and `.env.example` all pass the new
  variable through.

- **The timeline is interactive.** Filter a journey to one service or to its
  failures, and move through its events with the arrow keys while the detail
  panel follows without a reload. The address keeps `?event=` in step, so a
  copied link still opens the event you were reading. A Live toggle follows a
  journey that is still recording as its events arrive, and turns itself off
  once a finished journey goes six seconds with nothing new. The page renders
  the first hundred events, however long the journey, and a "Show N more events"
  button reads the rest. The first paint is still server-rendered and the rows
  are still links, so nothing that worked before stopped working. The browser
  talks only to two session-checked route handlers in the web app, never to the
  API, so the admin token stays on the server (ADR-029). Long diffs collapse to
  eight rows behind a button that shows the rest.

- **`project:create` and `project:list`.** A new installation had no projects
  and no way to create one: `key:create` requires a project, and the only two
  that could exist came from the two hardcoded seeds, neither of which the
  published stack ran. Following the quick start reached "No projects yet" and
  stopped. The published image already carries the CLI, so this needs no
  checkout:

  ```bash
  docker compose run --rm --entrypoint node api \
    packages/database/dist/cli.js project:create acme "Acme Payments"
  ```

- **Disk per event is measured, not guessed.** `scripts/measure-storage.mjs`
  ingests journeys of the demo's shape through the real ingestion code in each
  capture mode against a scratch database, and reports table and index sizes
  and what a retention sweep and VACUUM do to them. `docs/OPERATIONS.md` §10
  has the results (about 1.0 KB per event in `metadata-only` and 1.5 KB in
  `redacted-payload` for small payloads), what retention does to disk, and a
  sizing formula.
- Replay: destination management, request preparation and safety checks (exact
  host allowlist, DNS pinned to the resolved address, refusal of the cloud
  metadata range, a header blocklist, response caps and timeouts), the prepare
  and result UI, and the corrected demo endpoint. V0 reviews the payload before
  sending but does not allow editing it (ADR-032).
- **Ingestion.** `POST /v1/events` and `/v1/events/batch`, authenticated by an
  API key scoped to one project and environment, with server-side redaction,
  structural payload diffs, and idempotent duplicate handling.
- **Search and journeys.** Find a record by any identifier it is known by, then
  read its timeline across services. Alias search is independent of alias type,
  because a developer typing an identifier into a box does not know which type
  it was stored under.
- **Field-level transformation diffs**, which is the point of the product: the
  step where a value changed, shown as a field table rather than a text diff.
- **`@flight-recorder/node`**, the Node SDK. No runtime dependencies. Built so
  that a recorder failure cannot break the application it is recording.
- **Cross-process propagation** over HTTP headers and queue attributes, with
  three levels. The entity ID does not propagate by default; aliases never do.
- **The demo**, four services proving the reference journey end to end, and
  `pnpm test:demo`, which asserts all ten events, the diff, the retries, and the
  dead-letter state against a running stack.
- **Retention**, swept hourly inside the API process, per environment, behind an
  advisory lock.
- **API key lifecycle**: `key:create`, `key:revoke`, `key:list`.
- **Operations documentation** and a security disclosure policy.

### Security

- **The SDK is published with npm trusted publishing and provenance.** The
  `publish-sdk` job used a long-lived `NPM_TOKEN` and attached no provenance. It
  now exchanges a GitLab OIDC token for a short-lived publish token and signs a
  provenance statement, through `scripts/publish-sdk.sh`. The trusted publisher
  must be registered on npmjs.com before the first release
  (`docs/OPERATIONS.md` §11).
- **The Helm chart runs every pod locked down.** Non-root users (the images'
  `node` user, and uid 70 for the bundled PostgreSQL), `seccompProfile:
  RuntimeDefault`, no privilege escalation, all capabilities dropped, and a
  read-only root filesystem with emptyDirs for `/tmp`, the Next.js cache and the
  PostgreSQL socket directory. `networkPolicy.enabled`, off by default, adds a
  NetworkPolicy per pod limiting ingress to the HTTP ports and egress to DNS,
  the database and the API; replay destinations go in
  `networkPolicy.apiExtraEgress` (`deploy/helm/README.md`).
- **The stored content hash is keyed.** It covered the event as received,
  before masking, and was an unkeyed SHA-256, so anyone who could read the
  database could rebuild an event from its row with guesses in place of
  `[REDACTED]` and confirm a masked dictionary password by hash match; the
  security review did. It is now an HMAC-SHA256 under a subkey of
  `ENCRYPTION_KEY`, stored as `h1.<keyId>.<hex>`, and a resend is compared under
  the key the stored hash names (ADR-048).
- **Header credentials filed by position or inside a header block are
  redacted.** Name rules matched object keys only, so ordinary header shapes
  were stored verbatim in the default capture mode, through the SDK and through
  ingestion: fetch and undici header tuples (`[["Authorization", "Bearer …"]]`),
  Node's interleaved `rawHeaders` from HTTP/1.1 and HTTP/2, HAR and Playwright
  `{ name, value }` arrays, and the `_header` string of a `http.ClientRequest`,
  which axios puts on `error.request`. A built-in or `**.` name now also matches
  the name of a two-element `[name, value]` array element, of a `{ name, value }`
  or `{ key, value }` array element, a name in a flat string array that reads as
  a header list (HTTP/2 pseudo-headers included), and a `Name: value` line in a
  CRLF-delimited header block. A value that is itself a header name is kept.
  `SECURITY.md` §4 lists exactly which shapes are covered and which are not.
  Rows stored earlier keep what they held.
- **Searched identifiers no longer reach the API's log.** Fastify's request log
  line carried `req.url` whole, so every `GET /v1/search?q=…` wrote the searched
  value, usually a customer identifier, to the log at `info`, along with the
  Recent page's filters. Its not-found handler did the same in a line of its
  own and echoed the URL in its response. Request lines now carry the path and
  the parameter names, with every value replaced by `[REDACTED]`, and a request
  that matches no route gets the API's usual error shape, `404 not_found`,
  naming only the path. Logs kept from earlier versions still hold those values
  (`docs/OPERATIONS.md` §13).
- **A malformed request's bytes no longer reach the API's log.** A request
  Node's parser rejected was logged at `trace` with the parser's error, whose
  `rawPacket` is the request as received: its `Authorization: Bearer fr_…` key
  and its query string. Errors are now logged without that property, at any
  level and from any log call.
- **Built-in secret redaction now applies at any depth.** The shipped list paired
  each name with its `*.name` form, which together reached the top level of a
  payload and one level below it — and nothing inside an array, since an array
  with no matching `x[*]` rule was walked with no rules at all. A payload
  carrying `config.headers.authorization`, the shape every axios error has, was
  written to `journey_events.input_payload` as plaintext, in every capture mode
  and at both redaction points. Rules of the form `**.name` match a key name
  wherever it appears, and the built-in list is written entirely that way
  (ADR-035). The existing grammar is unchanged: a bare `authorization` still
  matches the top level only, and `*.password` still matches one below it.
- **Credentials inside error text are masked.** Redaction matched key names, so
  a password in a connection string or a token echoed in an error message was
  stored as written. The SDK now masks each error message before sending, and
  ingestion masks it again before storing, whoever sent the event. The masker
  recognises URL userinfo and Slack and Discord webhook URLs, `Bearer`, `Basic`
  and `Digest` credentials, values assigned to a secret name (including names
  like `DB_PASSWORD`, `STRIPE_API_KEY` and `x-auth-token`, read by their last
  words), JSON Web Tokens, PEM and PGP private keys, and provider-prefixed keys
  (Stripe, Slack, GitHub, GitLab, AWS, Google, OpenAI, Anthropic, npm,
  SendGrid, Hugging Face, and `fr_`). It does not guess at entropy, so an
  identifier is never masked and a credential in an unknown shape is not either;
  SECURITY.md §4 lists the other known misses. The SDK masks the first 8192
  characters of a message and then cuts the result to the protocol's 4096,
  ending in `[TRUNCATED]`. `metadata` and payload strings
  keep name-based redaction only (ADR-046).
- **Stack traces are stored only under full capture.** Ingestion drops
  `error.stack` unless the environment's capture mode is `full-payload` and
  `ALLOW_FULL_PAYLOAD_CAPTURE` is set, and masks a stack it keeps. The Node SDK
  never sent one; a client that did loses it below full capture.
- **A replay is never sent without its destination's headers.** Headers that
  could not be decrypted used to come back as an empty set, so the replay went
  out without the credentials the destination was configured with. It is now
  refused, recorded as blocked with the reason and the key id involved, and
  audited as `replay.blocked`.
- **A replay no longer stores its destination's header values.** Destination
  headers are encrypted at rest, but every replay copied the decrypted values
  into `replay_runs.request_headers` as plain `jsonb`, and
  `GET /v1/replays/:replayId` returned them, so any configured credential was
  readable in the clear in every run sent to that destination. A run now stores
  each destination header, and any header on the blocklist, by name with the
  value `[REDACTED]`; the request itself still carries the real values. The
  replay result page lists the headers and says a redacted one was sent with
  its real value. A destination that echoes its request no longer puts the
  values back: each destination header value of 8 or more characters is
  replaced with `[REDACTED]` in the stored response body and error message.
  That is exact matching, so a shorter value, a fragment left where the
  response size cap cut the body, and an encoded echo are not caught, and
  responses stored before the upgrade are not scrubbed. Migration
  `015_redact_replay_run_headers.js` rewrites rows
  written before the upgrade, replacing every header value with `[REDACTED]`.
  Backups, WAL archives, and replicas taken before the migration still hold the
  values; see the upgrade note.
- **A replay destination's audit row no longer records its base URL.** A base
  URL can carry credentials or an internal hostname, audit rows are never swept,
  and deleting the destination could not reach the row. Rows written before this
  change keep the URL; `docs/OPERATIONS.md` §8 has the statement that strips it.
- **An API key can no longer write into another environment's journey.** A
  journey's environment was set by whichever environment wrote it first, and
  events and aliases attached by journey id alone, so a development key could
  mark a production journey failed and add a searchable alias to it, or create a
  journey id production later wrote into and read production's aliases through
  it. Ingestion now refuses such an event with 409
  `journey_environment_mismatch` and stores nothing for it (ADR-038). `doctor`
  gains a `Journey environments` check that fails when an earlier build already
  stored events across environments; `docs/OPERATIONS.md` §12 lists them.
  The check holds the journey row `FOR KEY SHARE`, which keeps a deletion out
  and does not queue other events for the same journey behind it. Journey ids
  an application chooses itself must now be unpredictable, since a key for
  another environment that records a guessable id first owns it, and a journey
  id propagated from one environment to another is refused
  (`docs/EVENT_PROTOCOL.md` §4).
- **The project picker is no longer an open redirect.** Its return path was
  checked before normalisation and used after it, so `/.//evil.test/phish`,
  `/..//evil.test`, `/%2e//evil.test` and `/./\evil.test` passed as local paths
  and came back as a redirect to `http://evil.test`. A path that normalises to
  two leading separators is now refused, the result is checked again against a
  second origin, and every redirect the web app builds is held to its own host.
- **No response carries a PostgreSQL SQLSTATE as its error code.** An
  unstorable payload (a NUL byte, or an unpaired surrogate sent as a JSON
  escape) sent to `POST /v1/events` answered 500 with `error.code` `22P05`,
  while the batch route answered 400 `unstorable_payload`; both now answer the
  latter. `GET /v1/replays/<not a uuid>` is 404, and `POST /v1/replays` with no
  body, a non-string field, or a `destinationId` that is not a uuid is 400
  `invalid_request`, where each was a 500 with `22P02`. A repeated `q` or
  `cursor` is 400. Any other unexpected failure is 500 `internal_error`. A null
  byte in a read route's path id is 404, in `q`, `environment` or `service` 400
  `invalid_query`, in any cursor 400 `invalid_cursor`, and in a replay
  destination's name or base URL 400 `invalid_request`; an event cursor with a
  timestamp PostgreSQL cannot cast is 400 too, as is any cursor timestamp outside
  years 0001 to 9999. `durationMs` above 2147483647,
  which fits no `integer` column, is refused by the protocol schema as
  `invalid_event`, where it was a 500 on the single route and a per-event 500 in
  a batch that the SDK resent.
- **Admin token guesses are throttled at the API, and the web login's limiter
  can no longer be sidestepped.** The login limiter keyed on `X-Forwarded-For`,
  which the client writes, so a new value per guess was never throttled. It now
  keys on the socket address. The API, which compared the admin token without
  any limit, now counts failed authentication per source address on every route
  that accepts the token and answers `429 too_many_attempts` after five failures
  in a minute, for five minutes; the `401` for an ordinary failure is unchanged
  and ingestion is not throttled. A new setting, `TRUSTED_PROXY_COUNT` (default
  0), on both, honours `X-Forwarded-For` that many hops from the right for
  installations behind a reverse proxy (`docs/OPERATIONS.md` §9). The web login
  checks its lock after reading the form, so a burst of guesses there gets
  exactly five comparisons; the API counts refusals, so a concurrent burst of bad
  API keys can have up to its own size looked up before the lock takes effect
  (the next request is refused). An IPv6
  address counts as its /64, and every spelling of one address (a port, brackets,
  an IPv4-mapped form) counts as that address. Each throttle remembers at most
  50,000 addresses, forgetting the one that failed least recently, in a map and a
  linked list rather than a map's insertion order, and sweeps expired entries at
  most once a minute, so neither memory nor the cost of a failure grows with the
  number of addresses or requests seen.
- **`Authorization: Bearer <token> extra` is refused.** Everything after the
  token was ignored, so the header authenticated as the token alone, for the
  admin token and API keys alike. The header must now be the scheme, one space,
  and the token; anything more is `401`.
- **Sign-in works behind a TLS proxy that sends no `X-Forwarded-Proto`.**
  Redirects after a form post named an absolute URL built from `Host` and
  `X-Forwarded-Proto`, so behind a proxy forwarding `Host` alone they pointed at
  `http://`, and `form-action 'self'` blocked the redirect: sign-in, choosing a
  project, replay and delete all failed. Every such redirect is now a 303 with a
  path-only `Location`, still refused anything that would leave the host
  (`docs/OPERATIONS.md` §9 lists the headers a proxy should pass).
- **The web interface sends a Content-Security-Policy and the usual security
  headers.** Every page carries a policy allowing scripts only from its own
  origin and by a per-response nonce, with `frame-ancestors 'none'`,
  `base-uri`, `form-action` and `style-src` all `'self'`, and `object-src
  'none'`; every response carries `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`, and
  `X-Powered-By` is gone. The production build inlines scripts, so the nonce is
  set in middleware rather than allowing `'unsafe-inline'`, and the not-found
  page is rendered per request so it gets one. A browser test fails on any
  policy violation. Under `next dev` only, the policy also allows `eval` and
  inline styles, which React's development build and the dev overlay need.
- **Replay's default allowlist no longer reaches the Docker host.**
  `compose.published.yaml` and the Helm chart defaulted `REPLAY_ALLOWED_HOSTS`
  to `localhost,host.docker.internal`, and `host.docker.internal` reaches every
  service on the Docker host. Both now default to `localhost`. The development
  stack and `values-local.yaml` keep `host.docker.internal`. The allowlist is
  the control that keeps replay from being a request forgery tool, and
  `docs/OPERATIONS.md` §9 says how to set it; see the upgrade note.

### Fixed

- **The SDK conformance harness decodes a request body as a stream.** It
  decoded each chunk on its own, so a two-byte character split between two
  chunks arrived as two replacement characters and a string the SDK had cut to
  the limit reached the dry run one code unit over it.
- **A header entry carrying a third field no longer hides a credential.**
  Redaction read `{"name": "authorization", "value": "Bearer …"}` as a header
  and replaced the value, but only when the object had *exactly* those two
  keys. A third key made it an ordinary object: nothing on it is named a secret,
  so `{"headers": [{"name": "authorization", "value": "Bearer …", "other": 1}]}`
  was stored in the clear, in the SDK and at ingestion alike. HAR's own header
  object allows a `comment` beside `name` and `value`, so this was a shape real
  clients produce. The rule now applies to any plain object with a string `name`
  or `key` beside a `value`; only the value is replaced and every other field is
  kept. The protections that actually prevented false positives are unchanged:
  the name must be a string, it must normalise to a name somebody called a
  secret, and a value that is itself a known header name is still left alone, so
  a list of header names is not rewritten. **Rows written before this are not
  changed by it.** An installation that captured payloads in this shape should
  treat those rows as holding the credential, rotate what they hold, and use
  `delete:journey` or `delete:range` (ADR-045) to remove them; redaction is
  applied on the way in and never rewrites history.
- **A payload carrying a `__proto__` key is ingested instead of refused.** The
  whole request came back `400` "Body is not valid JSON but content-type is set
  to 'application/json'" about a body that is valid JSON, because Fastify parses
  with `secure-json-parse`, whose defaults throw on `__proto__` and on
  `constructor.prototype` anywhere in the document. The SDK preserves a
  `__proto__` key on purpose, and treats a 4xx as permanent, so a customer
  payload holding one cost the whole batch and was never resent. Both checks are
  now off: the danger was never the parsing, which leaves the object's prototype
  alone, but assigning a parsed key onward, and every walk here writes with
  `Object.defineProperty` instead. `Object.prototype` is asserted untouched
  after both bodies are ingested.
- **`__proto__` survives parsing in `aliases` and in `metadata`.** Zod's
  `z.record` assigns parsed keys onto a fresh object, so those two fields lost
  theirs while `input` and `output` kept theirs, which is why a reader saw the
  key in a payload and not in the alias it was filed under. The key is now
  restored after parsing. `z.record` also does not validate that key's value:
  an `aliases` entry of `{"__proto__": {"nested": true}}` used to parse
  successfully, and is now refused as `invalid_event` like any other alias value
  that is not a string.
- **Two demo stacks with different `-p` names no longer share an image.** The
  demo services were tagged `flight-recorder-demo:local` whatever the project
  name, so a second checkout's build replaced the first's image. The tag now
  starts with the Compose project name.
- **The browser suite runs against the demo stack.** On a database with more
  than one project, every signed-in spec landed on the project picker instead of
  the page it tested, and 13 of 18 failed. Each spec now chooses the project its
  key wrote to, and `docs/LOCAL_DEVELOPMENT.md` lists the variables the suite
  needs.
- **The instrument-a-service example runs from a clean clone.** Its README
  skipped building the SDK its `file:` dependency points at, migrating the
  stack, and creating the project, and it pointed at `pnpm db:seed`. It now
  lists every step, and says to set `FLIGHT_RECORDER_URL` and
  `FLIGHT_RECORDER_WEB` when the stack's ports move.
- **The Helm chart's default image is one a release publishes.** It defaulted
  to the bare `appVersion`, `api:0.1.0`, while a release pushes the git tag,
  `api:v0.1.0`, so the default values could not pull. The default is now `v`
  plus `appVersion`, and CI renders the chart and compares.
- **doctor warns while the published demo key is active.** The demo stack's key
  is committed to the repository, so anyone can write events with it, and doctor
  passed an installation where it was unrevoked. "Projects and keys" now warns
  and names `key:revoke fr_demo00000`.
- **Migrations run as a role with privileges on its schema alone.** Migration
  001 created the `pgcrypto` extension, which nothing used and which needs
  `CREATE` on the database, so such a role failed at the first migration with a
  stack trace. The statement is removed. A database that already has the
  extension keeps it, and nothing reruns. PostgreSQL 15 or later is the stated
  requirement.
- **doctor names a missing schema grant instead of pending migrations.** A role
  without `USAGE` on the schema holding the tables cannot see
  `knex_migrations`, and doctor reported every migration pending on a current
  database. It now fails the check with the `GRANT USAGE ON SCHEMA` that fixes
  it.
- **The published install's commands work with the bundled overlay.** The
  install added `-f compose.bundled.yaml` to start the stack and then showed
  every later command naming only the published file, which failed and
  suggested `--remove-orphans`, a flag that removes the PostgreSQL container.
  The install now exports `COMPOSE_FILE` once, and every command after it is a
  plain `docker compose`.
- **The documented doctor command runs doctor.** pnpm 11 has a built-in
  command of the same name, which answered the documented form with a report on
  the pnpm installation and exit 0, and the root script failed with
  `Unknown option: 'recursive'`. The command is `pnpm run doctor`, and every
  root script now filters into its package with `run`.
- **`cp .env.example .env` no longer empties the interface.** `.env.example`
  set `PORT=8080`, the web container reads the root `.env`, and Next listened on
  8080 inside it, so `localhost:3000` answered nothing. The web service now pins
  `PORT` to 3000, and `.env.example` no longer sets `PORT`.
- **Search is fast at a million journeys.** It walked every journey in the
  project and probed its events and aliases, which took about 1.5 seconds at
  120,000 journeys and 20 seconds or more at a million, whatever the value. It
  is now one index lookup per kind of identifier, joined to the journeys that
  match, with identical results and cursors. A value matching a few journeys
  takes well under a millisecond at either size. A value matching thousands
  still scans the project's journeys to join them, 64 ms for 20,000 matches at
  a million. Migration `014_search_indexes.js` adds the one index that lookup
  lacked, on span id, built concurrently so upgrading does not block ingestion.

The eight defects and seven smaller findings from the 2026-08-09 first-contact
audit, all merged the same day. The pattern behind them is written up in
[docs/WHAT_RUNNING_IT_FOUND.md](docs/WHAT_RUNNING_IT_FOUND.md).

- **The SDK reports what the server actually stored.** The batch route replies
  202 with a per-event verdict; the SDK checked only the HTTP status, so an
  `environment` typo produced `sent: 4`, no diagnostics, and an empty database.
  It now counts only accepted events and reports each refusal with the server's
  own message under a new `rejected` counter, kept separate from
  `transport_error` because a rejection is never retried.
- **`operation` is a typed union**, exported as `Operation`. A plausible verb
  like `"created"` used to compile, be refused, and vanish from the timeline.
- **A `Date` survives redaction, and a shared reference is not a change.**
  Redaction rebuilt objects from `Object.entries`, so every `Date` became `{}`
  on both sides of a transformation and a renewal that moved an expiry by a year
  diffed as "No fields changed". The cycle check never forgot a visited object,
  so two fields pointing at one address reported the second as `[CIRCULAR]`.
  Anything with a `toJSON` now serialises itself and the result is still walked;
  the cycle check holds only the ancestor chain.
- **One bad value no longer stops a service's telemetry.** A 4xx was retried
  like a 5xx, drove the breaker open, and put the batch back at the front of
  the queue, so one malformed payload blocked every event behind it for the
  life of the process. A 4xx is permanent now. NUL bytes and lone surrogates
  are repaired before they leave the SDK, a poisoned event is rejected alone
  rather than failing its batch, `metadata` passes through capture, `batchSize`
  is clamped to the server's ceiling, and a PostgreSQL error code no longer
  reaches the client as the API's error code (`unstorable_payload`).
- **Flushes are awaited and bounded.** `flush()` and `shutdown()` waited on
  nothing, so counters were read before the send finished and the last batch
  was lost on `process.exit`. A burst of 1,000 records opened 200 sockets and
  posted every event three times; at most four sends run at once. `shutdown()`
  reports an event recorded after it as dropped instead of discarding silently.
- **The timeline shows the whole journey.** The web layer hardcoded `limit=100`
  and discarded the cursor, so the hundred oldest events rendered and the
  dead-letter event you opened the page for was absent, under a header stating
  the true count. The page now follows the cursor, loading the rest of a long
  journey on request, and the count line says how many of the total are
  showing. Every row now carries a full UTC timestamp, the date appears
  when a journey spans more than one day, and an event whose recorded time is
  more than two minutes from its arrival carries a clock warning.
- **No blank 500s.** An API that was still booting rendered a blank page whose
  only text was "Flight Recorder". An error boundary explains the likely cause,
  and a 401 says the token does not match rather than "unreachable".
- **Propagation cannot kill the host.** The six propagation helpers were the
  only public entry points outside the failure boundary, so
  `injectHttpHeaders({}, extractHttpContext(req.headers))` killed the process on
  the first un-instrumented caller. Injected values are validated on the way
  in as well as on the way out.
- **A failure always registers.** A failed event stamped earlier than the
  journey's watermark left the journey `active` with a failure in its own
  timeline, which ADR-031 made the common case rather than a race.
- **`maxPayloadBytes` scales the string limit with it**, a discarded payload
  emits a diagnostic, and the event detail no longer claims "No fields changed"
  when neither side was captured.
- **Wrappers preserve the shape of their callback.** Every wrapper was async, so
  wrapping a synchronous call inside a synchronous handler changed its control
  flow: a handler that correctly returned 400 became a 200 with an empty body
  and an unhandled rejection. A synchronous callback now returns and throws
  synchronously, and the types carry overloads that say so.
- **`Map`, `Set`, `Error`, `RegExp`, `Headers` and `URLSearchParams` keep their
  contents.** All six store their data in internal slots, so the rebuild that
  makes redaction possible turned each into `{}` — including an `Error`, whose
  `name` and `message` are the two fields a reader most needs. They are now
  rendered inside the redaction walk, so redaction reaches into them, and the
  size guard measures them (ADR-036).
- **Cyclic and `BigInt` payloads are stored rather than discarded.** Both were
  reported as `payload_too_large`, which sent operators to a setting that could
  not help. A cycle becomes `[CIRCULAR]` and a `BigInt` its decimal string; a
  genuinely unserialisable value now reports `unserialisable_payload` (ADR-034).
- **A `__proto__` key in a payload survives.** `JSON.parse` makes it an ordinary
  own key, and rebuilding with assignment spent it on the object's prototype, so
  the field disappeared from the recorded payload.

### Upgrade notes

- **Migration 017 adds a column to `entity_aliases`.** It is a catalogue change
  on PostgreSQL 11 and later and finishes at once, but it gives up after five
  seconds if a long transaction holds the table, rather than stalling ingestion
  behind it. Run `migrate` again if it does (docs/OPERATIONS.md section 4).
- **Conformance cases are loaded in order of id**, not of file name. The two
  differ once one case's name extends another's (`identify-displayable` and
  `identify`), and a harness comparing with the manifest has to sort the same
  way.
- **`REPLAY_ALLOWED_HOSTS` defaults to `localhost` in `compose.published.yaml`
  and the Helm chart.** An installation that replays to `host.docker.internal`
  without setting the variable must now set it
  (`REPLAY_ALLOWED_HOSTS=localhost,host.docker.internal`, or
  `api.replayAllowedHosts`); replays to it are otherwise refused with
  `host_not_allowed`.
- **Content hashes need no migration.** Rows written before this release keep
  their unkeyed hash, and a resend is still compared against it, so a delivery
  that straddles the upgrade dedupes. Those rows remain an oracle for what they
  masked until they are deleted or retention removes them. After a key rotation
  completes, a duplicate delivery of an event recorded under the removed key is
  answered 409 `event_id_conflict`, which the SDK treats as permanent; the stored
  event is unaffected.
- **Migration 015 rewrites every replay run row.** It replaces each value in
  `replay_runs.request_headers` with `[REDACTED]` in one transaction (about 2
  seconds for 100,000 runs, blocking updates to existing runs but not inserts,
  and doubling the table's size until vacuum), including
  the headers Flight Recorder set itself, because an old row cannot say which
  came from the destination. Its down migration does nothing. It does not reach
  a backup taken before it, which still holds destination credentials; rotate
  any that matter at the destination (`docs/OPERATIONS.md` §4).
- A payload holding any of the values above now hashes differently, and
  `contentHash` is computed over what the SDK sent. Resending the same event id
  from a mixed-version fleet mid-rollout returns 409 `event_id_conflict`.
- A `Map` that measured as `{}` may now exceed `maxPayloadBytes` and record
  `[PAYLOAD_TOO_LARGE]` with a `payload_omitted` diagnostic. That is the size
  guard seeing the data for the first time, not a regression.
- **A client that sends `error.stack` stops having it stored** unless the
  environment uses `full-payload` on an installation with
  `ALLOW_FULL_PAYLOAD_CAPTURE`.
- **Rows written before the upgrade are not masked retroactively.** Their error
  messages and their stacks stay exactly as they were stored, including any
  credential in them. Masking applies to events ingested after the upgrade.
  To remove them, delete the affected journeys, every journey matching an
  identifier, or an environment's time window (`docs/OPERATIONS.md` §8,
  ADR-045).
- Redaction reaching further means more `[REDACTED]` than before. If a key name
  on the built-in list appears somewhere it is not a secret, scope it with a
  dotted path in your own `redact` list.
- **Keys are trimmed of surrounding whitespace.** An `ENCRYPTION_KEY` that was
  configured with surrounding whitespace, usually a trailing newline, derives different keys after this upgrade,
  so data written before it stops decrypting and every API key issued before it
  answers 401. No setting reads that data afterwards: `ENCRYPTION_KEY_PREVIOUS`
  is trimmed the same way. A trailing newline does not come from a `.env` line;
  it comes from a secrets file, such as a Kubernetes secret created with
  `--from-file` from a file that ends in one.
  Check before upgrading:

  ```bash
  kubectl get secret <name> -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d | od -c | tail -2
  ```

  A `\n` before the final offset means the key has one.
- **Shell exports no longer reach `infrastructure/compose.yaml`.** A stack that
  was configured with `export ENCRYPTION_KEY=…` now starts on the published
  defaults instead. Move the values into the repository-root `.env`. After
  changing keys, recreate the containers with `docker compose … up -d`;
  `docker compose restart` does not re-read `env_file`.
- **Values written before this release carry no key id.** They read as before.
  `rotate:status` counts them as legacy and exits 1 until they are rewritten.
  Run `rotate:reencrypt` once with only `ENCRYPTION_KEY` set: with no previous
  key it upgrades legacy values the current key opens into the new format, under
  the same key, and `rotate:status` then exits 0. API keys issued before this
  release show `key id not recorded yet; recorded on next use` and do not hold
  the exit code at 1 unless a rotation is under way.
- **This release cannot be rolled back once it has written `fr1.` values.** An
  earlier build cannot read them, and it would send replays without their
  destination headers. To roll back, restore the backup taken before upgrading.

### Known limitations

- The admin token is a single shared secret with no user accounts and no record
  of who used it.
- Propagated journey context is validated for shape but is not authenticated.
- Of the five verbs in the product promise, **changed** and **rejected** are
  demonstrated end to end. Duplication and loss are not yet first-class.
