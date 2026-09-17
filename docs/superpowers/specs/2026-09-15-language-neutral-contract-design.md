# A language-neutral contract, the part that does not depend on the name: design

Date: 2026-09-15. Status: approved for planning (autonomous work, Phase 4 of
`flight-recorder-adoption-todos.md`).

## Why

The owner approved a language strategy on 2026-09-15 (D2): publish a
language-neutral contract, then accept OpenTelemetry logs over OTLP, add Node
framework adapters for the stacks pilot teams run, and build a second native SDK
only when a pilot team needs one. The rejected alternatives were a native SDK per
language, which is where solo projects stall, and becoming a pure OpenTelemetry
backend, which would turn the input/output pairing the diff depends on into a
convention nobody enforces.

Today the contract exists only as TypeScript. `packages/protocol` holds Zod
schemas, `apps/api` holds the ingestion rules in code, and
`docs/NODE_SDK_SPEC.md` describes one SDK in the language it is written in. A
person writing a Python recorder, or a mapping from OTLP log records, has nothing
to build against and no way to check the result.

The product is also about to be renamed (to Wayscribe, decided 2026-09-17), so every wire
identifier that carries the product name is going to change: the `x-flight-*`
headers, the `flight*` queue attributes, the `FLIGHT_RECORDER_*` environment
variables, the `fr_` key prefix, and the `flight_recorder_*` metric names. This
design covers only what the rename does not touch. Freezing a name now would mean
publishing a contract and breaking it in the same month.

## Scope

In scope, from the handoff file's Phase 4: C1 (the decision), C2 (JSON Schema),
C3 (the ingestion contract), C5 (`docs/SDK_SPEC.md`), C6 (dry-run validation),
C7 (conformance fixtures).

Out of scope, and named as follow-ups wherever a document would otherwise want
them:

- **C4, the propagation spec and its header vectors.** Every requirement in it is
  a name: header names, queue attribute names, the value grammar, the `jrn_`
  prefix. It waits for the rename. `docs/SDK_SPEC.md` refers to "the propagation
  spec, pending" and states only the rules that survive a rename: the three
  levels and their default, that aliases never propagate, that the entity id
  propagates only at `full`, and that an SDK never writes `traceparent`.
- **Phase 5, OTLP log ingest.** Its attribute names take the product prefix, so
  the mapping cannot be written yet. The conformance fixture format reserves a
  third layer for it (`layer: "otlp"`) and nothing more.
- **Renaming any wire identifier.** No document produced here introduces a new
  one. The `fr_` prefix, the `x-flight-*` headers, the environment variables and
  the metric names appear only where an existing document already names them.

## The decision (C1)

### ADR-049: The contract is the deliverable, and a second SDK waits for a team that needs one

Next free number: the log ends at ADR-048, so the strategy decision is **ADR-049**
and the dry run's own decision, written in the task that builds it, is
**ADR-050**. `tests/docs-truth.test.ts` checks the README's ADR count and that the
numbers run without gaps, so the README's "48 ADRs" becomes "49" in the first task
and "50" in the dry-run task.

The ADR records, in the repository's voice:

- **Context.** ADR-003 chose TypeScript everywhere and left "language-neutral
  protocol design is still required" as a consequence nobody has had to satisfy.
  `AGENTS.md` bans Python, Go, Java and .NET SDKs without an architecture
  decision. ADR-010 keeps OpenTelemetry optional and says V0 will not implement an
  OTLP receiver. The product now needs teams that are not this repository to be
  able to send events, and the cheapest thing that makes that true is not a second
  SDK.
- **Decision.** Publish the contract as artefacts a non-TypeScript author can use:
  JSON Schema generated from the Zod schemas, an HTTP ingestion contract, a
  language-neutral SDK specification with MUST and SHOULD requirements, a dry-run
  endpoint, and conformance fixtures that any implementation can run through it.
  Zod stays the source of truth; the JSON Schema is generated and checked for
  drift, never hand-edited. OpenTelemetry log records over OTLP HTTP become a
  planned optional ingestion path rather than something V0 refuses, which amends
  ADR-010 in wording and not in principle: no deployment of this product requires
  OpenTelemetry. Framework adapters are separate packages over the SDK's public
  API. A second native SDK is built when a pilot team needs one, against
  `docs/SDK_SPEC.md`, and it is not considered done until it passes the
  conformance fixtures through the dry run.
- **Also decided here, because the contract cannot be published while it is
  ambiguous.** `AGENTS.md` says unknown protocol fields "must be preserved where
  safe". Ingestion accepts them, drops them, and does not include them in the
  content hash, because there is no column to store them in and an unvalidated,
  unredacted field is not something to write to one. The rule means "accepted, not
  refused", which is what makes an additive optional field a compatible change,
  and the ADR says so. The `AGENTS.md` line is reworded to match.
- **Consequences.** Contract artefacts become things that can rot, so each has a
  test that fails when it drifts: schema drift, Zod-Ajv parity, the documented
  limits against the constants, and fixtures that run against the real API.
  A conformance fixture change is a contract change and is reviewed as one. The
  dry run is a new refusal path that leaves no row behind, which is a small new
  disclosure surface (see "Security consequences"). Wire names are not frozen by
  this decision, and the propagation spec and the OTLP mapping wait for the
  rename.
- **Rejected.** A native SDK per language (cost of the Node SDK's Phases 3 and 4
  each time, plus maintenance forever). Becoming a pure OpenTelemetry backend (the
  input/output pairing becomes unenforced convention, and it is a pivot before any
  user asked for one).

### The exact `AGENTS.md` edit

In "Do not add during V0", the line

```text
- Python, Go, Java, or .NET SDKs
```

becomes

```text
- a native SDK in another language before a pilot team needs one (ADR-049); when
  one is built it is built against `docs/SDK_SPEC.md` and has to pass the
  conformance fixtures
```

In "Event protocol rules", the line

```text
- Unknown fields must be preserved where safe.
```

becomes

```text
- Unknown fields are accepted rather than refused. Ingestion does not store them
  and does not hash them (ADR-049).
```

Nothing else in `AGENTS.md` changes. The "Do not add" list keeps every other
entry, including hosted SaaS, accounts and AI features.

### The exact `docs/ROADMAP.md` edits

- Under **Next**, add one item: "A contract somebody else can build against",
  describing what this work lands (generated JSON Schema, `docs/INGESTION_CONTRACT.md`,
  `docs/SDK_SPEC.md`, dry-run validation, conformance fixtures) and noting that
  the propagation spec and its test vectors wait for the rename because every
  identifier in them carries the product name.
- Under **Next**, add a second item: "OpenTelemetry log ingest", one paragraph,
  explaining that `POST /v1/logs` accepting OTLP over HTTP is the next step after
  the rename, that gRPC is out of scope, and that the Node SDK stays the
  recommended path for Node.
- Under **Later**, rewrite two existing items rather than adding any: "Fastify,
  Express, and fetch/Axios adapters" gains "for the stacks pilot teams actually
  run, as separate packages over the SDK's public API (ADR-049)", and "a Go or
  Python SDK" becomes "a second native SDK when a pilot team needs one, built
  against `docs/SDK_SPEC.md` and checked with the conformance fixtures". The
  parenthetical about proving the protocol is genuinely language-neutral moves to
  the Next item, because the fixtures are what prove it now.

