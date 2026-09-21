# Native Python recorder

## Scope and authority

This is deliverable 2 of `2026-09-20-sdk-expansion-design.md`, authorized by
Jorge's request to proceed. `docs/SDK_SPEC.md` is the normative behavioral
contract, including requirements SDK-1 through SDK-67. The ingestion and
propagation specifications and committed conformance fixtures are the wire
authority. Python idioms change the surface, not event semantics.

Build the complete recorder locally before starting the Go implementation.
Publication, PyPI ownership setup and GitLab CI remain deferred. Use development
version `0.1.0a1`; never describe it as published. Distribution name
`wayscribe-sdk`, import name `wayscribe`; release ownership must be checked at
publication time. Runtime requires Python >=3.11 and only the standard library.
The build backend may use setuptools, but importing/using the installed wheel
must not require setuptools or any framework/OpenTelemetry package.

## Public surface

Use explicit configuration, snake_case Python names, and camelCase only on the
existing wire. Public entry points guard recorder failures; user callbacks run
outside those guards and retain exact return value and exception identity.

```python
from wayscribe import create_recorder

recorder = create_recorder(
    endpoint="http://localhost:8080", api_key="provided-by-the-host",
    service="billing-worker", environment="development",
)
journey = recorder.journey({"type": "invoice", "id": "inv_42"})
journey.identify({"external_invoice": "external_42"})
result = journey.transform("normalize", payload, lambda: normalize(payload))
journey.record(operation="persisted", name="write-invoice", output=result)
recorder.shutdown(timeout_ms=5000)
```

`create_recorder(**options)` returns a `Recorder` even for unusable settings.
Invalid required settings create a usable no-network recorder with diagnostics.
Optional numeric/list/deployment settings follow SDK-60: report only setting
names, use documented defaults/clamps, never coerce string numbers or bools.
Required strings must be nonblank and within protocol limits. Defaults match
SDK_SPEC section 7 except the initial Python worker limit is one concurrent
send, chosen to bound the thread footprint; a configurable bounded worker pool
may implement the recommended four only if its tests prove the same lifecycle.
Do not expose a setting that is ignored.

Public recorder methods:
- `journey(entity, *, journey_id=None, label=None)` → Journey.
- `resume(context, *, entity)` → Journey, continuing only a usable context.
  The caller supplies the authoritative entity because the default propagation
  level intentionally omits its identifier. Document environment isolation.
- `for_entity(entity, *, label=None)` → Journey using the shared HMAC vectors.
- `across(journeys)` → a Journey-compatible operation target; callbacks execute
  once, deduplicated journeys get separate event IDs and a shared time/duration.
- `flush(timeout_ms=5000)` and `shutdown(timeout_ms=5000)` → bool indicating
  whether all accepted queued work finished within the deadline; neither throws.
- `async_flush` and `async_shutdown` await the same bounded lifecycle without
  blocking the caller's event loop. Sync and async context managers close safely
  and never suppress an exception from the host's context body.
- `counters()` → a detached dictionary; `rejected_settings()` → a detached
  collection naming creation-time refusals, separate from call-time diagnostics.

Journey methods: `context()`, `label(value)`, `record(**event_fields)`,
`identify(aliases, *, displayable_aliases=())`, `fail(name, error)`,
`complete(name="complete")`, `transform/persist/publish/consume/deliver/validate`
with `(name, input, callback, **options)` and natural protocol operations.
Wrappers accept `attempt`, `metadata`, `capture_input`, `capture_output`,
`is_failure`, `aliases`, `displayable_aliases` and timing context as appropriate.
A sync callback returns synchronously; a returned awaitable yields an awaitable
wrapper which preserves result, cancellation and exception identity. Projections
are synchronous, captured immediately, and an awaitable projection is refused
without leaving an un-awaited coroutine warning.

Export snake_case standalone helpers matching the propagation specification:
`inject_http_headers`, `extract_http_context`, `inject_sqs_attributes`,
`extract_sqs_context`, `inject_payload`, `extract_payload`, `has_journey`.
Use the fixture-defined JSON context shape to enable cross-language exchange.
Export `queue_metadata` and `http_metadata` with documented Python inputs and
the ADR-064 unknown-versus-zero and retry-ready rules. No OTel dependency:
traceparent parsing/explicit context can correlate traces; any optional OTel
lookup must be guarded and work when the dependency is absent.

## Capture and host isolation

