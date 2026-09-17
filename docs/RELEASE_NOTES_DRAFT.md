# Wayscribe 0.x preview: release notes

**Draft, 2026-09-16.** Nothing described here is published yet. The version
number, the product name and the install commands will be filled in when the
release is cut. The full list of changes is in [CHANGELOG.md](../CHANGELOG.md).

## What it is

Wayscribe records what happened to one business record, such as a
customer, an order or an invoice, as it moves through your services, and shows
the step where its data changed. It is self-hosted, stores everything in a
PostgreSQL database you run, and needs no account or hosted service.

This is a preview. Before 1.0 a minor release may change the API; a patch
release will not.

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
  check ingestion runs, so an oversized payload is cut or replaced and the event
  still arrives.
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
  once regardless: a missing or unusable required setting, a renamed option, a
  missing journey-id secret, and a secret-looking field name no redaction rule
  covers. Each diagnostic has a stable `code` to match on.
- **What it costs is measured.** On 2026-09-17, on an Apple M3 Pro, wrapping a
  call with a 1 KiB payload added 89 µs at p50 and 1,341 µs at p99 for
  `transform`, and 67 µs and 1,507 µs for `persist`, with the processor idle
  between calls; with a core kept awake, as in a busy service, 31 µs and 18 µs
  at p50. At 64 KiB a `transform` added 1,816 µs at p50, or 1,563 µs with a core
  awake. At 2,000 wrapped calls a second for a minute, the heap after
  collection went from 9.2 to 9.4 MiB, and the resident set ended at 219 MiB
  against 76 MiB unwrapped (SDK README, "What it costs"). The machine was
  running other work, so read these as orders of magnitude. Tests in
  `pnpm test` count how often capture walks a payload.
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
- **Disk use is measured.** With the demo's shape of event (payloads averaging
  120 bytes of JSON), a million events took about 1,049 bytes each in
  `metadata-only` and 1,494 bytes each in `redacted-payload`, indexes included,
  on PostgreSQL 17.11 on an Apple M3 Pro, measured on 2026-09-15. By the sizing formula, a million events a day kept 30 days
  in `redacted-payload` needs about 63 GiB (OPERATIONS section 10, "Measured disk
  per event" and "A formula").
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
  alias marked displayable, with a Failures shortcut. Measured on 2026-09-16 at
  120,000 journeys on an Apple M3 Pro, a
  24-hour window returned in under 12 ms in every measured case; text that
  matches nothing over 30 days, the worst case, took 262 ms at p50 and 316 ms at
  p95 with about 90,000 journeys in the window (OPERATIONS section 10, "Listing journeys").
- **The timeline** shows every event of a journey across services. It can be
  filtered to one service or to failures, navigated with the arrow keys, and set
  to follow a journey that is still recording.
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
- **Signed images with an SBOM.** Released `api` and `web` images are signed
  with Sigstore keyless signing and carry a CycloneDX SBOM per platform; the SDK
  is published with npm provenance (OPERATIONS section 11).

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

## What comes next

From the [roadmap](ROADMAP.md), briefly:

- **Per-record timing and context:** gaps between steps with queue waits called
  out, journey duration and stuck journeys, retry detail, a small standard
  metadata vocabulary, the deployment on each event, and duration filters on the
  Journeys page.
- **OpenTelemetry log ingest** (`POST /v1/logs`, OTLP over HTTP), after the
  rename.
- **The quick start run literally in CI**, from a clean clone and a copied
  `.env`.
- **The propagation specification and its test vectors**, once the rename fixes
  the header and attribute names.