Nothing in "Where this actually is" changes. The test and install counts there
are still true.

## JSON Schema (C2)

### Draft version

**JSON Schema draft 2020-12.** It is what `z.toJSONSchema` targets by default in
Zod 4, what Ajv's `ajv/dist/2020` entry point validates, and what OpenAPI 3.1
aligns with, so a generated client or a documentation tool can consume the files
unchanged. Draft-07 would buy compatibility with older validators and cost the
match with the generator.

### Which schemas

Nine files, all generated:

| File | Zod source | What it is |
| --- | --- | --- |
| `event.schema.json` | `journeyEventSchema` (`packages/protocol/src/event.ts`) | one journey event |
| `envelope.schema.json` | `envelopeSchema` plus the version check | `{ protocolVersion, event }` |
| `batch-request.schema.json` | `batchRequestSchema` (new) | the body of `POST /v1/events/batch` |
| `batch-response.schema.json` | `batchResponseSchema` (new) | `{ data: { results, dryRun? } }` |
| `event-result.schema.json` | `eventResultSchema` (new) | one per-event verdict |
| `event-accepted.schema.json` | `eventAcceptedSchema` (new) | the 202 body of `POST /v1/events` |
| `error-body.schema.json` | `errorBodySchema` (new) | `{ error: { code, message, requestId, details? } }` |
| `stored-event.schema.json` | `storedEventSchema` (new) | an event as the API returns it, which is what a dry run previews |
| `stored-journey.schema.json` | `storedJourneySchema` (new) | a journey as the API returns it |

The last five describe shapes the API already returns and that nothing validates
today. Writing them as Zod first, and validating real responses against the
generated schema in the integration tests, is what keeps them honest; a
hand-written schema for a response is a second source of truth that drifts.

`batch-request.schema.json` types `events` as an array of at most
`MAX_BATCH_EVENTS` items of any shape, **not** an array of envelopes. A batch
containing one invalid event is accepted by the route and refused per event, so a
schema that rejected the whole request would describe a server that does not
exist. Its description says where per-item validation lives.

### Where the files live and how they are named

```text
packages/protocol/schemas/0.1/
  batch-request.schema.json
  batch-response.schema.json
  envelope.schema.json
  error-body.schema.json
  event-accepted.schema.json
  event-result.schema.json
  event.schema.json
  stored-event.schema.json
  stored-journey.schema.json
```

The directory is the protocol version, so protocol 0.2 gets its own directory and
0.1 stays readable beside it. The response and error shapes are versioned with it
even though they belong to the HTTP surface, because a reader wants one
self-contained set for the version they are sending.

`packages/protocol/package.json` exports them as `./schemas/*`, next to the
existing `./fixtures/*.json` export, so a future tool can resolve them from the
package rather than from a path inside the repository.

### The `$id` scheme