Capture and redact synchronously before enqueueing. Queue immutable serialized
envelopes; mutations after recording cannot change sent bytes. Adopt the full
secret-name and positional-header rules from SDK_SPEC, built-in redaction in
every capturing mode, operator paths alongside built-ins, and bounded traversal.
Date/time values use explicit UTC ISO strings, bytes use a documented JSON-safe
representation, integers outside the interoperable exact range ±(2^53-1) become
decimal strings, nonfinite floats become null, lone surrogates become U+FFFD,
and NUL is removed. Repair cycles without confusing shared references.
Distinguish an absent value with an internal sentinel; explicit None means JSON
null. Bound UTF-16 strings and Unicode-code-point protocol fields separately.

Capture only explicitly supplied data; do not traverse arbitrary application
attributes to discover payloads. Unreadable mappings/values yield the required
marker and a safe diagnostic. Error text is credential-masked and bounded;
automatic stack capture is off. Diagnostics never print exception messages,
payloads, endpoints, keys or personal values. Preserve public labels/displayable
aliases while warning by shape as SDK-63 specifies.

Implement the SDK_SPEC envelope fitting order: redact, repair/truncate, then
replace over-budget input/output (larger first), omit metadata last; count a
payload cut then omitted once as omitted. No event is lost merely because its
optional payload is unreadable. Invalid required event identity is diagnosed
and safely dropped rather than sent to a known refusal. Counter reconciliation
must distinguish records accepted into the recorder from invalid calls.

## Delivery lifecycle

A bounded deque plus daemon sender(s) provides background delivery for sync and
async applications. All shared state is guarded. Record calls never wait on the
network. Network work uses http.client with TLS verification, bounded response
reads, timeouts, no automatic cross-origin redirect following and no ambient
proxy credentials. SDK_SPEC determines whole-request and per-event outcomes.
Unknown/malformed 2xx verdicts are dropped once and count toward the breaker;
accepted events reset it. Per-event transient refusal budgets are independent
of request retries. Stable serialized event bytes survive both paths.

Shutdown stops admission, wakes interruptible backoff, drains only within its
deadline, aborts active sockets, and finalizes every accepted event exactly once.
Late worker results cannot mutate final accounting or resurrect queued work.
No timer/worker may keep the host process alive. Concurrent flush/shutdown must
not multiply sender concurrency. Test callback cancellation separately from
recorder transport errors. Document constructing the recorder after fork; guard
inherited instances so a fork cannot deadlock on an inherited lock or resend a
parent process's buffered events.

## Organization

Package directory `packages/sdk-python/`, `src/wayscribe/`, `tests/`, README,
pyproject, LICENSE and NOTICE. Modules:
- `_config.py`, `_diagnostics.py`: validated immutable settings and bounded safe reports.
- `_capture.py`, `_errors.py`, `_event.py`: safe values, masking, envelope fitting.
- `propagation.py`, `timing.py`: transport-independent public helpers.
- `_transport.py`: bounded HTTP, retry decisions, lifecycle-owned queue/sender.
- `recorder.py`: public recorder/journey/wrapper facade and event accounting.
- `_version.py`, `__init__.py`, `py.typed`: build identity and typed public exports.
Split a growing module by a clear responsibility if needed and record the reason.

## Verification

Use unittest so source checks have no mandatory third-party runner. Each runtime
change starts with a failing behavioral test. Local loopback HTTP servers record
the exact bytes and simulate failure/partial success/slow responses; fake clocks
may test retry boundaries without thirty-second sleeps. Capture fixtures using
the real public SDK and HTTP sender, never a second handwritten event builder.
All 35 language-neutral SDK fixtures must run; the two Node-only cases are
reported as skipped, with separate Python hostile-object tests. Run propagation
and HMAC vectors without altering their expected outputs.

The Node integration harness starts isolated PostgreSQL via the existing helper,
spawns the Python fixture driver and replays its captured request bytes to the
real API dry run, checking expected stored fields and rollback. A Python workflow
must also perform real ingestion and demonstrate queryable alias/diff/retry data.
Build a wheel/sdist, install the wheel into a clean temporary environment, and
exercise public imports/recording without a source checkout on sys.path. Test
available Python 3.12/3.13/3.14 locally; validate 3.11 when a local runtime is
available and explicitly record any supported-version gap before publication.

Official references checked during design: Python version support at
https://devguide.python.org/versions/; http.client behavior at
https://docs.python.org/3/library/http.client.html; packaging at
https://packaging.python.org/en/latest/tutorials/packaging-projects/.
