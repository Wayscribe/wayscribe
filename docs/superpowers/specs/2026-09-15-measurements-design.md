# Measured, not assumed — design

Date: 2026-09-15. Status: approved for planning (autonomous v1 work).

Three numbers a self-hosting team needs before trusting Flight Recorder with real
traffic, and one performance defect those numbers expose.

## 1. Search that does not scale with journey count

`searchJourneys` (`packages/database/src/repositories/search.ts`) matches a value
against journey ids, entity tokens, alias tokens, and four technical identifiers
on events, as one `WHERE a OR b OR EXISTS(...) OR EXISTS(...)` over the project's
journeys. PostgreSQL cannot use the per-condition indexes for an OR of that
shape, so it walks every journey in the project and probes events and aliases
for each. The debt declaration `DEBT-82X79Y` measured 33 ms at 12,000 journeys
and 1.1 s at 120,000.

**Rewrite:** compute matching journey ids as a `UNION` of index-served branches,
each scoped to the project (and environment when the scope has one), then join
journeys once for the summary columns, ordering, and the keyset cursor:

- `journeys` where `id = value`
- `journeys` where `primary_entity_id_hash in (tokens)`
- `entity_aliases` where `alias_value_hash in (tokens)` → `journey_id`
- `journey_events` where `trace_id = value`, and the same for `span_id`,
  `message_id`, `correlation_id` → `journey_id` (separate branches, so each uses
  its own index)

Environment scoping must be applied inside every branch or on the outer join so
an API key never sees another environment; the existing scope tests must pass
unchanged.

**Indexes:** read `006_journey_events.js`. Any technical-identifier branch without
an index gets one in `014_search_indexes.js`, built concurrently with the pattern
migration 013 uses (`transaction: false`, drop an invalid leftover first).

**Proof of equivalence:** a property-style integration test generates a few
hundred journeys with random overlaps of ids, entity values, aliases, and
technical identifiers across two projects and two environments, then runs the old
query (kept in the test file as a reference implementation) and the new one for
many values and scopes, asserting identical ordered results across pages.

**Proof of speed:** `EXPLAIN (ANALYZE, BUFFERS)` at 120,000 and 1,000,000 journeys
(with events and aliases in proportion) for a value that matches one journey, a
value that matches nothing, and a technical identifier, before and after.
Target: under 20 ms at 1,000,000 journeys for a single-match value. Summarise on
the migration or the function comment, and remove `DEBT-82X79Y` if the target is
met.

## 2. Storage per event

A committed script, `scripts/measure-storage.mjs`, runs against a scratch
PostgreSQL: ingests N journeys of the demo's shape through the real ingestion
code (or the API) in each capture mode, then reports table and index sizes from
`pg_total_relation_size` and `pg_indexes_size`, bytes per event, and bytes per
journey. It also runs one retention sweep over half the data and reports size
before and after `VACUUM` (plain, not `FULL`), so the documentation can say
honestly how deletion and retention affect disk.

`docs/OPERATIONS.md` Sizing gains a table from a real run (hardware and
PostgreSQL version stated) and a formula an operator can apply to their own
events per day and retention days, with a stated margin.

## 3. SDK overhead

A committed benchmark, `packages/sdk-node/bench/overhead.mjs`, measures on the
host process:

- Added latency per wrapped call (p50, p99) for a synchronous transform and an
  asynchronous persist, with payloads of 1 KiB and 64 KiB, against an unwrapped
  baseline, with the recorder sending to a local HTTP server that answers like
  ingestion.
- The same with the endpoint unreachable and with the endpoint answering slowly
  (for example 200 ms), to show capture never waits on the network.
- Heap growth and event-loop delay under a sustained 2,000 wrapped calls per
  second for 60 seconds.
- Send concurrency: throughput and dropped events at `MAX_CONCURRENT_SENDS` of 1,
  2, 4, and 8 against a server with 50 ms and 200 ms of latency, which settles
  the open debt `DEBT-WGN0N4` ("four is a guess") with a measured default.

`packages/sdk-node/README.md` gains a short "What it costs" section with the
numbers, the machine they came from, and the command to reproduce them.

## Out of scope

Load-testing the API as a whole, and any tuning beyond what the numbers above
show is needed.
