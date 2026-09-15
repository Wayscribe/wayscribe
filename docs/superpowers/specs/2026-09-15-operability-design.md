# Knowing it works — design

Date: 2026-09-15. Status: approved for planning (autonomous v1 work).

## Why

A team runs Flight Recorder on their own infrastructure without the author. Today
three questions have no good answer:

1. **Is this installation set up correctly?** Migrations, secrets, a project, a
   key that authenticates. Each is checked somewhere (readiness, the boot
   warning, the CLI), but nothing checks them together, and the quick start's
   failure modes are silent: a stack on published default keys, a key issued
   for the wrong environment, a service pointed at the wrong URL.
2. **Is my service actually sending?** The SDK writes nothing to the console
   unless asked (README: "Nothing is written to your console unless you ask for
   it"), so a working install and a broken one look identical from the host.
3. **Is it still working?** No metrics. An operator cannot alert on rejected
   events, a stalled retention sweep, pool exhaustion, or slow queries. And no
   query has a time limit, so one slow search can hold a connection that
   ingestion needs.

## 1. `doctor`

A database CLI command, available in the API image like `key:create`:

```text
doctor [--api-url <url>] [--api-key <key>]
```

Each check prints one line: `PASS`, `WARN`, or `FAIL`, what it checked, and for
anything but a pass, the fix in one sentence. Exit 0 when nothing failed, 1
otherwise. Warnings do not fail.

| Check | Fails when | Warns when |
| --- | --- | --- |
| Database reachable | connection refused or authentication fails (message never includes the URL's password) | |
| PostgreSQL version | below 15 | below 17, the tested version |
| Migrations | any pending | |
| `ENCRYPTION_KEY`, `ADMIN_TOKEN` | a published development default | |
| Keys readable | `rotate:status` would report unreadable rows or keys (reuse `findUnreadableData`) | a rotation is in progress (`ENCRYPTION_KEY_PREVIOUS` set) |
| Projects and keys | | no project, or no unrevoked API key |
| API key (with `--api-key`) | the key does not authenticate against the database (verified locally with the keyring, no network), is revoked, or its project/environment no longer exist | |
| API reachable (with `--api-url`) | `GET /ready` is not 200, with its `reason` | |
| Statement timeout | | the API's configured timeout is 0 (disabled) |

`--api-key` accepts a full key on the command line; the output shows only its
prefix. The command never prints key material, the admin token, or the database
password.

## 2. The SDK says it is connected, when asked

Keep the principle: nothing on the console by default.

- New diagnostic `{ kind: "delivered_first", endpoint, accepted }`, emitted once
  per recorder, after the first batch the server accepts at least one event
  from. It goes to `onDiagnostic` like every other diagnostic.
- New option `logDiagnostics?: boolean` (default false). When true, the recorder
  writes each diagnostic to `console.error` as one line prefixed
  `[flight-recorder]`, rate-limited to one line per diagnostic kind per minute,
  with a count of suppressed repeats. `delivered_first` is always printed when
  the option is on. The quick start and `examples/instrument-a-service` turn it
  on, with a comment saying to turn it off once the service is known to send.
- Nothing about the wire protocol changes.

## 3. A statement timeout

- New API setting `DATABASE_STATEMENT_TIMEOUT_MS`, default `15000`, `0` disables.
  Applied to every connection the API's pool opens (`SET statement_timeout` in
  the pool's `afterCreate`, or the equivalent connection option), so it covers
  search, reads, ingestion, and the retention sweep's statements.
- A cancelled statement (SQLSTATE `57014`) becomes `503` with code
  `query_timeout` and a request id, and increments the query timeout metric. The
  log line names the route, never the parameters.
- The database CLI does not apply it: `rotate:reencrypt` and deletion commands
  run operator-started batches and already bound each statement by batch size.
- The advisory-lock holder connection runs no long statement, so the timeout
  does not affect lock holding.

## 4. Metrics

Prometheus text exposition, served by the API on a separate port so it is never
on the ingestion port by accident.

- New setting `METRICS_PORT`, unset by default (no metrics listener). When set,
  the API listens on it at `/metrics` only. Compose and Helm document it and do
  not publish it by default.
- No new runtime dependency: the exposition format for counters, gauges, and one
  histogram is small enough to write and test directly, and every dependency is
  another advisory to track.
- Series (names follow Prometheus conventions, `flight_recorder_` prefix):

| Metric | Type | Labels |
| --- | --- | --- |
| `flight_recorder_http_requests_total` | counter | `method`, `route` (the route pattern, never the raw path), `status` |
| `flight_recorder_http_request_duration_seconds` | histogram | `method`, `route` |
| `flight_recorder_events_total` | counter | `result`: `accepted`, `duplicate`, `rejected` |
| `flight_recorder_query_timeouts_total` | counter | `route` |
| `flight_recorder_db_pool_connections` | gauge | `state`: `used`, `free`, `pending` |
| `flight_recorder_retention_sweep_runs_total` | counter | `outcome`: `completed`, `locked`, `stopped_early`, `failed` |
| `flight_recorder_retention_journeys_deleted_total` | counter | |
| `flight_recorder_retention_last_success_timestamp_seconds` | gauge | |
| `flight_recorder_unreadable_values` | gauge | `table` (set by the boot check) |
| `process_resident_memory_bytes`, `nodejs_eventloop_lag_seconds` | gauge | |

- No label ever carries a project id, key prefix, entity, or any request value.

## Boundaries

- `packages/database/src/doctor.ts` and the CLI entry; tests.
- `packages/sdk-node/src/diagnostics.ts`, `config.ts`, `recorder.ts`; the bundle
  stays dependency-free.
- `packages/config` (two settings), `packages/database/src/knex-config.ts` or the
  API's database setup, `apps/api/src/errors` or wherever the error envelope
  lives.
- `apps/api/src/metrics/` (registry, exposition, the listener), hooks in
  `apps/api/src/app.ts`, calls from ingestion, the retention job, and the boot
  check.

## Documentation

`docs/OPERATIONS.md` (a "Checking an installation" section for `doctor`, a
"Monitoring" section listing the metrics with two or three suggested alerts,
the statement timeout), `README.md` quick start (run `doctor` after `key:create`;
`logDiagnostics` in the snippet), `packages/sdk-node/README.md`,
`examples/instrument-a-service`, `.env.example`, Compose and Helm values,
`CHANGELOG.md`. One ADR covering the metrics port and the no-dependency choice.

## Testing

- **doctor:** integration tests for each check's pass, warn, and fail against
  PostgreSQL (pending migrations, default keys, unreadable rows, no keys, a
  revoked key, a wrong key), with the exit code; output never contains the
  database password, admin token, or full API key (assert on captured output).
- **SDK:** `delivered_first` emitted exactly once; `logDiagnostics` writes the
  expected line and rate-limits repeats (fake timers); off by default writes
  nothing.
- **Timeout:** an integration test issuing `pg_sleep` longer than a small
  configured timeout through a route gets `503 query_timeout`; `0` disables.
- **Metrics:** exposition format unit tests (escaping, histogram buckets and
  `_sum`/`_count`); an integration test that ingests, searches, and runs a sweep,
  then scrapes `METRICS_PORT` and asserts the counters moved and no label
  contains a request value; with `METRICS_PORT` unset, nothing listens.