Each file's `$id` is **its own basename**, and every `$ref` is a sibling
basename:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "envelope.schema.json",
  "properties": { "event": { "$ref": "event.schema.json" } }
}
```

A relative `$id` resolves against whatever URI the file was retrieved from, so
the same bytes work when they are read from disk, served from a documentation
site, or copied into another repository. No product name, no domain, nothing to
rewrite at the rename. An absolute `$id` would have to name a host that does not
exist yet and would be wrong twice: once when the domain is registered and again
if it changes.

`title` and `description` in every file are written without the product name for
the same reason. Ajv keys a relative `$id` by that string, and a sibling `$ref`
resolves against it, which was confirmed by compiling the pair before this was
written.

### Generator and CI drift check

`packages/protocol/src/json-schema.ts` exports `buildJsonSchemas(): Record<string, JsonSchema>`
and `serializeSchema(schema): string`. It is one module so that the generator and
the drift test cannot disagree about formatting.

- `pnpm --filter @flight-recorder/protocol run schemas` builds the package and
  runs `packages/protocol/scripts/write-schemas.mjs`, which writes each file.
- The drift check is a **unit test**, `packages/protocol/src/json-schema.test.ts`,
  not a `.gitlab-ci.yml` job. It builds the schemas in memory, serializes them
  with the same function, and compares byte for byte against the committed files,
  failing with the command to run. That runs in the existing `unit` job, runs on a
  laptop, and needs no git inside the container: the CI image is `node:24-alpine`
  and has no git, which is the same reason `tests/docs-truth.test.ts` walks the
  tree itself instead of asking `git ls-files`. No new CI job is added.
- The generated directory is added to `.prettierignore`, with a comment saying the
  generator owns the formatting. Prettier reflows JSON arrays that fit on one
  line, which would make `pnpm format` and the generator fight each other forever.

Serialization is `JSON.stringify(schema, null, 2)` with a trailing newline, and
object keys are emitted in the order the generator produced them, so a diff shows
a real change rather than a reordering.

### The parity test

`packages/protocol/src/json-schema.test.ts` also runs every protocol fixture
through both validators and requires identical accept and reject results:

- the five existing files in `packages/protocol/fixtures/`,
- a new `packages/protocol/fixtures/v0.1-boundaries.json`, an array of
  `{ name, envelope, valid }` cases covering the boundaries this design was
  written against (below),
- and every envelope that appears in a conformance case's `setup` or `send`
  (C7), so a fixture cannot be added that the two validators disagree about.

The Zod side is `parseEnvelope`, not `envelopeSchema`, because `parseEnvelope` is
what ingestion calls: it checks the version before the event, which is where
`unsupported_protocol_version` comes from. The Ajv side is the generated
`envelope.schema.json` with `event.schema.json` added to the same instance. The
comparison is accept versus reject only. JSON Schema has no way to say which of
two refusals applies, so the test also asserts that a rejected fixture's expected
code is one of `invalid_event` or `unsupported_protocol_version`; every other
refusal in this system comes from outside the schema and must be accepted by
both validators.

Ajv is configured `new Ajv2020({ strict: true, allErrors: true, validateFormats: false })`.
Formats are annotations in 2020-12, and the generator emits a `pattern` beside
`format: "date-time"` that is strictly narrower, so asserting the format would
add a dependency (`ajv-formats`) that can only refuse things the pattern already
refuses.

### Ajv version and dependency policy

**`ajv` `^8.20.0`, a devDependency of `@flight-recorder/protocol` only.** No
runtime code imports it, so it never reaches `dist` and never reaches the runtime
image, which is what ADR-043 is about. Version 8.20.0 is already in the lockfile,
pulled in by `@fastify/ajv-compiler` for `fastify`, so the install gains an
importer entry rather than a package, `pnpm audit`'s surface does not change, and
the pinned-forward overrides in `pnpm-workspace.yaml` are untouched. `ajv-formats`
is deliberately not added.

### What JSON Schema cannot express

Measured, not guessed: `z.toJSONSchema(journeyEventSchema, { target: "draft-2020-12", io: "input", unrepresentable: "throw" })`
and the same call for `envelopeSchema` were run against the real schemas on Node
24.19.0 with Zod 4.6.4. **Neither threw.** Zod has no construct here it refuses to
represent. Every gap below is a semantic one, found by running both validators
over boundary inputs, and each becomes a line in `docs/INGESTION_CONTRACT.md` and
a case in `v0.1-boundaries.json`.

The parts of the generated output that carry the gaps, with the timestamp
pattern abbreviated at its two `...` and written out in full in the generated
file:

```json
"timestamp": {
  "type": "string",
  "format": "date-time",
  "pattern": "^(?:(?:\\d\\d[2468][048]|...)-02-29|\\d{4}-(?:...))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$"
},
"input": {},
"output": {},
"aliases": {
  "type": "object",
  "propertyNames": { "type": "string", "maxLength": 128 },
  "additionalProperties": { "type": "string", "maxLength": 512 }
},
"metadata": {
  "type": "object",
  "propertyNames": { "type": "string", "maxLength": 128 },
  "additionalProperties": {}
}
```

and, for the envelope:

```json
{
  "properties": {
    "protocolVersion": { "type": "string", "minLength": 1, "maxLength": 16 },
    "event": {}
  },
  "required": ["protocolVersion", "event"]
}
```

1. **The supported protocol version is not in the Zod schema at all.**
   `envelopeSchema` types `protocolVersion` as a 1-to-16-character string and
   `event` as `unknown`; `parseEnvelope` then calls `isSupportedProtocolVersion`
   and only afterwards validates the event, so that a future version produces
   `unsupported_protocol_version` rather than a pile of field errors. The
   generator therefore **composes** `envelope.schema.json` rather than emitting
   `z.toJSONSchema(envelopeSchema)` verbatim: `protocolVersion` becomes
   `{ "const": "0.1" }` and `event` becomes `{ "$ref": "event.schema.json" }`.
   The composition is one of the things the parity test exists to check.
2. **Which refusal applies is not expressible.** A validator can say a document is
   invalid; it cannot produce `unsupported_protocol_version` versus
   `invalid_event`, nor the ordering that decides between them, nor
   `error.details[].path`.
3. **Zod strips unknown keys; the schema permits them.** In `io: "input"` mode no
   `additionalProperties: false` is emitted, which is correct for what the server
   accepts, but the parsed event that is stored and hashed has had unknown keys
   removed. Accept and reject agree; what is kept does not. The `io: "output"`
   schema does emit `additionalProperties: false`, and it is not what we publish,
   because the contract describes what a sender may send.
4. **`z.record` drops a `__proto__` key.** Verified: an event whose `aliases` is
   `{"__proto__": "x", "b": "y"}` parses successfully and comes back as
   `{"b": "y"}`, and `metadata` behaves the same way; `input` and `output`, being
   `z.unknown()`, keep it. Both validators accept the document, so this is not a
   parity failure but silent data loss, of exactly the class
   `docs/WHAT_RUNNING_IT_FOUND.md` records ("a `__proto__` key silently
   destroyed"). The conformance work fixes it rather than blessing it: see the
   fixture list.
5. **Regular expression dialect.** The generated `pattern` uses `\d`, which is
   ASCII digits in ECMAScript and Unicode decimal digits in Python's `re` and in
   .NET. A validator in one of those languages would accept a timestamp written
   in Arabic-Indic digits that Zod rejects. The generator rewrites `\d` to `[0-9]`
   in generated patterns for that reason, which is semantics-preserving under
   ECMAScript and removes the divergence elsewhere. The rewrite is asserted by a
   test that no generated pattern contains `\d`, and the parity test covers the
   behaviour.
6. **`format: "date-time"` is an annotation, and RFC 3339 is looser than the
   pattern.** RFC 3339 admits a lowercase `t` and `z` and a leap second; the
   pattern refuses both. Since a validator that asserts formats can only intersect
   the two, the published schema is safe either way, and the contract says the
   pattern is the assertion.
7. **Numbers are judged after IEEE-754 parsing.** `durationMs: 5.0` is an integer
   to both validators because the JSON parser produced the number 5. A validator
   over arbitrary-precision numbers would disagree about
   `2147483647.0000000001`, which JavaScript parses to `2147483647`. Senders are
   told to write integers as integers, and integers beyond 2^53 as strings: the
   server parses payload numbers as doubles, so `9007199254740993` is stored as
   `9007199254740992`.
8. **String lengths agree, and that was worth checking.** For the schema's own
   maxima, Zod 4 and Ajv 8 both count Unicode code points, so 128 emoji pass a
   `max(128)` and 129 fail in both. (Ajv's deprecated `unicode: false` counts
   UTF-16 units and disagrees.) The separate structural cap on any one string,
   `max_string_length_exceeded`, is not in the schema at all and counts UTF-16
   code units, because `checkLimits` measures with `String.length`. The contract
   states the unit beside each limit, since they differ.
9. **Everything ingestion enforces outside the schema.** None of these can appear
   in JSON Schema and all of them refuse events: the serialized size limit
   (`MAX_EVENT_PAYLOAD_BYTES`, 262,144 bytes over the whole envelope), structural
   limits (depth 32, 1,000 keys or elements per object or array, 65,536 code units
   per string), the batch ceiling of 100 (expressible as `maxItems`, and it is
   emitted, but the refusal code and status are not), the key's environment
   matching `event.environment`, the journey's environment, the content hash for a
   repeated event id, and text PostgreSQL cannot store (a NUL byte, an unpaired
   surrogate), which is only discovered when the insert fails.
10. **Duplicate keys in one JSON object.** The document is valid JSON Schema
    either way; which value survives is the parser's business. JavaScript keeps
    the last. The contract tells senders not to do it.

## The ingestion contract (C3)

### Where it lives

A new **`docs/INGESTION_CONTRACT.md`**, normative for `POST /v1/events` and
`POST /v1/events/batch`. `docs/API_SPEC.md` sections 3 and 4 shrink to a short
summary and a link; the admin, read, replay and deletion routes stay where they
are. Two reasons for a separate file rather than a longer API_SPEC: the audience
is somebody writing a client in another language, who should not have to read
about replay destinations to send an event; and `AGENTS.md`'s source-of-truth
order puts "Event and API contracts" third, so having exactly one file that owns
ingestion makes conflicts resolvable.

It is also where the conformance case format is specified, because a case is a
request to these routes.

### What it states

1. **Routes, transport and authentication.** `POST /v1/events` (one envelope,
   `202` with `{ data: { eventId, journeyId, status, duplicate } }`) and
   `POST /v1/events/batch` (`{ events: [...] }`, `202` with
   `{ data: { results } }`, one result per event, in order, matched by position).
   `Content-Type: application/json`, UTF-8. `Authorization: Bearer <api key>`,
   exactly the scheme, one space and the token, scheme case-insensitive, anything
   after the token a `401`. An API key names one project and one environment and
   may only ingest; an admin token is refused with `401` (ADR-029). Ingestion is
   not covered by the failed-credential throttle, so a misconfigured service
   cannot lock an operator out, and `TRUSTED_PROXY_COUNT`, which only feeds that
   throttle, has no effect here.
2. **Transport refusals that happen before the route runs**, with the status as
   the stable part: `413` when the body exceeds the body limit, `415` for a
   content type with no parser, `400` for a body that is not valid JSON, `400` for
   an empty body with a JSON content type. Bodies are parsed before
   authentication, so a malformed body under a bad key is a `400`. The codes these
   carry today come from Fastify (`FST_ERR_CTP_BODY_TOO_LARGE`,
   `FST_ERR_CTP_INVALID_MEDIA_TYPE`, `FST_ERR_CTP_INVALID_JSON_BODY`,
   `FST_ERR_CTP_EMPTY_JSON_BODY`); the contract prints them and says plainly that
   they are the framework's vocabulary, that a client should branch on the status,
   and that replacing them with codes this API owns is a wire change that belongs
   in the rename window rather than here.
3. **Limits, with their configuration names and defaults.**

   | Limit | Name | Default | Refusal |
   | --- | --- | --- | --- |
   | Serialized size of one envelope | `MAX_EVENT_PAYLOAD_BYTES` | 262,144 bytes | per event, `payload_too_large`, 400 |
   | Events in one batch | fixed, `MAX_BATCH_EVENTS` in the protocol package | 100 | whole request, `payload_too_large`, 400 |
   | Request body | derived: `MAX_BATCH_EVENTS * MAX_EVENT_PAYLOAD_BYTES + 64 KiB` | about 25 MiB | whole request, 413 |
   | Nesting depth | fixed | 32 | per event, `max_depth_exceeded`, 400 |
   | Keys or elements in one object or array | fixed | 1,000 | per event, `max_keys_exceeded`, 400 |
   | Length of one string | fixed | 65,536 UTF-16 code units | per event, `max_string_length_exceeded`, 400 |
   | Statement time | `DATABASE_STATEMENT_TIMEOUT_MS` | 15,000 ms | per event, `query_timeout`, 503 |
   | Full payload capture | `ALLOW_FULL_PAYLOAD_CAPTURE` plus the environment's own `full-payload` | off | changes what is stored, never refuses |

   The size limit is measured over the whole envelope as the server received it,
   not over `input` alone, and the structural limits are measured before anything
   walks the payload. The numbers in this table are asserted against the constants
   by `tests/docs-truth.test.ts`, in the style ADR-040 established.
4. **Per-event result codes, and which are transient.** One table, checked row by
   row against a single registry in `packages/protocol/src/errors.ts`, so the
   document and the code cannot drift.

   | Code | Status | Retry | Meaning |
   | --- | --- | --- | --- |
   | `invalid_event` | 400 | no | the event did not match protocol 0.1; `details` names the fields |
   | `unsupported_protocol_version` | 400 | no | the envelope's version is not served |
   | `payload_too_large` | 400 | no | the envelope exceeded `MAX_EVENT_PAYLOAD_BYTES` |
   | `max_depth_exceeded` | 400 | no | nesting beyond 32 |
   | `max_keys_exceeded` | 400 | no | more than 1,000 keys or elements in one object or array |
   | `max_string_length_exceeded` | 400 | no | a string beyond 65,536 code units |
   | `unstorable_payload` | 400 | no | text PostgreSQL refuses: a NUL byte or an unpaired surrogate |
   | `unauthorized_environment` | 403 | no | the key is not authorized for `event.environment` |
   | `event_id_conflict` | 409 | no | the id is stored with different content |
   | `journey_environment_mismatch` | 409 | no | the journey id belongs to another environment |
   | `storage_error` | 500 | yes | the database failed to store it; batch route only |
   | `query_timeout` | 503 | yes | the statement ran past the timeout and was cancelled |

   The rule a client implements is the one the merged SDK implements: **a
   per-event status below 500 is permanent and the event is never sent again; 500
   or above is transient and that event alone is sent again, for up to 30 seconds
   from its first refusal or 10 sends, whichever comes first; a refusal with no
   status is treated as permanent.** Resending is safe because an event already
   stored with the same content is answered as a duplicate. An event the response
   gives no verdict for, because the body was not JSON, had no `results`, or had
   fewer results than events, is **not** sent again: the request succeeded, so the
   server may have stored it.

   The single-event route returns the same refusal as the status of the request
   itself, with two differences the contract names: a storage failure there is the
   generic `500` `internal_error`, because only the batch route reports storage
   failures per event, and a statement timeout is a `503` `query_timeout` for the
   whole request.

   Three codes in `PROTOCOL_ERROR_CODES` are never emitted:
   `missing_required_field`, `invalid_timestamp` and `invalid_operation`. They
   stay reserved, and the contract says a client must treat any unknown code by
   its status.
5. **The two 409s.** `journey_environment_mismatch`: a journey belongs to the
   environment whose key recorded its first event, nothing is stored for the
   refused event (no event row, no alias, no change to the journey), and the
   message does not name the other environment. A journey id must therefore be
   unpredictable, and a context propagated across an environment boundary is
   refused rather than merged (ADR-038, `EVENT_PROTOCOL.md` section 4).
   `event_id_conflict`: the id exists in this project with different content.
6. **Idempotency by event id, with the keyed content hash.** The unit of
   idempotency is `(project, event id)`, across environments, not per environment.
   The stored hash is an HMAC-SHA256 of a canonical serialization of the event as
   received, before redaction and masking, under a subkey of `ENCRYPTION_KEY`, and
   it is stored as `h1.<keyId>.<hex>` (ADR-021, ADR-048). Canonical means object
   keys sorted recursively, array order preserved, numbers as the JSON parser
   produced them, and fields the protocol does not define excluded, because the
   hash is taken over the parsed event. So a resend that reorders keys, or that
   adds or removes an unknown field, is a duplicate; one that changes a defined
   field is a conflict. An identical resend is `202` with `duplicate: true` and
   nothing is written a second time, so a journey's `eventCount` is not inflated
   by retries.

   The rotation consequence is stated plainly: hashes are compared by recomputing
   under the key the stored value names, so a resend that straddles an upgrade or
   a rotation still dedupes, and once `ENCRYPTION_KEY_PREVIOUS` is removed a
   resend of an event whose hash names the removed key can no longer be compared
   and is refused `409 event_id_conflict`, which a client treats as permanent. The
   stored event is untouched; only a duplicate delivery older than the grace
   period is affected.
7. **What the server does to an accepted event**, because a client author needs to
   predict what is stored: the environment's capture mode decides how much of
   `input` and `output` survives; the operator's redaction paths and the built-in
   secret names apply in every mode and reach `error`, `runtime`, `deployment` and
   `metadata` as well as the payloads (ADR-035, ADR-039); `error.message` is
   masked by shape and `error.stack` is dropped unless full capture is in effect
   (ADR-046); the payload diff is computed after capture, only when both sides are
   present; timestamps are normalized to UTC and stored to millisecond precision;
   the journey's entity is the one on its first stored event and is not changed by
   later events; unknown fields are accepted and dropped.
8. **The dry run** (C6), and **the conformance case format** (C7).

## Dry-run validation (C6)

### The shape of the flag

**A query parameter, `dryRun`, on `POST /v1/events/batch` only.** A body field
would change the batch request schema and stop a conformance case's body from
being the same bytes whether it is sent for real or validated; a query parameter
keeps one body and two ways to send it. `dryRun=true` validates, `dryRun=false`
is an ordinary send, anything else or the parameter given twice is `400`
`invalid_query`, which is the code the read routes already use for a malformed
query parameter.

`POST /v1/events` **refuses** a `dryRun` parameter with `400 invalid_query`
naming the batch route. Ignoring it there would mean a client that guessed the
wrong route stored real events while believing it had validated them, and that is
the kind of silence this repository keeps finding in its own history.

### What it does

A dry run is **a real ingestion that is rolled back**, not a second
implementation of the rules. The whole batch runs inside one transaction; each
event runs through the same `ingestEvent` inside a savepoint, exactly as the real
route runs it; the transaction is rolled back before the reply, on every path,
including one where an event threw.

That is the only version that can be trusted, and the reasons are specific:

- **`unstorable_payload` is only discovered by the insert.** A NUL byte or an
  unpaired surrogate is refused by PostgreSQL, not by any check in front of it.
  A dry run that did not insert would have to reimplement PostgreSQL's rules and
  would answer differently from the real route the first time they diverged.
- **`jsonb` normalizes.** Key order and duplicate keys are settled by the
  database, so a preview read back out of the transaction is the stored form
  rather than a guess at it.
- **Ordering inside a batch matters.** The same event id twice in one batch is an
  accept and a duplicate, and a journey created by the first event is what the
  second event is checked against. Per-event isolation without a shared outer
  transaction would answer both differently.
- **The dry run cannot drift from the real path**, which is the property ADR-045
  chose for the deletion dry runs: they read through the same selection the
  deletion uses.

So a dry run performs, per event: the size and structural limits, envelope and
event validation, the environment check against the key, the content hash and
its comparison against an existing row, the journey environment check, capture,
redaction and masking, the diff, the insert, and the alias upsert. It writes no
audit rows, because ingestion writes none in any case.

### What it answers

`200 OK` rather than `202`: nothing was accepted for processing.

```json
{
  "data": {
    "dryRun": true,
    "results": [
      {
        "eventId": "evt_01",
        "status": "accepted",
        "duplicate": false,
        "stored": { "event": { }, "journey": { } }
      },
      {
        "eventId": null,
        "status": "rejected",
        "error": {
          "code": "payload_too_large",
          "message": "The event exceeded a configured limit.",
          "httpStatus": 400
        }
      }
    ]
  }
}
```

The two objects in `stored` are abbreviated in that example. `stored` is present
on an accepted, non-duplicate result and holds the event as
`GET /v1/events/:eventId` would return it, without `receivedAt`, and the journey
as `GET /v1/journeys/:journeyId` would return it, both read inside the
transaction through the same repository functions and the same presenters the
read routes use. That is what makes a conformance case able to state an expected
stored event: the expectation is written against a shape the API already
publishes, so the fixture cannot describe a private representation. It is omitted
for a duplicate, where nothing new would be written, and for a rejection.

The presenters move into `apps/api/src/routes/present.ts` and are shared, so a
preview and a read cannot diverge.

### Authentication, bookkeeping and cost

- Same authentication as a real send: an API key, its environment, its capture
  policy. An admin token is refused as it is for a real send.
- **A dry run does update the key's `last_used_at`**, under the same
  once-a-minute throttle, and a key whose verifier is under the previous key is
  still migrated to the current one when it authenticates. Decided that way
  because both answer "is this key in use", and a key used only by a conformance
  job in CI is in use: leaving it stale would invite an operator to revoke the
  key that CI depends on, and skipping the verifier migration would leave that key
  failing after the rotation's grace period ends. The two writes are about the
  key, not about the events, and "nothing is stored" in this contract means no
  event, journey, alias, summary or audit row.
- **Dry-run events are not counted in the ingested-events counter.** An operator
  alerting on rejected events must not be paged by a conformance suite that sends
  refusals on purpose. No new metric is added, both because a counter's name would
  carry the product name this work must not freeze and because a count of
  validations is not something to alert on. HTTP request metrics count the request
  as usual; their labels are the route pattern, the method and the status.
- One line is logged per dry-run request at info level, with the request id, the
  API key's row id, and the counts of events, accepted and rejected. No values,
  no ids from the events. It exists so that a dry run, which by design leaves no
  row behind, is not entirely invisible to the operator whose data it probed.
- **Rate of use.** No separate rate limit, and no separate body or batch limit:
  ingestion has none today, and inventing one only for the dry run would be a
  control in the wrong place. The contract says what it costs instead: a dry run
  costs what a real send costs plus the rollback, and it holds its row locks for
  the length of the batch rather than the length of one event, so a conformance
  run should use its own environment and journey ids rather than journeys a live
  service is writing to. SDKs MUST NOT use it in normal operation; it is for
  conformance suites, for a setup check, and for a mapping under development.

### Tests

Integration, against PostgreSQL: nothing is written (every table's row count
unchanged, including after a batch whose events include a storage failure and a
statement timeout); the per-event results equal the results of the same batch
sent for real, event by event, for a batch containing an accept, a duplicate, a
conflict, a cross-environment refusal, a validation failure, an oversize event
and an unstorable payload; `stored.event` equals what `GET /v1/events/:eventId`
returns after the same batch is sent for real, minus `receivedAt`, and
`stored.journey` equals `GET /v1/journeys/:journeyId`; a duplicate inside one
batch behaves as it does for real; the transaction is rolled back when an event
throws; `last_used_at` is updated; a key under the previous key is migrated; the
events counter does not move; `POST /v1/events?dryRun=true` is a `400` and stores
nothing; `dryRun` given twice is a `400`; an admin token is a `401`.

## The language-neutral SDK specification (C5)

### Structure of `docs/SDK_SPEC.md`

RFC 2119 and RFC 8174 wording, stated in section 1. Every requirement carries a
stable identifier and a source, in a table at the end of each section, so a
reader can see which ADR or which section of the Node specification a rule comes
from and nothing arrives without provenance.

1. **Scope and conformance.** What an SDK is, the documents it sits against
   (`EVENT_PROTOCOL.md`, `INGESTION_CONTRACT.md`, the conformance cases), what
   conformance means (the fixtures pass through the dry run, plus the host-safety
   requirements that fixtures cannot express), and the note that the propagation
   spec is pending, so header, attribute and environment-variable names are not
   specified here.
2. **Host safety.** A recorder failure MUST NOT reach host code; every public
   entry point MUST be guarded (ADR-007). A wrapper MUST return the callback's
   value unchanged and MUST rethrow the callback's exact error value. In a
   language where a synchronous call and an asynchronous one are different
   things, a wrapper MUST preserve which one it was given. Telemetry MUST NOT
   block the host on the network. Startup MUST NOT fail over configuration that
   can be reported instead.
3. **Identifiers and idempotency.** Event ids MUST be generated by the client from
   a UUID drawn from a cryptographic random source, journey ids MUST be
   unpredictable, and a retry MUST resend the same event id with byte-identical
   content (core invariant 3, ADR-038, ADR-036's note on mixed-version fleets).
4. **The event.** Required fields; the eleven operations, which an SDK SHOULD
   type rather than accept as free text; `timestamp` is when the operation
   started for a wrapper and call time for an unwrapped record (ADR-031);
   `durationMs` is whole milliseconds within int4; `attempt` is supplied by the
   caller and an attempt above one records `retried` (ADR-022); a failed delivery
   records the natural operation with `error` populated, and `failed` is for a
   terminal failure; aliases are a top-level field and `identify` emits its own
   `identified` event (ADR-023).
5. **Capture and redaction.** Capture is synchronous at the call, so a later
   mutation cannot change what was recorded. Redaction MUST run before the event
   enters the queue, MUST match the built-in secret names at any depth in each of
   the shapes `SECURITY.md` section 4 lists, and MUST compare names with case and
   `-` and `_` ignored (ADR-035, ADR-039). The eleven built-in names are listed in
   the specification itself, copied from
   `packages/payload-security/src/default-secrets.ts`, with a docs-truth check
   that the list and the code stay equal, because an implementer in another
   language cannot import the file. Operator paths are appended to the built-in
   list, never replace it. `error.message` MUST be masked by shape and
   bounded to the protocol's 4,096 characters, a `stack` to 16,384, with the
   mask-cut-remask settling the merged SDK implements; an SDK SHOULD NOT send a
   stack at all. Values the wire format cannot carry are repaired rather than
   refused (ADR-034, ADR-036): a cycle becomes `[CIRCULAR]`, an oversize payload
   becomes `[PAYLOAD_TOO_LARGE]` and is counted, an uncapturable value becomes
   `[UNCAPTURABLE]`, a big integer becomes its decimal string, a non-finite number
   becomes null, a NUL byte is removed and a lone surrogate repaired so that the
   server never has to answer `unstorable_payload`. An SDK MUST NOT lose the event
   because it could not capture the payload. Capture modes use the protocol names
   (ADR-018), and the server's policy is authoritative.
6. **Buffering.** A bounded queue, dropping the **oldest** and counting the drop.
   This narrows `NODE_SDK_SPEC.md` section 8, which offered drop-newest as a
   configurable policy that was never built.
7. **Transport.** An SDK MUST send through the batch route, because that is where
   per-event verdicts are, and MUST read the response body: a 2xx does not mean
   the events were stored. Batch size at most 100. Retries with capped exponential
   backoff and jitter behind a circuit breaker; a whole-request 4xx is permanent
   and MUST NOT be retried or counted toward the breaker; a whole-request 5xx or a
   transport failure is retried while the queue bounds it. Per-event verdicts
   follow the rule in the ingestion contract, including the 30-second and
   10-send budget, the no-verdict handling, and that a send in which anything was
   stored does not count toward the breaker. Concurrent sends MUST be capped. An
   SDK SHOULD report an unencrypted endpoint and MUST still start.
   Defaults that are SHOULDs, from the merged SDK: batch 50, flush interval
   1,000 ms, request timeout 1,500 ms, queue 1,000 events, payload budget 262,144
   bytes, 4 concurrent sends clamped to 1 to 16, three attempts per send, 100 ms
   base and 2,000 ms maximum backoff, breaker at five consecutive failures for 30
   seconds.
8. **Shutdown.** Stops accepting, drains until empty or until a pass makes no
   progress or the timeout expires, aborts what is in flight, counts every event
   it could not deliver exactly once, and returns counters. `sent + rejected +
   dropped` MUST equal the events recorded. Shutdown MUST NOT hang.
9. **Diagnostics.** Silent by default. The counters and diagnostic kinds, what
   each means, and what a printed line MUST NOT contain: no payload, no key, no
   server message, no endpoint path or query.
10. **Propagation.** Only the name-independent rules: three levels with
    `journey-and-type` the default, aliases never propagate at any level, the
    entity id propagates only at `full`, an SDK MUST NOT write `traceparent`, and
    a journey must not cross an environment boundary. Names, the value grammar and
    the test vectors are the pending propagation spec.
11. **Optional trace correlation.** An SDK MAY read an active trace and span id
    and MUST NOT require an OpenTelemetry installation.
12. **Configuration.** The four required settings by role rather than by name
    (endpoint, key, service, environment); an SDK SHOULD NOT read ambient
    environment variables of its own.
13. **Conformance.** How to run the fixtures, and the list of requirements that
    fixtures cannot check and that an implementation must cover with its own
    tests: host safety, error identity, queue bounds, shutdown accounting,
    breaker behaviour, timestamps at operation start.

### What moves, and what stays in the Node appendix

`docs/NODE_SDK_SPEC.md` keeps its path, so existing links hold, and is retitled
as the Node appendix to `docs/SDK_SPEC.md`.

Moves out (the neutral rules): section 8 batching, section 9 transport
reliability, the principles half of section 10 redaction, section 12 error
behaviour, section 13 shutdown, and the language-independent half of section 14.

Stays, as the appendix: the package name and install, the initialization example,
the public API with its TypeScript signatures, the context model, the HTTP and
queue helper names, the Node-specific value renderings (`Map`, `Set`, `Headers`,
`URLSearchParams`, `Buffer`, `Error`, `RegExp`, thenables, `rawHeaders`),
`@opentelemetry/api`, the supported Node versions and the ESM note.

The appendix is also reconciled with what is built, since the specification has
drifted from the code: the default batch size is 50 and not 20, the queue policy
is drop-oldest only, and `maxConcurrentSends`, `logDiagnostics`, `onDiagnostic`
and `propagate` exist. Where the README and the specification disagree, the README
is right and the specification is corrected.

## Conformance fixtures (C7)

### Format

JSON files, one case per file, under `packages/protocol/conformance/`:

```text
packages/protocol/conformance/wire/<case>.json
packages/protocol/conformance/sdk/<case>.json
```

```json
{
  "id": "wire/secrets-at-depth",
  "title": "A secret three levels down, and inside an array, is redacted",
  "source": "ADR-035; docs/WHAT_RUNNING_IT_FOUND.md",
  "layer": "wire",
  "languages": ["*"],
  "setup": {
    "environment": { "captureMode": "redacted-payload" },
    "existing": [],
    "otherEnvironment": []
  },
  "send": { "events": [] },
  "expect": {
    "results": [
      {
        "status": "accepted",
        "duplicate": false,
        "stored": { "event": {}, "journey": {} }
      }
    ]
  }
}
```

The arrays and objects are elided in that skeleton; a real case fills them.

- `layer` is `wire` (the input is an HTTP request body) or `sdk` (the input is a
  sequence of recorder calls). `otlp` is reserved for Phase 5 and unused.
- A `wire` case carries `send`, the request body verbatim. An `sdk` case carries
  `calls` instead: an array of `{ "call": "record" | "transform" | "persist" |
  "publish" | "deliver" | "identify" | "fail" | "finish", "name": "...", ... }`
  objects holding the arguments that call takes, each with an optional `repeat`
  for the cases that need many events, and a `recorder` object for the settings
  the case needs (capture mode, `maxPayloadBytes`, `redact`). An `sdk` case's
  `expect` may carry `wire`, the event the SDK is expected to send, beside
  `results`.
- `languages` is `["*"]` or a list, for the cases that need a value a language
  cannot hold. A harness skips what it cannot express and reports the skip.
- `setup.environment` names the capture mode the case needs. `setup.existing`
  holds envelopes that are ingested **for real** before the case runs, which is
  how duplicate and conflict cases get their prior row; `setup.otherEnvironment`
  is ingested with a second environment's key, which is how the
  cross-environment case gets its journey.
- `expect` is either `request` (a whole-request refusal: status and code, and
  nothing stored) or `results` (one entry per sent event).
- Comparison is a **subset at the top level and exact underneath**: a key listed
  in `stored.event`, `stored.journey` or `wire` must be present and deep-equal,
  and a key not listed is not compared. Exact nested comparison is deliberate,
  because `not.toContain(secret)` passes just as well against a field that was
  dropped, which is the mistake `docs/WHAT_RUNNING_IT_FOUND.md` records.
- Two matcher objects are allowed inside an expectation: `{"$matches": "<regex>"}`
  for a value the client generates (an event id, a timestamp) and
  `{"$absent": true}` for a field that must not be present (a dropped stack).
- Three builder objects keep large cases small: `{"$string": {"char": "a", "count": 70000}}`,
  `{"$array": {"value": 1, "count": 1001}}` and `{"$nest": {"depth": 33, "leaf": 1}}`.
  A `sdk` case may also carry host values JSON cannot write, as single-key tagged
  objects from a closed list: `$date`, `$bigint`, `$number` (`NaN`, `Infinity`,
  `-Infinity`), `$undefined`, `$cycle` (a JSON pointer to an ancestor), `$ref` (a
  JSON pointer to an earlier node, for a shared reference), `$utf16` (a string
  from code units, for a lone surrogate), and the Node-only `$map`, `$set`,
  `$error`, `$buffer`, `$throwingGetter`. `{"$literal": ...}` escapes data that
  genuinely starts with `$`.
- `{{run}}` in any string is replaced by a value unique to the run, so ids do not
  collide between runs and a case can be run twice against the same database.

The format, the tag list and the matcher rules are specified in
`docs/INGESTION_CONTRACT.md`, not in a README beside the files, so that a person
implementing a client reads it in the same document as the routes.

`packages/protocol/src/conformance.ts`, exported as
`@flight-recorder/protocol/conformance`, holds the loader, the expander and the
matcher, so the three consumers cannot implement them differently. A
non-TypeScript implementation reimplements them; they are about a hundred lines
and the contract document specifies them.

### How they are consumed

- **The API integration test** (`apps/api/src/routes/conformance.integration.test.ts`)
  runs every `wire` case twice against a real PostgreSQL: once by sending it for
  real and reading the result back through `GET /v1/events/:id` and
  `GET /v1/journeys/:id`, and once through `POST /v1/events/batch?dryRun=true`.
  Both must equal the expectation. That is what ties the dry run to reality: if
  the preview ever stops matching what a real send stores, every case fails.
- **The Node SDK unit test** (`packages/sdk-node/src/conformance.test.ts`) runs
  every applicable `sdk` case against a stub endpoint, captures the request body,
  and compares it with `expect.wire`.
- **The SDK-through-the-API integration test** takes the same captured body and
  sends it through the dry run, comparing `expect.results[].stored`. That is the
  procedure any SDK in any language follows: record, capture what your SDK sent,
  send those bytes to the dry run, compare. The SDK never calls the dry run
  itself.
- **A future OTLP mapping** adds `layer: "otlp"` cases whose input is an OTLP log
  record and sends them to `POST /v1/logs?dryRun=true`, comparing the same
  `stored` expectation.
- **The parity test** (C2) validates every envelope in every case with both
  validators.

### The cases

From the reference journey, the handoff file's list, the 2026-08-09 audit, and
the security work merged on 2026-09-15.

**Wire layer.**

1. `reference-journey`: the `DEMO_SCENARIO.md` journey in one batch (received,
   transformed, persisted, identified, published, consumed, delivered with a 422
   error, two `retried` attempts, and a terminal `failed`), all accepted; the
   transform event's stored diff is section 7's table; the journey ends `failed`
   with its aliases and services.
2. `duplicate-identical`: a prior event resent with its keys in a different order,
   accepted with `duplicate: true`.
3. `event-id-conflict`: the same id with one field changed, `409`.
4. `duplicate-within-batch`: the same event twice in one request.
5. `cross-environment-journey`: a journey created by another environment's key,
   then an event for it, `409 journey_environment_mismatch`, nothing stored.
6. `unauthorized-environment`: `event.environment` is not the key's, `403`.
7. `unsupported-protocol-version`, `invalid-event-missing-id`,
   `invalid-event-unknown-operation`, `invalid-timestamp-without-offset`: `400`
   `invalid_event` or `unsupported_protocol_version`, with the expected
   `details[0].path` where there is one.
8. `duration-int4-boundary`: 2,147,483,647 accepted and stored, 2,147,483,648
   refused.
9. `nul-byte-in-payload` and `nul-byte-in-name`: `400 unstorable_payload`.
10. `lone-surrogate-in-payload`: `400 unstorable_payload`.
11. `oversize-event`: an envelope one byte over the limit, `payload_too_large`,
    with a sibling event in the same batch accepted, so the case also proves a
    partially invalid batch stores the rest.
12. `batch-of-100` accepted and `batch-of-101` refused as a whole request.
13. `max-depth`, `max-keys`, `max-string-length`: one case each.
14. `secrets-at-depth`: the ADR-035 proof shape, secrets three levels down and
    inside an array, each stored as `[REDACTED]` with every other field intact.
15. `secret-name-spellings`: `apiKey`, `api-key`, `API_KEY` and `APIKey` all
    redacted (ADR-039).
16. `header-pairs`: a `[["Authorization", "..."]]` list redacted, and a list of
    header **names** left alone.
17. `header-name-value-objects`: `{name,value}` and `{key,value}` array elements.
18. `raw-headers-http1` and `raw-headers-http2`: interleaved lists captured from
    real exchanges, including HTTP/2 pseudo-headers, the value after the secret
    name redacted.
19. `header-block-in-string`: a CRLF block redacted line by line, and the
    documented gap, an LF-only block, left as it is, so a change to either is
    noticed.
20. `error-message-masked`: a connection string with userinfo in
    `error.message`, masked, with `type` and `code` untouched.
21. `error-stack-dropped` and `error-stack-kept-under-full-capture`.
22. `metadata-only-capture`: payloads absent, metadata and aliases still stored.
23. `proto-key`: `__proto__` in `input`, in `metadata` and in `aliases`, all
    three preserved in the stored event.
24. `unknown-fields`: an unknown top-level field and an unknown field inside
    `entity`; accepted, not stored, and a resend without them is a duplicate,
    which pins the hash's treatment of them.
25. `large-integer-in-payload`: an integer beyond 2^53, stored as the double the
    parser produced, which is the contract's reason for telling senders to use
    strings.
26. `timestamp-offset`: a `+02:00` timestamp stored as the same instant in UTC,
    and a sub-millisecond fraction truncated.
27. `empty-batch` and `events-not-an-array`.

**SDK layer.**

28. `date-in-payload`: a `Date` becomes an ISO string, and a transform whose two
    dates differ produces a diff that shows the change (the M3 defect).
29. `shared-reference`: the same object twice is expanded twice.
30. `cycle`: `[CIRCULAR]` at the point the loop closes, the rest kept.
31. `bigint`, `nan-and-infinity`, `undefined-key`.
32. `nul-byte` and `lone-surrogate`: repaired by the SDK, so the server accepts
    what a wire sender is refused for.
33. `proto-key`: preserved end to end.
34. `secrets-at-depth`, `header-pairs`, `raw-headers-http1`,
    `raw-headers-http2`, `header-block-in-string`: redacted before the request
    leaves the process, checked against `expect.wire` as well as against
    `stored`.
35. `oversize-payload`: `[PAYLOAD_TOO_LARGE]` in place of the payload, the event
    still sent.
36. `uncapturable-payload`: a throwing getter becomes `[UNCAPTURABLE]`, the event
    still sent (Node only).
37. `error-masked-and-bounded`: masked, cut to 4,096 with `[TRUNCATED]`, no stack
    sent.
38. `retried-attempt`: `attempt: 2` records `retried` with `attempt` in metadata.
39. `identify`: an `identified` event named `identify` carrying the aliases.
40. `generated-ids`: `evt_` and `jrn_` followed by a UUID, matched by pattern.
41. `metadata-uncapturable`: metadata that cannot be represented is omitted and
    the event is still sent.
42. `hundred-and-one-events`: 101 recorded events reach the server as two
    requests, all stored, which is the SDK half of case 12.

Requirements that no fixture can express, and that stay as the SDK's own tests,
are listed in `docs/SDK_SPEC.md` section 13: host safety, error identity, queue
bounds, shutdown accounting, the breaker, and the ADR-031 timestamp.

### Expected values are written, not captured

Every expectation is written from the documents before the case is run:
`DEMO_SCENARIO.md` section 7 for the diff, `SECURITY.md` section 4 for redaction,
the SDK README's value table for renderings, this design for the codes. When a
run disagrees, the task decides which side is wrong and records it in the task
report. Pasting actual output into an expectation is how a suite comes to bless a
defect, which is what `docs/WHAT_RUNNING_IT_FOUND.md` says happened to the test
data that was written by whoever wrote the code.

## What this work changes in the code, and why each change is small

- `packages/protocol`: new `json-schema.ts`, `ingestion.ts` (the request,
  response, result, error and stored-shape schemas plus `MAX_BATCH_EVENTS`),
  `conformance.ts`, a generator script, generated schemas, boundary fixtures,
  conformance fixtures, `ajv` as a devDependency.
- `packages/protocol/src/envelope.ts`: `__proto__` keys in `aliases` and
  `metadata` survive parsing. The parse result is built with the key defined
  rather than assigned.
- `apps/api/src/routes/events.ts`: `MAX_BATCH_SIZE` becomes the protocol's
  constant, the `dryRun` parameter, and the dry-run transaction.
- `apps/api/src/routes/present.ts`: the event and journey presenters move here and
  the read routes use them.
- `apps/api/Dockerfile` and `scripts/verify-image-contents.sh`: the conformance
  directory is pruned from the runtime image and the check asserts it is absent.
  The fixtures hold credential-shaped strings on purpose, which is exactly what
  ADR-043 exists to keep out of a published image.
- `.gitleaks.toml`: one value-shaped allowance for the fixtures' fake
  credentials, which all carry the marker `cfx-fake`, in the style of the existing
  entries. No path allowance.

## Security consequences

- **The dry run is a probe that leaves no row.** Today, testing whether an event
  id or a journey id exists means sending an event: a wrong guess stores a
  journey somebody can see. A dry run answers `event_id_conflict` or
  `journey_environment_mismatch` without writing anything. It needs an ingest key
  for the project, it cannot read any value back beyond what the caller sent, and
  journey ids are random UUIDs precisely so they cannot be guessed (ADR-038). The
  ADR records it, and the info log line is the compensating trace.
- **The online confirmation oracle of ADR-048 is unchanged in kind.** Somebody
  holding an ingest key and database read access can already confirm a guess at a
  masked value by resending a rebuilt event. The dry run makes that quieter, not
  cheaper, and it is one request per guess either way.
- **The preview returns only what the caller sent**, after this installation's
  own redaction, capture and masking, to the key that sent it. It does disclose
  the shape of the environment's redaction policy, which the caller can already
  infer by sending an event and reading it back.
- **Fixtures are fake credentials in a public repository**, which is why they
  carry a marker, why the gitleaks allowance is written against the value, and why
  the conformance directory is pruned from the runtime image.

## Testing, in summary

- Unit: schema drift, the `\d` rewrite, Zod-Ajv parity over every fixture and
  boundary case, the conformance loader and matcher, the batch request corpus,
  `__proto__` survival through parsing, the SDK conformance cases against a stub.
- Integration, against PostgreSQL: the dry run's list above, every wire
  conformance case twice (real and dry run), the SDK cases through the dry run,
  `__proto__` read back out of a row, and every batch response validated against
  the generated schema.
- Documentation: `tests/docs-truth.test.ts` gains the ADR count (already there),
  the ingestion contract's limit table against the constants, its refusal table
  against the code registry, and a check that the contract and `API_SPEC.md` do
  not both describe the ingestion routes in full.

## Out of scope, and why

- The propagation spec and its vectors (C4), and every OTLP item (Phase 5): they
  name things the rename will change.
- Renaming the Fastify content-type error codes to codes this API owns: a wire
  change, cheaper to make in the rename window, recorded in the contract as a
  known wart.
- Rate limiting or quotas on ingestion: on the roadmap, and not something to
  introduce through a validation endpoint.
- A hosted schema registry, a published OpenAPI document, or generated clients.
  The files are in the repository and resolvable from the package; a URL is a
  decision for after the domain exists.

## Open questions for the owner

1. **Reserved error codes.** `missing_required_field`, `invalid_timestamp` and
   `invalid_operation` are in the public code list and have never been emitted.
   This design keeps them reserved and documents them as such. Removing them is
   the cleaner contract and is free while nothing is published; it is his call
   whether to remove them in the rename window.
2. **The Fastify error codes on the transport refusals.** Documented as they are,
   with a note that they are the framework's vocabulary. Replacing them with codes
   this API owns is a small change and a wire change; this design puts it with the
   rename rather than here.
3. **Unknown fields.** `AGENTS.md` said they "must be preserved where safe" and
   the parser drops them. ADR-049 reads that rule as "accepted, not refused" and
   says so, because there is no column to store them in. If he wants them stored,
   that is a schema change and its own decision.
