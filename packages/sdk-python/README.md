# Wayscribe Python SDK — development preview

Distribution: `wayscribe-sdk`. Import: `wayscribe`. Version: `0.1.0a1`.
This package is **unpublished**. Python 3.11 or newer is required. Runtime code
uses only the standard library; setuptools is a build dependency only.

The recorder captures events synchronously and delivers immutable, redacted bytes
from one bounded daemon sender. Record calls never wait for network work.

```python
from wayscribe import create_recorder

payload = {"invoice_id": "inv_42", "amount": 10}
with create_recorder(
    endpoint="http://localhost:8080", api_key="provided-by-the-host",
    service="billing-worker", environment="development",
) as recorder:
    journey = recorder.journey({"type": "invoice", "id": "inv_42"}, label="Invoice sync")
    journey.identify({"external_invoice": "external_42"})
    result = journey.transform("normalize", payload, lambda: {**payload, "amount": 1000})
    journey.record(operation="persisted", name="write-invoice", output=result)
    journey.complete()

print(recorder.counters())
```

Use an ingestion API key for the configured project and environment. The example
requires a local Wayscribe server and a real key to store events; an unavailable
server never raises a recorder transport error into the host.

```python
from wayscribe import inject_http_headers, extract_http_context

context = {"journeyId": "jrn_example", "entity": {"type": "order", "id": "42"}}
headers = inject_http_headers(context, {"content-type": "application/json"})
# Default: journey and entity type only. No aliases or entity identifier.
assert extract_http_context(headers) == {"journeyId": "jrn_example"}
```

The HTTP, SQS and payload helpers follow `docs/PROPAGATION_SPEC.md` and run all
committed carrier vectors. Injection accepts `level="journey-only"`,
`"journey-and-type"` (default), or `"full"`. The latter explicitly opts in to
propagating a usable entity identifier. `traceparent` is preserved and never
written. `extract_payload` returns `{"context": context_or_none, "data": value}`.
`has_journey` is a nonthrowing structural check; use extraction for validation.
A missing `data` property in a recognized envelope becomes `None` in Python.

Carriers have no environment field. Receiving recorders must use their own
configured environment. After `journey_environment_mismatch`, the application
must begin a new journey in the receiving environment.

Timing helpers accept mappings or objects with explicit snake_case fields:

```python
from wayscribe import queue_metadata, http_metadata

metadata = queue_metadata(
    {
        "queue_name": "orders",
        "id": "42",
        "timestamp": 1000,
        "processed_on": 1300,
        "attempts_made": 0,
    },
    delivery_count=1,
)
assert metadata["queueWaitMs"] == 300

response_metadata = http_metadata(
    {"status": 429, "headers": {"retry-after": "2"}},
    target_url="https://api.example.com/orders/42",
)
assert response_metadata["targetHost"] == "api.example.com"
```

A retry needs `ready_again_at` in epoch milliseconds; the original enqueue time
is never substituted. Unknown or invalid measurements are omitted, measured zero
is retained, and a delivery count above one prevents initial-enqueue wait.
`http_metadata(..., now=epoch_ms)` makes HTTP-date Retry-After deterministic;
omitting `now` uses the observation time. Numeric Retry-After needs no clock.
Only the URL host (and a nondefault port) is kept.

Capture is synchronous and detached. Built-in secret names apply at every depth
and in header shapes. Custom paths supplement built-ins in `redacted-payload`;
`full-payload` retains built-ins and omits custom paths. `metadata-only` omits input
and output while still redacting metadata. Capture repairs cycles, nonfinite
numbers, NUL and unpaired surrogates. Shared references expand independently.
Integers outside ±(2^53−1) are decimal strings. Bytes/bytearray become
`{"type": "bytes", "base64": "..."}`. Dates become UTC midnight; naive datetimes
are interpreted as UTC, and aware datetimes are converted to UTC. Strings are
bounded in UTF-16 units, protocol identifiers and labels in Unicode code points.
Unsupported objects become `[UNCAPTURABLE]`; arbitrary attributes are not explored.
Rendered byte objects obey the same depth and string limits as supplied objects;
their base64 strings may carry a truncation marker. A decimal integer string that
exceeds the string limit causes payload omission so retained integers keep every digit.

