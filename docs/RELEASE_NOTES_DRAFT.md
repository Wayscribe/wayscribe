# Wayscribe 0.1.0 preview: release notes

**Released 2026-09-20.** The protected `v0.1.0` tag points to
`f6707c66ea2697a199871a4ef4263e52aa34c11c`. The
[GitLab release](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0)
links the pinned Compose files, `@wayscribe/node@0.1.0`, and the four platform
SBOMs. The exact pipeline jobs, provenance, image and SBOM digests, public
installation checks, and limitations are in the
[release verification](reviews/2026-09-20-release-verification.md). The full
list of changes is in [CHANGELOG.md](../CHANGELOG.md).

## What it is

Wayscribe records what happened to one business record, such as a
customer, an order or an invoice, as it moves through your services, and shows
the step where its data changed. It is self-hosted, stores everything in a
PostgreSQL database you run, and needs no account or hosted service.

This is a preview. Before 1.0 a minor release may change the API; a patch
release will not.

## The name

The product took the name Wayscribe on 2026-09-17, before anything was
published (ADR-057). Anyone running a development build
from before then needs the new names, with no aliases for the old ones: the
`@wayscribe/node` package, the `wayscribe` CLI, the `x-wayscribe-*` headers,
the `wayscribeJourneyId`, `wayscribeEntityType` and `wayscribeEntityId` queue
attributes, the `_wayscribe` envelope key, the `WAYSCRIBE_*` environment
variables, the `wayscribe_*` metrics and `Wayscribe*` alert rules, the
`registry.gitlab.com/jojithedev/wayscribe` images, and `wayscribe` as the local
database user and name. New API keys start `wsk_`. Stored data stays readable
and keys issued before the rename, which start `fr_`, keep working. The
[CHANGELOG](../CHANGELOG.md) has the full table.

## What is in this preview

### Recording and the SDK

- **`@wayscribe/node`**, a Node SDK with no runtime dependencies. The
  wrappers (`transform`, `persist`, `publish`, `deliver`) run your code, return
  its value unchanged, rethrow its exact error, and record what went in and what
  came out. A synchronous callback stays synchronous.
- **A recorder failure never reaches your code.** The queue is bounded and drops
  the oldest events under pressure, sends retry behind a circuit breaker, and
  `shutdown()` is bounded by a timeout. `counters()` reports what happened, and
  `sent + rejected + dropped` equals `recorded` after `shutdown()`.
- **Each event is fitted to the server's limits** before it is sent, by the same
  check ingestion runs, so an oversized payload is cut or replaced before
  sending. Capture limits, transport failures and server refusals can still
  prevent storage; the counters distinguish those outcomes.
- **Journeys can carry more than an id:** aliases (other identifiers the record
  answers to), a public label, a stable id derived from the entity under a
  secret you hold (`journeyIdFor`), and one operation recorded on many journeys
  at once (`across`).
- **Context crosses process boundaries** over HTTP headers, SQS message
  attributes or a payload envelope. The entity id is not propagated by default,
  and aliases never are.
- **Diagnostics go to `onDiagnostic` and counters; printing is opt-in.**
  `logDiagnostics: true` prints at most one line per kind a minute, including
  `delivered_first` when the server first stores a batch. A few problems print
  regardless: a missing or unusable required setting, an unusable optional
  setting, a renamed option, a missing journey-id secret, a secret-looking
  field name no redaction rule covers, and personal data in a public label,
  displayable alias or error message. Personal-data warnings print once per
  process, field and shape. Each diagnostic has a stable `code` to match on.
- **Events identify their recorder and deployment.** The SDK stamps its own
  name and version, and accepts a deployment commit, version and image.
  Drop counters name the cause; zero transport errors and zero `no_verdict`
  drops alone do not establish collector health.
- **What it costs is measured.** On 2026-09-19 UTC (2026-09-18 local), on a
  shared Apple M3 Pro host, wrapping a call with a 1 KiB payload against a
  local stub added 76.3 µs p50 / 1,208.6 µs p99 for `transform` and 28.5 /
  452.3 µs for `persist` when the run included idle periods. In the separate
  core-awake scheduler experiment, the figures were 37.0 / 575.0 µs and 21.8 /
  400.6 µs. At 2,000 wrapped calls a second for a minute, heap after collection
  went from 9.3 to 9.4 MiB and resident set ended at 196 MiB against 65 MiB
  unwrapped (SDK README, "What it costs"). The normal and awake source heads
  had the same SDK and protocol trees. The host ran other services, so these
  are orders of magnitude, not production latency guarantees. Against a slow
  collector the bounded queue dropped events in the measured 1 KiB cases;
  capture did not wait for the 200 ms response.
- **A contract for other clients:** [the ingestion contract](INGESTION_CONTRACT.md),
  [the SDK specification](SDK_SPEC.md), generated JSON Schema, and conformance
  fixtures that any implementation can run through the dry run.

### The server and storage

- **Ingestion** over `POST /v1/events` and `POST /v1/events/batch`, with API keys
  scoped to one project and one environment, redaction applied again on the
  server, field-level diffs computed when an event is stored, and idempotent
  handling of duplicates. `?dryRun=true` on the batch route validates events and
  stores nothing.
