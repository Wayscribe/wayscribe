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
cannot ingest. The key is checked before the body is read, inflated or decoded,
so an unauthenticated request never costs a decompress. All normal
project/environment scoping, capture policy, secret redaction, alias protection,
diffs and idempotency pass through native ingestion.

**No in-process redaction happens on this path.** The Node, Python and Go SDKs
redact secret-named fields inside your process before anything is sent; an
OpenTelemetry logging SDK does not. Every attribute, including
`wayscribe.input`/`wayscribe.output`, crosses the network as your code wrote it,
and is redacted only when it reaches this server. If raw values must not leave
the host, run an OpenTelemetry Collector with the
[`redaction` processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/redactionprocessor)
(or `transform`/`attributes` processors) in front of this endpoint, and use TLS.

## Attributes

Resource attribute `service.name` is a required string and supplies the service.
`deployment.environment.name` is optional: when present it must be a string and
must match the key's environment (otherwise `unauthorized_environment`); when
absent, the record inherits the environment the API key is scoped to. A record
whose environment neither the resource nor the key determines is refused with
`environment_unresolved`. Optional string `service.version` supplies
deployment.version. No runtime SDK identity is invented.

A stock OpenTelemetry emitter needs no `deployment.environment.name` and no
event id attribute. It still states the journey annotations below
(`wayscribe.journey.id`, entity, operation, name): a generic log record carries
no journey, entity or operation, and the adapter does not invent one.

| Log attribute | Event field | Required/type |
| --- | --- | --- |
| `wayscribe.event.id` | id | optional stable string; see Event IDs |
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
infers an extra event. OpenTelemetry `exception.*` attributes are ignored; use
`wayscribe.error` for a business failure.

### Event IDs

The event id is, in order of preference:

1. `wayscribe.event.id`, a string;
2. otherwise the OpenTelemetry `log.record.uid` log attribute, a string;
3. otherwise `otlp_<64 hex>`, derived from the record's content.

The derived id is an HMAC-SHA256 under a key derived from the server's
`ENCRYPTION_KEY` (the content-hash subkey), so it cannot be used to confirm a
guessed secret offline. Its input is: the resolved environment name; the whole
resource (every attribute, not only mapped ones); the instrumentation scope
(name, version, attributes); and the whole log record as decoded:
`timeUnixNano` and `observedTimeUnixNano` at full nanosecond precision,
`severityNumber`, `severityText`, body, every attribute including unmapped ones,
flags, trace and span IDs, `eventName` and dropped-attribute counts. Unknown
fields and schema URLs are not part of it. A Collector retry resends the same
record, so it derives the same id and deduplicates; the same record sent as
JSON or protobuf derives the same id too. Two records identical in all of those
fields are one event. During an `ENCRYPTION_KEY` rotation the receiver also
looks for the id the previous key derives, so a retry that straddles the
rotation still deduplicates. Anything that changes a field above between
attempts (for example a processor adding a changing attribute) makes a new
event: prefer `log.record.uid` or `wayscribe.event.id` when you can set one.

Whatever the source, retries must retain the id, timestamp and every
annotation unchanged.

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
ignored for forward compatibility, except that a JSON export whose top-level
object has fields but no `resourceLogs` (for example snake_case
`resource_logs`) is refused with 400 rather than accepted as empty. `{}` is an
empty export.

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
and authentication failures. Unsupported media types use JSON. Authentication
is checked first, so an unauthenticated request gets 401 whatever its body,
encoding or media type. Responses are bounded to 256 bytes and contain fixed
safe summaries or refusal codes, never request values or library/database
errors.

| HTTP | Meaning |
| --- | --- |
| 200 | full success, empty export, or permanent partial success |
| 400 | malformed JSON/protobuf, malformed/truncated gzip, or JSON with no `resourceLogs` among its top-level fields |
| 401/403 | transport credentials refused |
| 413 | compressed/expanded byte or codec structure/count limit exceeded |
| 415 | unsupported content type or content encoding |
| 500 | a non-transient server failure (for example a schema defect); do not retry unchanged |
| 503 | transient database failure: connection, timeout, too many connections, restart, serialization or deadlock; retry unchanged export |

Full JSON success is `{}`. Permanent record refusals return the rejected count
and the first three refusal codes, in the order first seen, with their counts,
for example
`{"partialSuccess":{"rejectedLogRecords":"3","errorMessage":"Rejected: missing_attribute x2, unauthorized_environment x1"}}`.
More codes are summarized as `(+N more codes)`. The same codes and counts are
logged at info level; neither contains record values. Mapping codes are
`missing_attribute`, `invalid_attribute_type`, `invalid_attribute_value`,
`environment_unresolved`, `duplicate_attribute`, `duplicate_map_key`,
`ambiguous_any_value`, `invalid_any_value`, `invalid_timestamp` and
`invalid_event` (the mapped event failed protocol validation, such as an
unknown operation); ingestion codes such as `unauthorized_environment`,
`event_id_conflict`, `payload_too_large` and `unstorable_payload` pass through
unchanged. All are permanent refusals. HTTP failures use `google.rpc.Status`
with fixed code/message pairs.

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