Labels and displayable aliases are stored, shown and searched in plain text.
Do not put personal data or credentials in them. Narrow email/telephone shape
warnings do not alter these values and cannot recognize every kind of personal
data. Each statement of a displayable alias must list its type again; the server
keeps it displayable only while every statement does so. Error messages are
credential-masked and bounded; stacks are never automatically collected.

Configuration comes explicitly from the host, never ambient environment
variables. Required fields are `endpoint`, `api_key`, `service`, `environment`.
Invalid required settings disable event admission; rejected optional settings use
defaults or documented clamps and are available separately from call-time reports.
`deployment` accepts `git_commit`, `version`, `image`, detached at resolution.
`redact` and `known_safe_names` accept at most 1,000 strings. The initial sender
concurrency is fixed at one; passing `max_concurrent_sends` is reported as rejected.
Delivery defaults and bounds are documented below.
The envelope budget is capped at the protocol maximum of 262,144 bytes.

Diagnostics never print payloads, credentials, endpoint values, or exception
messages. Debug logging is opt-in. Creation failures, missing derivation secrets,
public personal-data shapes and unredacted secret names have bounded process-wide
warnings. The diagnostic callback can receive a bounded supplied key name/path
for an unredacted-secret report, never its value; printed warnings omit both.
Secret-name callbacks occur once per recorder and folded name, with one printed
warning per process and folded name across fields and spellings. Personal-data
callbacks and printing occur once per process, field and shape. A fork resets the
process-wide warning state and its lock so a fresh child recorder can report safely.

For development, run from the repository root:

```sh
PYTHONPATH=packages/sdk-python/src python3 -m unittest discover -s packages/sdk-python/tests -v
```

Full SDK fixture/API conformance and clean-wheel installation remain separate
verification gates. This development preview makes no publication claim.

## Recorder and journey API

`create_recorder(**options)` and `Recorder(**options)` create the same recorder.
`journey(entity, journey_id=None, label=None)` copies the entity identity;
`for_entity(entity, label=None)` derives the journey using the configured
`journey_id_secret` (at least 32 UTF-8 bytes). A missing/invalid secret warns and
uses a fresh unpredictable ID. Identity arguments after `entity` are keyword-only.
`resume(context, entity=...)` uses the receiver's authoritative entity and its own
configured environment. It continues only a journey ID valid for both propagation
and the event protocol. Carrier parsing accepts up to 256 characters, but events
accept 128: a longer resumed ID is diagnosed and replaced with a fresh ID. An
explicit `journey_id` passed to `journey` is not silently replaced; invalid required
event identity is refused without incrementing delivery counters.

A journey supports `context()` (a detached mapping), `label(value)` (records
nothing), `record(operation=..., name=..., **event_fields)`,
`identify(aliases, displayable_aliases=())`, `fail(name, error)`, and
`complete(name="complete")`. Event keyword fields use snake_case:
`input`, `output`, `metadata`, `timestamp`, `duration_ms`, `attempt`, `error`,
`parent_event_id`, `trace_id`, `span_id`, `message_id`, `correlation_id`,
`journey_label`, `aliases`, `displayable_aliases`. `timestamp` is an ISO timestamp
with an explicit time zone. Omitted payloads are absent; explicit `None` is JSON
null. Pass trace/span IDs explicitly; no OpenTelemetry installation is needed.

`transform`, `persist`, `publish`, `consume`, `deliver`, and `validate` each accept
`(name, input, callback, **options)`. The callback takes no arguments and executes
once. A synchronous result returns synchronously; an awaitable result returns an
awaitable wrapper. Returned/resolved values, exception objects and cancellation
are preserved. Input and static metadata/aliases are captured before the callback
can mutate them. The event uses the start timestamp and whole elapsed milliseconds.
An explicit `attempt > 1` changes the operation to `retried`; a failed attempt
carries its own error, and `fail` is for terminal journey/branch failures.

Wrapper options include event fields plus:

- `capture_input(value)` and `capture_output(value)` project the captured view.
  They may also accept a second `context` argument. They run synchronously;
  exceptions or awaitable results produce `[UNCAPTURABLE]` and a safe diagnostic.
  Output projections run only when the callback returns/resolves.
- `is_failure(result)` classifies a returned result once. A truthy value marks
  failure; a string supplies the message, or a mapping supplies `message` and/or
  `code`. Other truthy values use a generic message and `result_failed` code.
  A failed classifier leaves the host's result unchanged and reports safely.