- **One PostgreSQL database is the only backing service**, and you bring it
  (`DATABASE_URL`). A bundled database is available as a Compose overlay for
  evaluation. Entity identifiers and alias values are encrypted at rest and
  searched through keyed tokens.
- **Disk use is measured.** The current 2026-09-19 run at source `9da8b37`
  recorded 100,000 events per capture mode on PostgreSQL 17.11 in a 2 CPU,
  3 GiB aarch64 container with tmpfs. It measured 1,217 bytes per event in
  `metadata-only` and 1,655 in `redacted-payload`, or 944 and 1,377 after
  compaction. It completed all four modes without triggering its storage
  guard. This smaller, shared-host tmpfs run is not physical-disk or production
  capacity evidence. The historical 2026-09-15 million-event run measured
  1,049 and 1,494 bytes per event for those modes and remains the basis for the
  worked 63 GiB sizing example (OPERATIONS section 10, "Measured disk per
  event" and "A formula").
- **Migration 019 keeps its session state on one PostgreSQL connection.** The
  2026-09-19 repair at `9da8b37` transfers the bound session used to set
  `search_path` through the concurrent index build and teardown, and has
  regression coverage for non-default schemas.
- **Installs** as a Compose stack, which runs the release you name in
  `WAYSCRIBE_VERSION`, or with a Helm chart for a local single-node
  cluster.

### Finding a record

- **Search** by any identifier the record is known by, independent of the type
  it was stored under. At a million journeys, a value that matches a few
  journeys takes about 0.1 ms, and one that matches 20,000 took 64 ms for an
  API key scoped to one environment, measured on 2026-09-15 on PostgreSQL 17
  (OPERATIONS section 10, "Indexes").
- **The Journeys page** lists what happened in a period, filtered by status,
  entity type, environment, service, and part of a journey's label or of an
  alias marked displayable, with a Failures shortcut. The current 2026-09-19
  run at source `9da8b37` used 120,000 journeys on a shared Apple M3 Pro host
  and PostgreSQL 17.11 in a 2 CPU, 3 GiB aarch64 container with tmpfs. With a
  warm cache and network time excluded, the default admin 24-hour list
  measured 6.7 / 14.1 ms p50 / p95. Text matching nothing over 30 days, the
  worst case, measured 483.3 / 594.2 ms with 89,845 journeys in the window
  (OPERATIONS section 10, "Listing journeys").
- **The timeline** shows every event of a journey across services. It can be
  filtered to one service or to failures, navigated with the arrow keys, and set
  to follow a journey that is still recording. Rows name recorded deployment
  versions and commits. Event detail shows the aliases that event stated,
  preserving masking and distinguishing an empty list from older events whose
  aliases were not recorded. Failed journeys identify the failed step.
- **Per-record timing** names the measured span between operation starts,
  queue wait and processing time, application attempt and retry group, broker
  delivery count, HTTP target and status, and requested retry delay. Unknown
  measurements are absent rather than shown as zero. Initial-enqueue wait is
  reported only for the first broker delivery; later deliveries require an
  explicit ready instant. Cross-host elapsed values are labelled with the
  clock qualification.
- **Timing filters** find journeys by total span, slowest step, active
  inactivity and retry state. Filtered timelines keep the original loaded
  neighbors so a hidden row cannot turn two nonadjacent steps into a measured
  gap. Their 2026-09-18 query-plan evidence used a separate 20,000-journey,
  60,000-event data set; the 120,000-journey list run did not remeasure them.
- **The diff** shows, field by field, what a step received against what it
  produced.
- **Replay** sends a step's recorded input to a configured development
  destination and diffs the result against the original.
- **A read-only CLI** (`search`, `journey`, `event --diff`, `projects`, with
  `--json`).

### Operating it

- **`doctor`** checks the database, migrations, default secrets, keys, stored
  data the configured keys cannot read, journeys written across environments,
  and secret-looking names in stored payloads, and prints the fix for anything
  that fails ([OPERATIONS section 12](OPERATIONS.md#12-checking-an-installation)).
- **Prometheus metrics** on a separate port, off unless `METRICS_PORT` is set,
  and a statement timeout that keeps one slow query from holding a connection
  ingestion needs (OPERATIONS section 13).
- **Key rotation** for `ENCRYPTION_KEY` through a grace period, with
  `rotate:reencrypt` and `rotate:status` (OPERATIONS section 6).
- **Deletion on demand** of a journey, every journey matching an identifier, a
  time window, or a replay destination, admin-only and audited without the value
  (OPERATIONS section 8). Issuing and revoking an API key are audited too
  (SECURITY section 13).
- **Retention** per environment, swept inside the API process (OPERATIONS
  section 7).
- **Upgrades** are gated on a test that records data with an earlier build and
  reads it back with the new one (OPERATIONS section 4).
- **Release provenance, signatures and SBOM attestations are verified.** The
  `v0.1.0` release pipeline published the SDK with npm provenance tied to the
  release commit. It signed both multi-platform image indexes and their
  linux/amd64 and linux/arm64 manifests with Sigstore, with a verified signed
  CycloneDX SBOM attestation for every platform (OPERATIONS section 11,
  [release verification](reviews/2026-09-20-release-verification.md)).
- **The protected-tag pipeline is green at `f6707c6`.** Pipeline
  [`2865565660`](https://gitlab.com/jojithedev/wayscribe/-/pipelines/2865565660)
  passed 23 jobs: 3,422 unit tests, 979 integration tests on each of PostgreSQL
  15, 17 and 18, 796 SDK tests on each of Node 22.12.0 and 24, two 71-test
  browser runs, the upgrade test, and the 7-test release demo among its gates.
  The ordinary duplicate manual `demo` job was not run; `release-verify` ran the
  release gate's same seven acceptance tests.
- **The public install was exercised from distributed artifacts only.** An
  isolated directory on an existing ARM64 macOS Docker host downloaded the
  tagged Compose files, pulled the public images, installed the SDK from npm,
  passed 12 `doctor` checks, and exercised aliases, masking, a transformation
  diff, failure and development replay. The four SDK events were sent with none
  dropped or rejected. The empty public consumer ran ESM and CommonJS on Node
  24; Node 22.12 support comes from the release pipeline's SDK job.
- **The source quick start is covered by CI configuration.** The `demo` and
  `release-verify` jobs copy `.env.example`, build and boot the stack, wait for
  API, demo source and web health, and run the demo acceptance suite. A timed
  installation on a new user's machine remains a separate check.

### Security

- **Redaction by name, at any depth**, in your process before an event leaves it
  and again on the server, including the common header shapes and webhook
  signature headers ([SECURITY section 4](SECURITY.md#4-redaction)).
- **A warning for secret-looking names no rule covers.** The SDK reports
  `unredacted_secret_name` once per process and name, naming the field and never
  the value, and sends the event unchanged. It never redacts on a guess;
  `knownSafeNames` silences a false positive.
- **Masking of credentials inside error messages**, by shape, in the SDK and on
  the server. Stack traces are kept only under full capture.
- **What is stored in plain text:** payloads (after redaction), journey labels,
  and copies of alias values the instrumenting code marked displayable. Labels
  are not redacted, so they must not hold personal data. Masked aliases and
  entity ids stay encrypted ([SECURITY section 6](SECURITY.md#6-searchable-sensitive-aliases)).

## Requirements

- **Node 22.12 or later** for the SDK. The package is ESM, and `require()` works
  on those versions; CI checks both on 22.12.0 and 24.
- **PostgreSQL 15 or later.** CI runs the integration suite on 15, 17 and 18,
  and `doctor` warns only on a release newer than 18.
- **Docker with Compose** to run the stack. Images are built for `linux/amd64`
  and `linux/arm64`.
- **The Helm chart** has been installed, upgraded and used on kind. It is meant
  for a local single-node cluster (kind, k3s or Docker Desktop) and has not been
  run on a managed cluster ([deploy/helm/README.md](../deploy/helm/README.md)).

## Known limits

- **The diff compares a step's own input and output**, and nothing else. It does
  not infer that a renamed field is the same field (ADR-030).
- **Arrays are compared by position**, so a reordered array reads as broadly
  changed (ADR-025).
- **Partial text matching** on the Journeys page covers labels and displayable
  alias values only. Masked aliases, entity ids and journey ids are found by
  exact value through search ([SECURITY section 6](SECURITY.md#6-searchable-sensitive-aliases)).
- **One admin token reads every project.** There are no user accounts and no
  record of who used the token (ADR-029, SECURITY section 2).
- **Replay targets development destinations only** and sends the payload as
  recorded (ADR-008, ADR-032).
- **Propagated journey context is checked for shape, not authenticated**
  ([SECURITY.md](../SECURITY.md)).
- **Of the five things the product aims to find** (a record changed, lost,
  duplicated, delayed or rejected), changed and rejected are demonstrated end to
  end; duplication and loss are not yet first-class.
- **`audit_events` is never swept**, and **the login limiter is per process**,
  so N web replicas allow N times the attempts ([ROADMAP](ROADMAP.md), "Known
  open").
- **Experimental SDK parts** may change in a minor release: the propagation
  helpers, `across`, `captureInput` and `captureOutput`, `journeyIdFor`,
  `label`, `maxConcurrentSends`, and the `Counters` fields (SDK README,
  "Stability").
- **Measured timing is development evidence, not a service-level promise.**
  SDK p99 values are noisy, storage used tmpfs, historical million-event search
  and storage figures were not repeated at that scale, and the journey-list
  timings exclude the network.
- **The public installation check was automated on an existing host.** Its
  35-second result is not a clean-machine installation, an unaided human trial,
  or evidence that a new developer records a first journey within 15 minutes.

## What comes next

From the [roadmap](ROADMAP.md), briefly:

- **OpenTelemetry log ingest** (`POST /v1/logs`, OTLP over HTTP).
- **The propagation specification and its test vectors**, now that the rename
  has settled the header and attribute names.
