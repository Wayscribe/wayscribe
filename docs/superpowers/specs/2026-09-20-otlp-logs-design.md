# Optional OTLP log ingestion

## Scope

Implement after the native Python and Go recorders, as ADR-065 requires. An
operator enables `OTLP_LOGS_ENABLED=true`; its default is false and `/v1/logs`
does not exist when disabled. The native SDKs always work without it. There is
no new listener, required Collector, database, telemetry exporter or background
service. Traces, metrics, profiles and gRPC remain outside this receiver.

This is an adapter from deliberately annotated log records to the existing
journey model. Generic application logs do not become journeys automatically.
The existing environment API key authenticates the request, and `ingestEvent`
remains the authority for scope, capture policy, redaction, hashing, aliases,
diffs, idempotency and storage. Do not duplicate these rules in the adapter.

## Mapping

Decode an `ExportLogsServiceRequest` and visit resource/scope/log records in
their original order. The record's attributes carry these explicit fields:

| Attribute | Existing event field | Required |
| --- | --- | --- |
| `wayscribe.event.id` | `id` | yes, stable across exporter retries |
| `wayscribe.journey.id` | `journeyId` | yes |
| `wayscribe.entity.type` | `entity.type` | yes |
| `wayscribe.entity.id` | `entity.id` | yes |
| `wayscribe.operation` | `operation` | yes, existing operation vocabulary |
| `wayscribe.name` | `name` | yes |
| `wayscribe.input` | `input` | no, typed AnyValue |
| `wayscribe.output` | `output` | no, typed AnyValue |
| `wayscribe.metadata` | `metadata` | no, map of protocol scalar values |
| `wayscribe.aliases` | `aliases` | no, map of strings |
| `wayscribe.displayable_aliases` | `displayableAliases` | no, array of strings |
| `wayscribe.journey.label` | `journeyLabel` | no |
| `wayscribe.attempt` | `metadata.attempt` | no, positive safe integer |
| `wayscribe.duration_ms` | `durationMs` | no, integer |
| `wayscribe.error` | `error` | no, existing structured error fields |
| `wayscribe.parent_event.id` | `parentEventId` | no |
| `wayscribe.message.id` | `messageId` | no |
| `wayscribe.correlation.id` | `correlationId` | no |

`service.name` in resource attributes supplies `service` and
`deployment.environment.name` supplies `environment`; require both. The key's
environment must match through normal ingestion. Optional resource
`service.version` maps to `deployment.version`. Do not create runtime SDK
identity on behalf of an exporter or infer a host process's language/version.
Do not infer business failure from log severity. Unmapped attributes and body
are ignored; document this prominently beside the example.

Use `timeUnixNano` when nonzero, otherwise nonzero `observedTimeUnixNano`.
Convert decimal nanoseconds with integer arithmetic into UTC milliseconds and
an existing protocol timestamp. Reject a record with neither usable timestamp;
server wall time would make a retry's content different. Map valid nonzero
trace/span IDs to existing trace fields, using lowercase hex. No ID is generated
by this receiver: missing event identity is a permanent record refusal.

Reject duplicate keys in mapped attribute maps and ambiguous AnyValue unions.
Preserve explicit null/empty structured values under the documented AnyValue
mapping. Integer payload values outside the interoperable exact-number range
become decimal strings; binary payload values become base64 strings. Required
identity and numeric event fields retain their required types. Unknown message
fields are ignored for forward compatibility, not turned into event metadata.
Use null-prototype objects or safe data properties for arbitrary map keys.
An explicit `wayscribe.attempt` takes precedence over the metadata entry with
the same name. The caller explicitly names `retried` as its operation for a
retry; the adapter does not infer a second event or wrapper outcome.

## Encoding and resource bounds

Accept `application/json` and `application/x-protobuf`, including identity and
gzip content encoding. Register parsers/error handling in this route's scoped
Fastify plugin so native ingestion remains unchanged. Bound compressed input
and decompressed output before decoding. `OTLP_MAX_REQUEST_BYTES` defaults to
4,194,304 bytes and accepts 1..67,108,864. Accept at most the existing
`MAX_BATCH_EVENTS` records per request; document exporter batch size 100 or less.
An empty export succeeds. Check the whole request's record count before storing.