- `metadata_from(result[, context])` returns synchronous metadata, merged over
  the static snapshot. Explicit `attempt` remains authoritative. For example,
  `metadata_from=lambda response: http_metadata(response, target_url=url)` records
  HTTP evidence without storing a URL path. A failed projection keeps static data.
- `queue_job=job`, `ready_again_at=epoch_ms`, `delivery_count=n` add the evidence
  from `queue_metadata`. Pass the wrapper's `attempt` explicitly when retrying.

`recorder.across([journey_a, journey_b, journey_a])` exposes the operation methods,
including `record`, wrappers, `fail` and `complete`. It deduplicates by journey ID,
executes a wrapped callback once, and emits separate event IDs sharing timestamp
and duration. Context-aware projections run once for each distinct journey.
Journeys must belong to that recorder. Groups have no label/identify/context method.

```python
import asyncio
from wayscribe import create_recorder

async def main():
    async with create_recorder(
        endpoint="http://localhost:8080", api_key="provided-by-the-host",
        service="async-worker", environment="development",
    ) as recorder:
        journey = recorder.journey({"type": "invoice", "id": "inv_42"})
        async def work():
            await asyncio.sleep(0)
            return {"ok": True}
        result = await journey.deliver("send", {}, work)
        assert result["ok"]
        await recorder.async_flush(timeout_ms=1000)

asyncio.run(main())
```

## Delivery and lifecycle

The configurable delivery bounds are `batch_size=50` (clamped to 1–100),
`flush_interval_ms=1000`, `request_timeout_ms=1500`,
`max_buffered_events=1000`, and `max_event_bytes=262144` (capped at 262144).
The queue is bounded separately from the single in-flight batch (at most 100).
Overflow discards the oldest pending event. Retries retain their original queue
age and byte-identical envelopes. Transport uses the batch route, verified TLS for
HTTPS, a 1 MiB response-body limit, no redirects, and no ambient proxy credentials.
Use HTTPS outside a trusted local development setup.

Fixed retry defaults are three HTTP attempts per logical send, full-jitter
exponential backoff (100 ms base, 2000 ms cap), and a breaker opening after five
failed logical sends for 30 seconds. Transient per-event refusals retain an
independent 30-second budget from the first refusal or ten logical sends, whichever
comes first. Ten logical sends can contain up to 30 HTTP attempts. Expired events
are dropped before another attempt, including after backoff or breaker cooldown.
Accepted events reset the breaker; whole-request 4xx is permanent and leaves the
breaker count unchanged. Verdicts are matched by position, not response event ID.
Unknown/missing/malformed successful verdicts drop once as `no_verdict`.

`flush(timeout_ms=5000)` and `shutdown(timeout_ms=5000)` return whether queued work
finished within the deadline. Finished means terminal accounting: consult counters
to distinguish sent events, permanent refusals and drops. A flush timeout leaves
pending work available for later delivery. Shutdown stops admission and drains until
empty, a pass makes no progress, or the deadline expires. It aborts active sockets
and counts every remaining event exactly once. Repeated shutdown returns its first
result. Valid records attempted after shutdown count as recorded and dropped with
cause `after_shutdown`; invalid calls are not admitted. Final delivery counts obey
`recorded == sent + rejected + dropped` and drop causes sum to `dropped`.

`async_flush` and `async_shutdown` await the same sender without blocking the event
loop or creating executor threads. Cancelling async shutdown finalizes remaining
work and propagates cancellation. Sync and async context managers call shutdown and
never suppress an exception from the context body. Background delivery cannot keep
the host process alive. A DNS/connect operation that the OS cannot cancel may finish
later in the daemon, but cannot write an HTTP request after cancellation or change
final counters. Shutdown cannot retract bytes sent earlier; the server can still
store an earlier in-flight request after the caller's deadline.

Construct recorders **after fork**. An inherited recorder is disabled before any
instance lock is acquired: recording has no effect, flush/shutdown return `False`,
its counters are an empty snapshot, and its rejected-settings collection is empty.
It never resends copied queues or closes/shuts down the parent's active socket.
Fresh child recorders are supported. Use detached `counters()` and
`rejected_settings()` for health checks; diagnostics callbacks may safely reenter
the recorder and must themselves remain short-running.
