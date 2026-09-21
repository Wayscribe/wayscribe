# Optional project ingestion controls

## Scope and configuration

ADR-065 authorizes a small resource-control feature shared by native and OTLP
ingestion. It is not billing, durable quotas or a global distributed limiter.
No additional service or database is needed. Default behavior stays unlimited.

Use `INGESTION_LIMITS_JSON`, absent/blank meaning disabled. Its explicit format is:

```json
{
  "default": {"eventsPerMinute": 6000, "burst": 1000, "maxConcurrent": 4},
  "projects": {
    "11111111-1111-4111-8111-111111111111": {
      "eventsPerMinute": 600, "burst": 100, "maxConcurrent": 2
    }
  }
}
```

`default` is optional; without it only named projects are limited. `projects`
is optional and contains at most 1000 UUID keys. A project entry is a complete
override, not a partial merge. Each policy requires positive integer
`eventsPerMinute` (1..60,000,000), `burst` (100..1,000,000) and `maxConcurrent`
(1..1000). Reject malformed JSON, unknown keys, invalid types and extra policy
fields during configuration loading, naming the setting without echoing it.
The burst floor fits the existing maximum 100-event batch. Settings take effect
on restart. Document finding project IDs with existing project listing.

## Admission

Use one synchronous in-process token bucket and in-flight count per authenticated
project, shared by `/v1/events`, `/v1/events/batch` including dry runs, and enabled
`/v1/logs`. One single event costs one token; a validated batch/export costs its
record count. Duplicates and permanently invalid individual events still cost
processing budget. Invalid credentials never allocate a bucket. Empty batches
are allowed but still reserve concurrency while the handler runs.

After authentication and envelope-level count/shape checks, atomically reserve
both capacity and concurrency, without an await between checking and reserving.
Do not subtract tokens when refusing concurrency. Record counts over the route's
existing ceiling are permanent request errors, not rate-limit refusals. A
successful reservation consumes tokens even if later processing fails; release
its in-flight slot exactly once on every response/error/abort path.
If a client disconnects while a database operation is still running, keep the
slot until that operation settles or is canceled; stop starting further batch
work. Releasing on the socket's abort alone would let repeated disconnects
bypass the concurrency limit. Existing statement timeouts bound pending work.

Refill with a monotonic clock at `eventsPerMinute / 60000` tokens per millisecond,
capped at `burst`. A process restart resets buckets. Limits apply separately to
each API process/replica; multiple replicas multiply available capacity. State
that limitation directly and retain reverse-proxy/global controls as an
operator concern. No claim of an exact installation-wide quota.

## Bounded state and refusal

Track at most 10,000 projects per API instance. Expire only idle entries whose
tokens have fully refilled and whose in-flight count is zero. Reclaim such
entries incrementally; do not scan the complete map on every event or evict an
active/depleted bucket to admit a fresh one. If a new project cannot be tracked,
refuse temporarily without bypassing its limit. No per-request timers or idle
interval that keep the process alive are needed.

Temporary refusal is HTTP 503 with `Retry-After` in whole seconds, at least one,
and machine code `ingestion_rate_limited` for native routes. This deliberately
preserves SDK-31: released native SDKs never retry 4xx. OTLP uses its Status
encoding with the same retryable HTTP status. No event from a refused request
is stored. The response never names another project or exposes configured
credentials. Native SDKs retain their existing bounded retries and breaker;
Retry-After is advice to clients, not a promise that older SDKs observe it.

Add bounded metrics for admission refusals by reason (`rate`, `concurrency`,
`capacity`), with no project ID labels. These are separate from per-event
storage verdict counters. Existing authentication-failure throttling remains a
different control with its existing behavior.

## Verification and organization

Keep the pure bucket/state implementation under `apps/api/src/ingestion/` and
the configuration schema in `packages/config`. Use fake monotonic time for exact
refill/burst/expiry boundaries; exercise concurrent admissions and once-only
release. Tests must prove that pressure from one project does not consume
another's tokens, both native routes and OTLP share the same project budget,
dry run consumes admission without persisting, and unavailable capacity never
fails open. Test state cardinality and idle reclamation under churn.

Database-backed route tests assert zero writes after refusal, eventual admission
after refill/release, unchanged authentication/environment isolation and native
SDK delivery after a temporary refusal. Propagate the optional setting through
Compose/Helm configuration and document restart/replica semantics in operations
and API contracts. Add the architecture decision before changing endpoint
behavior. No deployment or GitLab execution is part of this local program.
