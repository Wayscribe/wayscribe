# Optional annotated OTLP logs

Enable `OTLP_LOGS_ENABLED=true` to expose `POST /v1/logs` on the existing API
listener. It defaults to false; the route is absent when disabled. Native
Node, Python and Go SDKs work without it. No Collector, extra listener, external
telemetry service, or runtime OpenTelemetry SDK is needed. This adapter accepts
HTTP logs only; traces, metrics, profiles and gRPC are unsupported.

**Generic log body, severity and unmapped attributes are ignored.** Explicit
business annotations below create journey evidence. Severity ERROR does not
create a business failure: supply an operation and structured error yourself.
Use an environment API key with `Authorization: Bearer <key>`. An admin token
cannot ingest. All normal project/environment scoping, capture policy, secret
redaction, alias protection, diffs and idempotency pass through native ingestion.

## Attributes

Resource attributes `service.name` and `deployment.environment.name` are
required strings and supply service/environment. The environment must match
the key. Optional string `service.version` supplies deployment.version. No
runtime SDK identity is invented.

| Log attribute | Event field | Required/type |
| --- | --- | --- |
| `wayscribe.event.id` | id | required stable string |
| `wayscribe.journey.id` | journeyId | required string |
| `wayscribe.entity.type` | entity.type | required string |
| `wayscribe.entity.id` | entity.id | required string |
| `wayscribe.operation` | operation | required existing protocol operation |
| `wayscribe.name` | name | required string |
| `wayscribe.input` | input | typed AnyValue |
| `wayscribe.output` | output | typed AnyValue |
| `wayscribe.metadata` | metadata | map of JSON scalars |
| `wayscribe.aliases` | aliases | map of original strings |
| `wayscribe.displayable_aliases` | displayableAliases | array of strings |
| `wayscribe.journey.label` | journeyLabel | string |
| `wayscribe.attempt` | metadata.attempt | positive safe integer, overrides metadata.attempt |
| `wayscribe.duration_ms` | durationMs | protocol integer |
| `wayscribe.error` | error | existing structured error fields |
| `wayscribe.parent_event.id` | parentEventId | string |
| `wayscribe.message.id` | messageId | string |
| `wayscribe.correlation.id` | correlationId | string |

The [event protocol](EVENT_PROTOCOL.md) defines operations, error fields and
field limits. Explicitly use `retried` for a business retry; the adapter never
infers an extra event. Choose a stable event ID and timestamp before exporting;
retries must retain these and every annotation unchanged.

`timeUnixNano` is used when nonzero, otherwise nonzero `observedTimeUnixNano`.
At least one must be usable. Conversion truncates nanoseconds to UTC milliseconds
using integer arithmetic; the receiver never supplies wall time. Valid nonzero
trace/span IDs map independently to lowercase hex. Absent, zero or wrong-length
optional IDs are omitted. JSON uses hex IDs, lowerCamelCase fields and integer
enums, not protobufjs's base64 ID convention.

Absent optional attributes omit fields. A present empty AnyValue or missing
value message maps to null; empty strings, arrays and maps keep their types.
Integers outside the exact interoperable number range become decimal strings;
bytes become base64 strings. Those conversions do not substitute for original
string types in IDs, aliases or known error fields. Nonfinite mapped doubles,
duplicate mapped attribute/map keys and ambiguous AnyValue unions refuse that
record. Metadata allows only null, strings, booleans and finite numbers after
conversion. Use input/output for structured data. Unknown message fields are
ignored for forward compatibility.

## Limits and responses

Send `application/json` or `application/x-protobuf`, with identity (or omitted)
or gzip content encoding. `OTLP_MAX_REQUEST_BYTES` defaults to **4,194,304** and
accepts **1..67,108,864**. The same limit applies separately to compressed input
and expanded bytes. A whole export is decoded and counted before any store.
There are at most **100** records; empty exports succeed. Set your exporter's
maximum batch size to 100 or less (many exporters default above this).

Additional fixed codec ceilings: 100 resource groups, 100 scope groups, 10,000
attribute entries including nested maps, 20,000 AnyValue messages, AnyValue
depth 24 counting the root, 65,536 binary message entries and 262,144 uint32
reader operations. JSON structural depth is 128 and structural/token work is
262,144 units (containers, commas, colons and opening quotes outside strings).
Numeric lexemes are at most 128 characters, exponent magnitude 10,000 and exact
integer expansion 20 significant digits. Raising the byte setting does not
raise these bounds. Native per-event size/depth/key limits still apply to each
mapped envelope (`MAX_EVENT_PAYLOAD_BYTES` defaults to 262,144).

Supported requests receive matching JSON/protobuf responses, including parser
and authentication failures. Unsupported media types use JSON. Responses are
bounded to 256 bytes and contain fixed safe summaries, never request values or
library/database errors.

| HTTP | Meaning |
| --- | --- |
| 200 | full success, empty export, or permanent partial success |
| 400 | malformed JSON/protobuf or malformed/truncated gzip |
| 401/403 | transport credentials refused |
| 413 | compressed/expanded byte or codec structure/count limit exceeded |
| 415 | unsupported content type or content encoding |
| 503 | transient authentication database/storage failure; retry unchanged export |

Full JSON success is `{}`. Permanent record refusals return, for example,
`{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"Some log records were rejected."}}`.
Per-record environment mismatches, conflicting IDs, mapping errors and
unstorable PostgreSQL text are permanent refusals. HTTP failures use
`google.rpc.Status` with fixed code/message pairs.

On the first transient failure the receiver returns 503 **without partialSuccess**
and stops starting subsequent records. Earlier commits remain; nothing is
deleted to compensate. Retry the identical export: stable IDs make prior commits
duplicates instead of extra evidence. Permanent partial success is not retryable.
The failed-admin-authentication address throttle does not cover this route.

## Example and local verification

See [the runnable official Python exporter example](../examples/otlp-logs/README.md).
It pins the official SDK/exporter to 1.44.0 and sends gzip protobuf directly to
your local receiver. This is optional example/test tooling, never an API runtime
dependency. Query the alias `crm-otlp-9001`, journey `jrn_otlp_official`, and event
`evt_otlp_official_transform` to see server redaction and the phone-field diff.

Compose source and published-image definitions expose only
`OTLP_LOGS_ENABLED` and `OTLP_MAX_REQUEST_BYTES`; Helm exposes
`api.otlpLogsEnabled` and `api.otlpMaxRequestBytes`. Defaults preserve existing
behavior. Source implementation and local rendering do not imply published
images or a deployment contain the receiver.
