# Frequently asked questions

Every number on this page was measured, and each names the document it comes
from, the date, and the machine it was taken on, or says that the machine was
not recorded. Read them as orders of magnitude for your own hardware, not as
guarantees.

- [Why not OpenTelemetry?](#why-not-opentelemetry)
- [Why is Node the first SDK?](#why-is-node-the-first-sdk)
- [Can I send events without the Node SDK?](#can-i-send-events-without-the-node-sdk)
- [What does it store, and what is stored in plain text?](#what-does-it-store-and-what-is-stored-in-plain-text)
- [What does the SDK cost my service?](#what-does-the-sdk-cost-my-service)
- [How much disk does an event take?](#how-much-disk-does-an-event-take)
- [How fast are search and the journey list?](#how-fast-are-search-and-the-journey-list)
- [What happens when the Wayscribe server is down?](#what-happens-when-the-wayscribe-server-is-down)
- [How do deletion and erasure work?](#how-do-deletion-and-erasure-work)
- [Does it need internet access?](#does-it-need-internet-access)
- [Which PostgreSQL versions does it support?](#which-postgresql-versions-does-it-support)
- [What is the license?](#what-is-the-license)

## Why not OpenTelemetry?

Because they answer different questions. Tracing answers "which call was slow,
and did it succeed?" Wayscribe answers "what happened to this record, and
where did its data change?" The README's
[Why this is not tracing](../README.md#why-this-is-not-tracing) has the full
comparison. In short:

- **You search by a business identifier**, such as a customer, order or
  invoice id, and by the other identifiers that record is known by, rather than
  by a trace id.
- **A journey outlives a trace.** One record crosses a webhook, a queue, a
  worker and a retry an hour later; those are several traces, and one journey.
- **It stores the payload going in and coming out of each step**, and the
  field-level difference between them. Traces carry latency, status and
  structure, not the value that changed.

It is not a replacement for OpenTelemetry, and it does not require it
([ADR-010](DECISIONS.md#adr-010-opentelemetry-is-optional-interoperability)).
When OpenTelemetry is installed, the Node SDK reads the active trace and span
ids onto each event, so you can move between the two. It never writes
`traceparent`; OpenTelemetry owns that header.

[ADR-049](DECISIONS.md#adr-049-the-contract-is-the-deliverable-and-a-second-sdk-waits-for-a-team-that-needs-one)
makes OpenTelemetry log records over OTLP HTTP a planned, optional way to send
events. It rejected becoming a pure OpenTelemetry backend: the pairing of input
and output that the payload diff depends on would become a convention nothing
enforces. OTLP ingestion is not built yet.

## Why is Node the first SDK?

The first version is TypeScript throughout, API, interface, protocol, SDK and
demo, so one set of schemas serves all of them
([ADR-003](DECISIONS.md#adr-003-use-typescript-across-v0)). **Python is next**,
after the first release
([ADR-059](DECISIONS.md#adr-059-python-is-the-next-sdk)): most of the pipelines,
workers and integrations this tool is for are written in it.
[ADR-049](DECISIONS.md#adr-049-the-contract-is-the-deliverable-and-a-second-sdk-waits-for-a-team-that-needs-one)
said a second SDK waits for a team that needs one, and that held while there was
no contract to build one against. There is one now, so the cost of a second SDK
is its build and its maintenance rather than a second design, and ADR-059
supersedes that condition for Python. Languages after Python follow what pilot
teams ask for; OpenTelemetry log ingest covers the rest in the meantime.

What was built instead is the contract a recorder in any language is written
against: the [ingestion contract](INGESTION_CONTRACT.md), JSON Schema generated
from the server's own schemas, a language-neutral
[SDK specification](SDK_SPEC.md), a dry-run endpoint, and conformance fixtures
that a new SDK runs before it counts as done.

## Can I send events without the Node SDK?

Yes. Any client can `POST /v1/events/batch` with an API key. The
[ingestion contract](INGESTION_CONTRACT.md) is normative for both ingestion
routes: the limits, every refusal and whether to retry it, idempotency by event
id, and `?dryRun=true`, which validates a batch without storing it. The SDK's
guarantees (redaction before events leave your process, fitting events to the
limits, retries and the breaker) are then yours to implement;
[SDK_SPEC.md](SDK_SPEC.md) lists them.

## What does it store, and what is stored in plain text?

Everything is in your PostgreSQL database; there is no other store
([Operations §1](OPERATIONS.md#1-what-holds-state)).

| Data | How it is stored |
| --- | --- |
| Entity ids and alias values | encrypted with a key derived from `ENCRYPTION_KEY`, and found through keyed search tokens. A reader sees the entity id in full, and aliases masked |
| Payloads (`input`, `output`), their diff, and `metadata` | plain `jsonb`, after redaction: in your process by the SDK, and again by the server. Payloads are not encrypted, by decision; redaction is the payload control ([Security §7](SECURITY.md#7-encryption)) |
| Journey labels | plain text, never redacted, because the instrumenting code wrote them to be shown ([Security §6](SECURITY.md#what-is-stored-in-plain-text-and-why)) |
| Aliases marked displayable | encrypted, plus a plain-text copy for partial-text matching, kept only while the alias stays displayable |
| Error messages | masked by shape (URL credentials, bearer tokens, known key formats) before they are stored |
| Error stacks | dropped, unless the environment's capture mode is `full-payload` and the installation allows full capture |
| Step names, service names, entity types, timestamps | plain text |

Redaction matches field names at any depth against a built-in list
(`authorization`, `cookie`, `password`, webhook signature headers such as
`stripe-signature`, and others) plus the paths you add. A secret under a name no
rule covers is stored as written; the SDK warns about it, and so does
`doctor` ([Troubleshooting](TROUBLESHOOTING.md#the-secret-name-warning)).

If the records your services carry are regulated, start with
`captureMode: "metadata-only"`, which stores the journey's shape and no
payloads at all. Treat the database as holding whatever your workflows carry.

## What does the SDK cost my service?

Measured on 2026-09-17 with the SDK's own benchmark
(`pnpm --filter @wayscribe/node bench`) on an Apple M3 Pro, macOS 26.2,
Node 24.19.0, default configuration, while the machine ran other work.
Source: [SDK README, What it costs](../packages/sdk-node/README.md#what-it-costs).

**Time added to each wrapped call**, in microseconds. The benchmark sleeps
between calls; "cores idle" is that default run, and "core awake" is the same
run with a core kept busy (`--awake`), which is closer to a service under load.

| Wrapper | Payload | Cores idle, p50 / p99 | Core awake, p50 / p99 |
| --- | --- | --- | --- |
| `transform` (sync) | 1 KiB | 89 / 1,341 | 31 / 324 |
| `persist` (async) | 1 KiB | 67 / 1,507 | 18 / 205 |
| `transform` (sync) | 64 KiB | 1,816 / 14,424 | 1,563 / 12,336 |
| `persist` (async) | 64 KiB | 1,541 / 12,875 | 757 / 6,477 |

Most of it is redaction and the copy that makes a payload safe to store, so it
grows with the payload. The p99 is mostly the one call in each batch of 50 that
serialises the batch. An endpoint that is down or slow adds nothing a call
waits on.

**Sustained load**, 2,000 wrapped calls a second for 60 seconds at 1 KiB:

| | Unwrapped | Wrapped |
| --- | --- | --- |
| Heap after GC, start to end | 7.0 to 8.0 MiB | 9.2 to 9.4 MiB |
| Resident set size at the end | 76 MiB | 219 MiB |
| Event-loop delay beyond its timer, p50 / p99 | 0.45 / 0.99 ms | 0.17 / 1.73 ms |
| Events stored / dropped | | 124,000 / 0 |

The SDK has no runtime dependencies. If you record large payloads, record a
smaller view of them with `captureInput` and `captureOutput`.

## How much disk does an event take?

Measured on 2026-09-15 by `scripts/measure-storage.mjs` on an Apple M3 Pro with
PostgreSQL 17.11 (`postgres:17-alpine`, default configuration), for journeys of
ten events and two aliases each, with payloads averaging 120 bytes of JSON.
Source:
[Operations §10, Measured disk per event](OPERATIONS.md#measured-disk-per-event).

| Capture mode | Per event, at 1,000,000 events | Per event, compacted | Per journey |
| --- | --- | --- | --- |
| `metadata-only` | 1,049 B | 873 B | 10.2 KiB |
| `allowlisted-fields` | 1,273 B | 1,097 B | 12.4 KiB |
| `redacted-payload` | 1,494 B | 1,320 B | 14.6 KiB |
| `full-payload` | 1,496 B | 1,320 B | 14.6 KiB |

- Payload capture cost about four times the payload's JSON size: 445 bytes per
  event over `metadata-only` for 120 bytes of JSON.
- Indexes were 39 to 56 percent of the disk.
- Deleting data does not shrink the files. Half the journeys deleted and a
  plain `VACUUM` left 832.7 MiB at 832.9 MiB; the space was reused by the next
  ingestion.

Operations §10 gives a sizing formula, with a margin, and the command to
measure your own payload shape. Its worked example, a million events a day kept
30 days in `redacted-payload`, comes to about 63 GiB.

## How fast are search and the journey list?

**Search**, by exact identifier. The last two rows are for an API key scoped to
one environment. Measured on 2026-09-15 with `EXPLAIN (ANALYZE, BUFFERS)` on
PostgreSQL 17; the commits that record these figures do not name the machine.
Source: [Operations §10, Indexes](OPERATIONS.md#indexes).

| Case | Time |
| --- | --- |
| a value matching a few journeys, among a million | about 0.1 ms |
| a value matching 2,400 journeys, among 120,000 | 13 ms |
| a value matching 20,000 journeys, among a million | 64 ms |

**The journey list**, `GET /v1/journeys`, timed through the real API in process
(the network is not in the figure) with 120,000 journeys and 360,000 events,
page of 25, warm cache, measured on 2026-09-16 on an Apple M3 Pro with
PostgreSQL 17.11. p50 / p95 in milliseconds. Source:
[Operations §10, Listing journeys](OPERATIONS.md#listing-journeys).

| Case | Last 24 hours | Last 30 days |
| --- | --- | --- |
| No filter, admin (every environment) | 1.6 / 2.8 | 1.5 / 3.4 |
| No filter, API key (one environment) | 2.3 / 3.4 | 1.9 / 2.1 |
| `status=failed`, admin | 2.6 / 3.3 | 2.1 / 3.5 |
| Text matching many journeys, admin | 4.8 / 7.5 | 4.3 / 5.4 |
| Text matching none, admin | 10.1 / 11.7 | 261.6 / 315.6 |
| Text matching none, API key | 8.4 / 9.1 | 207.5 / 214.1 |

Text that matches nothing is the slow case, because every journey in the window
is tested; it grows with the number of journeys in the window. An installation
recording tens of thousands of journeys a day should filter text over a day or
a week rather than a month.

**Ingestion**, timed through the API on the same machine with the indexes this
release ships: a batch of 100 events took 230.6 and 248.3 ms at p50 in two runs,
and a single event 4.3 and 4.7 ms
([Operations §10](OPERATIONS.md#listing-journeys), *What they cost ingestion*).

## What happens when the Wayscribe server is down?

Your service carries on. Source:
[SDK README](../packages/sdk-node/README.md#it-cannot-break-your-application).

- **Recording never waits on the network.** With a core kept awake, the time
  added per call at 1 KiB was the same against an endpoint answering after
  200 ms, against one refusing connections, and against a working one: 31 to
  34 µs at p50 for `transform` and 18 to 19 µs for `persist`. With the
  processor idle between calls every figure is higher and moves more; a
  refusing endpoint can read higher still (90 and 125 µs for `transform`,
  against 89 and 114), because a process whose sends fail at once leaves its
  cores idle for longer. None is the 200 ms a waited-on request would add (two
  runs of each on 2026-09-17, [What it costs](../packages/sdk-node/README.md#what-it-costs)).
- **Events wait in a bounded queue**, 1,000 by default (`maxBufferedEvents`).
  Past it, the oldest are dropped and counted, so memory does not grow with the
  outage.
- **Sending backs off.** After five failed sends in a row, sending pauses for 30
  seconds, then tries again. A batch whose request failed is retried for as long
  as the outage lasts, within the queue's bound.
- **`shutdown()` never hangs.** It sends what it can within `timeoutMs` (2,000
  ms by default), stops early when a pass makes no progress, and counts the rest
  as `dropped`.
- **Nothing throws into your code**, and wrapped calls return your value and
  rethrow your exact error.

What is lost is visible: every event not delivered is counted in `dropped` with
a code that says why, and `sent + rejected + dropped` equals `recorded` once
`shutdown()` has returned.

## How do deletion and erasure work?

Source: [Operations §7 and §8](OPERATIONS.md#8-deleting-data).

- **Retention** deletes journeys by age, per environment (`retention_days`),
  hourly, inside the API process.
- **On demand**, four commands delete one journey, every journey matching an
  identifier, an environment's journeys in a time window, or a replay
  destination. The first two, and destinations, are also in the admin API; a
  journey's page has a delete action.
- **Every deletion is hard**, takes the journey's events, aliases and replay
  runs with it, and writes an audit row in the same transaction. An erasure's
  audit row holds a search token for the value, never the value.
- **Dry run first.** `delete:identifier` and `delete:range` take `--dry-run`:

  ```bash
  pnpm delete:identifier <project> <value> --dry-run
  ```

Two limits to know before promising erasure to anyone:

- **Erasure finds entity ids and aliases, not payloads.** A value that appears
  only inside a payload, such as an email address a service put in `input`
  without recording it as an alias, is not matched. Record the identifiers an
  erasure request may name as aliases.
- **Deleted rows stay in the table files until vacuum, and in every backup**
  taken before the deletion.

## Does it need internet access?

Not to run. The running services send no telemetry and no analytics, and make no
outbound connection other than those your configuration creates: the database,
and replay destinations you register. Next.js telemetry is switched off in the
web image. Source: [README, Free, and staying that way](../README.md#free-and-staying-that-way).

Building the images is not offline: it downloads base images, Alpine packages
and npm packages. The Node SDK sends only to the `endpoint` you give it, and
reads no environment variables.

## Which PostgreSQL versions does it support?

PostgreSQL 15 or later. CI runs the whole integration suite on 15, 17 and 18;
16 is not run. `doctor` fails below 15 and warns on a release newer than 18,
the newest CI tests. It needs an ordinary database and role (`USAGE`, `CREATE`, `SELECT`, `INSERT`,
`UPDATE`, `DELETE` on its own schema), installs no extensions, and can share a
database with other tables. Source:
[Operations §1, Bring your own database](OPERATIONS.md#bring-your-own-database).

## What is the license?

Apache-2.0, for every package, the SDK included, with a `NOTICE` file
([ADR-014](DECISIONS.md#adr-014-license-the-project-under-apache-20)). The
self-hosted core (ingestion, search, timelines, diffs, replay to development,
and retention) needs no payment and no hosted account
([ADR-011](DECISIONS.md#adr-011-keep-the-self-hosted-core-free-and-open-source)).
