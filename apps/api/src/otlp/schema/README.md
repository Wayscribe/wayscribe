# Pinned OTLP log schema

The runtime descriptor is generated from the checked-in official sources below.
No `.proto` file, source JSON, generator, filesystem access or network access is
needed to decode a request at runtime.

| Source | Immutable revision |
| --- | --- |
| OpenTelemetry common/resource/logs/collector logs protos | `open-telemetry/opentelemetry-proto@790608c4d51e6ffc12210b541e8514cbed9e91a4` |
| `google/rpc/status.proto` | `googleapis/googleapis@ebd1d23ac613b177828dad42ad8dfb13ba498279` |
| `google/protobuf/any.json` | `protobufjs@7.6.6` bundled `common["google/protobuf/any.proto"]` |

The source files are unmodified. `SHA256SUMS` records their byte hashes and the
license hashes. OTLP and googleapis sources are Apache-2.0; their copyright and
license headers are retained. `sources/LICENSE` is the upstream OTLP Apache-2.0
license. The protobufjs distribution license is `sources/PROTOBUFJS-LICENSE`.
Source URLs are the respective repositories' `raw.githubusercontent.com` URLs
with the revisions above and paths below `sources/`.

From the repository root, using the existing pnpm installation:

```sh
node apps/api/src/otlp/schema/scripts/generate.mjs
node apps/api/src/otlp/schema/scripts/generate.mjs --check
```

Generation uses protobufjs `parse`, `Root.resolveAll` and `Type.toJSON` with the
exact runtime dependency version in the API manifest. The generator verifies
that the checked-in Any descriptor matches that pinned distribution. Only
messages/enums reachable from ExportLogsServiceRequest, ExportLogsServiceResponse
and google.rpc.Status are emitted. Source options, reserved declarations and
unreachable service/LogsData/flag declarations are not runtime dependencies.
The official Status.details field and its Any dependency remain in the schema;
response construction never emits details.

`descriptor.ts` emits to `dist/otlp/schema/descriptor.js` in the API build. The
Dockerfile removes every `src` directory after building, leaving that compiled
file while discarding `.proto`, source JSON, hashes, README and generator.
The API's production dependency is explicit `protobufjs: 7.6.6`. No OpenTelemetry
runtime SDK or exporter is added.

## Decoder boundary

The codec uses an isolated Root and immutable decoder wrappers. Per-request
Reader frames hold counts and schema context; no global limits are changed.
The protobufjs decoder still owns value reads, allocation, message-boundary
checking, skipType recursion and field skipping. Guards reject known wrong wire
types, zero-number tags, malformed/overflowed varint read boundaries and
mismatched unknown group IDs. The library's recursion ceiling is 100. Its extra
decode/skipType depth parameters are forwarded even though its declarations omit
them. Tests are required when changing the pinned runtime.

Duplicate singular messages are merged after library decoding: only own fields
participate, repeated arrays append in wire order, nested messages merge and
scalars use their last value. Distinct AnyValue members deliberately survive.
All occurrences still consume the decode budgets; owned arrays append in place
to avoid quadratic copies. Merge state never crosses a record or request.

Canonical 64-bit values are bigint, derived exactly from the library's Long
words for protobuf or source numeric lexemes for JSON. Bytes are Buffer values.
ProtoJSON numbers use Node24's JSON.parse reviver context.source; no rounded
Number is used to recover a 64-bit integer. Integer strings and exponent forms
are checked for exact integrality/range before bounded BigInt conversion.

Known fields are schema-type-checked. Unknown fields are ignored. The OTLP JSON
conventions are lowerCamelCase keys, integer enum values and hexadecimal IDs;
AnyValue bytesValue remains base64. Null fields mean unset, null repeated
entries are invalid. An unset AnyValue and a present empty AnyValue are distinct;
multiple union members and repeated attribute keys survive for the mapper.
Profiling-only stringValueStrindex/keyStrindex are typed but semantically ignored.
Trace/span byte lengths and all-zero IDs remain available for record semantics.

## Fixed request bounds

Counts are cumulative across a whole export, including ignored known fields:

| Limit | Ceiling |
| --- | ---: |
| Absolute decoder body bytes | 67,108,864 |
| ResourceLogs | 100 |
| ScopeLogs | 100 |
| LogRecord | 100 (`MAX_BATCH_EVENTS`) |
| KeyValue entries, including nested lists | 10,000 |
| AnyValue messages | 20,000 |
| AnyValue depth, root = 1 | 24 |
| All known messages | 65,536 |
| Reader.uint32 calls, including unknown fields | 262,144 |
| JSON structural depth | 128 |
| JSON work units | 262,144 |
| Numeric lexeme characters | 128 |
| Integer exponent absolute magnitude | 10,000 |
| Encoded response bytes | 256 |

JSON preflight runs before JSON.parse: each opening/closing container, comma,
colon and opening quote outside strings counts one work unit. An escaped byte
inside a string is skipped with its backslash; string content contributes no
structural work units. Raw byte length independently bounds the linear scan and
string allocations. Unknown containers/fields consume these budgets too.
Message and semantic counters are checked before each binary message allocation,
and again during canonical conversion; JSON preflight bounds allocation before
schema conversion. Decimal expansion never produces more than 20 significant
digits and exponentiation is not used.

The route must enforce its configured compressed/decompressed body limit before
calling this codec; its default is 4,194,304 and its maximum is this absolute
ceiling. These aggregate adapter limits can require smaller batches or depth
than the native per-event size/depth/key limits. No route is registered here.

Failures expose only `OtlpDecodeError.code`: `invalid_otlp` or
`otlp_limit_exceeded`, with the same fixed message and no parser cause. Response
encoding accepts only the fixed exported OTLP_STATUS_MESSAGES code/message
pairs, counts 0..100, and OTLP_PARTIAL_MESSAGE. Full success omits partialSuccess.
Invalid response construction throws fixed `invalid_otlp_response` RangeError.
