# Wayscribe Python SDK — development preview

Distribution: `wayscribe-sdk`. Import: `wayscribe`. Version: `0.1.0a1`.
This package is **unpublished**. Python 3.11 or newer is required. Runtime code
uses only the standard library; setuptools is a build dependency only.

This first implementation provides safe capture, configuration, protocol
serialization, propagation and timing helpers. The recorder facade and background
HTTP delivery follow in Task 2. There is no `create_recorder` export yet, and this
preview does not make network requests or start background threads.

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
Delivery defaults are represented in `Config` for Task 2, which owns sending.
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

This core is not a full SDK conformance claim. Real delivery, all 35 applicable
SDK fixtures, API dry-run replay, lifecycle checks and clean-wheel installation
are downstream gates. Create the future recorder after fork; inherited instances
must be rejected before any shared lock is acquired.