Use the protobufjs runtime already present in the lockfile as an explicit API
dependency and a checked-in minimal descriptor generated from pinned official
OTLP common/resource/logs/collector schemas, with license/source attribution.
Do not hand-write a protobuf wire decoder or add a complete OTel SDK to the API.
Preserve protobuf merging of duplicate singular message occurrences, including
earlier attribute arrays and distinct AnyValue members needed for semantic
refusals; ordinary duplicate scalar fields remain last-wins. Bound recursive
decoding and AnyValue traversal, including unknown binary groups, resource/scope
counts and attribute counts. Preserve uint64 values until
the field-specific conversion. The JSON decoder must implement OTLP's hex ID
convention rather than protobufjs's ordinary base64 byte conversion. Reject
malformed typed fields instead of coercing them. Test JSON and binary equivalence
with independent literal encodings or an official exporter.

The codec additionally caps one decoded request at 100 resource groups, 100 scope
groups, 10,000 attribute entries (including nested KeyValue entries), and 20,000
AnyValue messages. AnyValue depth is at most 24, counting its root as one. The
binary decoder has request-local budgets of 262,144 uint32 reader operations and
65,536 known message entries; library wire reads are guarded against malformed
field types and scalar overflow without a second wire decoder. JSON preflight
limits structural depth to 128 and structural/token work to 262,144 units before
parsing, including unknown fields. Each opening/closing container, comma, colon,
and opening quote outside a string counts as one JSON work unit; escaped bytes
inside strings do not add units. Numeric lexemes are at most 128 characters;
exponent magnitude is at most 10,000, and exact integer conversion expands no
more than 20 significant decimal digits before range checking. These adapter
bounds may require smaller batches or shallower values than the native event
limits; raising the request byte setting does not raise the structure bounds.

The route shares the request body's configured byte ceiling for both encodings;
all mapped events still pass the existing event size/depth/key limits. A bad
encoding/oversized export fails before any records store. Structured field
refusals after successful decoding are per-record permanent failures. Parse
errors never echo request bytes, attributes, keys or decoder exception messages.

## Responses and retries

Follow the [OTLP HTTP specification](https://opentelemetry.io/docs/specs/otlp/),
checked September 20, 2026: successful exports return HTTP 200; permanent record
refusals use `partialSuccess.rejectedLogRecords` and a bounded safe summary.
The response encoding matches the supported request content type. Failures use
the `google.rpc.Status` shape. Malformed data returns 400, authentication returns
401/403, oversized bodies return 413 and unsupported content encoding returns
415. No arbitrary database/decoder text reaches any response.

A transient database/storage failure returns HTTP 503, without partial-success
fields, so an exporter can retry. Already committed records may be included in
that retry; their required stable event IDs and unchanged mapping make them
duplicates, not extra evidence. Test failure after one stored record explicitly.
Only permanent refusals produce a partial-success response; never tell the
exporter to discard a temporarily unavailable record. Share existing event
metrics and keep adapter counters bounded in label cardinality.

The later project-ingestion control uses HTTP 503 plus Retry-After on this route
and native routes. This preserves the released native SDK's rule that all 4xx
responses are permanent while using a retryable OTLP status. Exclude `/v1/logs`
from the unrelated admin-authentication throttle, just like native ingestion.

## Verification and documentation

Use literal mapping/codec unit tests and a real database-backed route suite.
Cover disabled routing, authentication, project/environment isolation, gzip
limits, malformed/deep protobuf, invalid JSON scalar types, duplicates, mixed
permanent refusals, unknown fields, secret redaction, payload diffs and stable
retry IDs. Check native route tests after parser registration changes.

Finish with a real official OTLP HTTP exporter sending an annotated log to the
local receiver and a query proving the expected journey/alias/diff. The exporter
is test tooling, not a runtime dependency; isolate and remove its temporary
environment. Add a runnable optional example, attribute reference, configuration
documentation, and an ADR stating the adapter's storage/retry choices. Preserve
default Compose/Helm behavior and expose only the two opt-in settings. No public
deployment, registry publication or GitLab execution is part of this work.
