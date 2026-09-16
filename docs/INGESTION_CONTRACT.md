# Ingestion contract

Normative for `POST /v1/events` and `POST /v1/events/batch`. If this document
and any other disagree about ingestion, this one is right (ADR-049).

The audience is somebody writing a client that is not this repository's Node
SDK: another language, a mapping from some other event source, a script. You
should not have to read about replay destinations to send an event, which is
why this is its own file rather than a longer `API_SPEC.md`.

Machine-readable versions of every shape below are generated from the same Zod
schemas the server validates with, under
[`packages/protocol/schemas/0.1/`](../packages/protocol/schemas/0.1), as JSON
Schema draft 2020-12. They are checked byte for byte against the generator by a
unit test, so they cannot drift. Conformance fixtures are under
[`packages/protocol/conformance/`](../packages/protocol/conformance) and section
10 says how to run them.

---

## 1. Routes, transport and authentication

```http
POST /v1/events
POST /v1/events/batch
```

`Content-Type: application/json`, UTF-8. A body that is not JSON is refused
before the route runs; see section 2.

**One event.** The body is an envelope:

```json
{ "protocolVersion": "0.1", "event": { } }
```

An accepted event answers `202`:

```json
{ "data": { "eventId": "evt_01", "journeyId": "jrn_01", "status": "accepted", "duplicate": false } }
```

**A batch.** The body is `{ "events": [ ... ] }`, each element an envelope, at
most 100 of them. The response is `202` with one result per sent event, in the
order they were sent and matched by position:

```json
{ "data": { "results": [ { "eventId": "evt_01", "status": "accepted", "duplicate": false } ] } }
```

**A batch always answers `202` when the request itself was well formed**, whether
or not every event was accepted, because the transport succeeded. A client has
to read the body. This is why an SDK must send through the batch route: it is
the only one with per-event verdicts.

**Authentication** is `Authorization: Bearer <api key>`: exactly the scheme, one
space, and the token. The scheme is compared case-insensitively; anything after
the token is a `401`. An API key names one project and one environment and may
only ingest. An admin token is refused with `401`, because it names no
environment and ingestion has to write into one (ADR-029).

Ingestion is deliberately **not** covered by the failed-credential throttle, so
a misconfigured service cannot lock an operator out of their own installation.
`TRUSTED_PROXY_COUNT`, which only feeds that throttle, has no effect here.

---

## 2. Refusals that happen before the route runs

The body is parsed before authentication, so a malformed body sent under a bad
key is answered as a malformed body.

| Status | Code | Meaning |
| --- | --- | --- |
| 413 | `payload_too_large` | the request body exceeded the server's body limit |
| 415 | `unsupported_media_type` | the content type has no parser; send application/json |
| 400 | `malformed_json` | the body was empty, or was not valid JSON |

These carry codes this API owns. They used to carry Fastify's own
(`FST_ERR_CTP_*`), which said that changing the server's web framework was a
wire change. **The status is the stable part**: a client that meets a code it
does not recognize should branch on the status.

Two refusals in this class do not look like the rest, and a client should not be
surprised by either:

- **Headers larger than the server's header limit are refused `431` by Node
  itself**, before anything in this application runs. The body is the runtime's,
  not this API's: `{"error": "Request Header Fields Too Large", "message": "…",
  "statusCode": 431}`, where `error` is a string rather than the object every
  other refusal uses. Nothing here can change that without reading the socket
  ahead of the runtime. Branch on the status.
- **`Content-Type: text/plain` is parsed, not refused.** The framework has a
  parser for it, so the body arrives as a string, and a string is not an
  envelope: both routes answer `400 invalid_event` rather than `415`. Send
  `application/json`. A content type with no parser at all is the `415` in the
  table.

**Unknown query parameters are refused.** `POST /v1/events` accepts none, and
`POST /v1/events/batch` accepts only `dryRun`; anything else is `400
invalid_query` naming the key. This is not pedantry: `?dryrun=true` was
previously ignored and the batch stored, so a client believed it had validated
events it had in fact written. Matching the name loosely would have rescued
`dryrun` and not `dryRum`, and nothing legitimate adds a query parameter here.

A body containing a `__proto__` key, or a `constructor.prototype`, is ordinary
JSON here and is accepted. Recording what the payload actually was is the
product's whole promise, and those keys are safe to parse: they become ordinary
own properties, and every walk that rebuilds an object from an incoming one
writes its keys with `Object.defineProperty` rather than assigning them. That
was not free. One rebuild, in the branch that replaces a header pair's value,
still assigned; `packages/payload-security/src/redact.test.ts` now sweeps every
shape this server accepts rather than leaving it a claim.

An `aliases` key called `__proto__` is accepted like any other, and stored as an
alias of that type, when its value is a string. A non-string value is
`invalid_event` with `details[0].path` of `event.aliases.__proto__`. That rule
is stated because it is not free either: the parser's `z.record` neither keeps
that key nor validates what is under it, so a second implementation has to
restore the key *and* apply the value schema itself, or it will accept an object
where every other alias must be a string.

---

## 3. Limits

| Limit | Name | Default | Refusal |
| --- | --- | --- | --- |
| Serialized size of one envelope | `MAX_EVENT_PAYLOAD_BYTES` | 262144 bytes | per event, `payload_too_large`, 400 |
| Events in one batch | fixed, `MAX_BATCH_EVENTS` in the protocol package | 100 | whole request, `payload_too_large`, 400 |
| Request body | derived: `MAX_BATCH_EVENTS * MAX_EVENT_PAYLOAD_BYTES + 64 KiB` | about 25 MiB | whole request, 413 |
| Nesting depth | fixed | 32 | per event, `max_depth_exceeded`, 400 |
| Keys or elements in one object or array | fixed | 1000 | per event, `max_keys_exceeded`, 400 |
| Length of one string | fixed | 65536 UTF-16 code units | per event, `max_string_length_exceeded`, 400 |
| Statement time | `DATABASE_STATEMENT_TIMEOUT_MS` | 15000 ms | per event, `query_timeout`, 503 |
| Full payload capture | `ALLOW_FULL_PAYLOAD_CAPTURE` plus the environment's own `full-payload` | off | changes what is stored, never refuses |

The numbers in that table are asserted against the constants by
`tests/docs-truth.test.ts` (ADR-040).

Two details a client author needs:

- The size limit is measured over the **whole envelope as the server received
  it**, not over `input` alone, and the structural limits are measured before
  anything walks the payload.
- **A client should fit an event before sending it**, because a refusal loses
  the whole event. The Node SDK runs the server's own check,
  `eventLimits(MAX_EVENT_PAYLOAD_BYTES)` from `packages/payload-security`, on
  every envelope before it is queued. It cuts a string over the limit to its
  start and `[TRUNCATED: <n> characters removed]`, exactly 65,536 code units in
  all, with `<n>` in code units, and with a CRLF before the marker when the
  string held one, so the server still reads it as a header block; replaces a payload that still does not fit, or
  is nested too deep or too wide, with `[PAYLOAD_TOO_LARGE]`, the larger of
  `input` and `output` first; and leaves off `metadata` last (ADR-051). It
  also leaves off a metadata key or alias type over 128 code points and an
  alias value that is not a string of at most 512, which the schema would
  refuse, adding `"[KEY_TOO_LONG]": <n>` to metadata when it drops keys there. A
  payload sits two levels below the envelope's root, so it has 30 levels of
  its own. The server treats both markers as ordinary strings.
- The units differ, deliberately. The schema's own string maxima count Unicode
  **code points**, so 128 astral characters fit a 128-character id. The
  structural cap that produces `max_string_length_exceeded` counts UTF-16 **code
  units**, because it is measured with the language's own string length.

---

## 4. Per-event refusals, and which to retry

| Code | Status | Retry | Meaning |
| --- | --- | --- | --- |
| `invalid_event` | 400 | no | the event did not match protocol 0.1; `details` names the fields |
| `unsupported_protocol_version` | 400 | no | the envelope's version is not served |
| `payload_too_large` | 400 | no | the envelope exceeded `MAX_EVENT_PAYLOAD_BYTES`, or the batch exceeded `MAX_BATCH_EVENTS` |
| `max_depth_exceeded` | 400 | no | nesting beyond 32 levels |
| `max_keys_exceeded` | 400 | no | more than 1,000 keys or elements in one object or array |
| `max_string_length_exceeded` | 400 | no | a string beyond 65,536 UTF-16 code units |
| `unstorable_payload` | 400 | no | text PostgreSQL refuses: a NUL byte or an unpaired surrogate |
| `invalid_query` | 400 | no | a query parameter this route does not accept, or a `dryRun` that was not `true` or `false` or was given twice |
| `unauthorized_environment` | 403 | no | the key is not authorized for `event.environment` |
| `event_id_conflict` | 409 | no | the id is stored in this project with different content |
| `journey_environment_mismatch` | 409 | no | the journey id belongs to another environment of this project |
| `storage_error` | 500 | yes | the database failed to store it; the batch route only |
| `query_timeout` | 503 | yes | the statement ran past `DATABASE_STATEMENT_TIMEOUT_MS` and was cancelled |

That table is checked row by row against the registry in
`packages/protocol/src/errors.ts` by `tests/docs-truth.test.ts`, including the
status and the retry column.

**The rule a client implements**, which is the rule the Node SDK implements:

- A per-event status **below 500 is permanent**. That event is never sent again.
- **500 or above is transient.** That event alone is sent again, for up to 30
  seconds from its first refusal or 10 sends, whichever comes first.
- A refusal carrying **no status** is treated as permanent.
- An event the response gives **no verdict for**, because the body was not
  JSON, had no `results`, or had fewer results than events, is **not** sent
  again. The request succeeded, so the server may have stored it.

Resending is safe: an event already stored with the same content is answered as
a duplicate rather than stored twice.

**A code you do not recognize is handled by its status.** Codes are added over
time and that is a compatible change. Three codes were once listed here and
never sent by anything (`missing_required_field`, `invalid_timestamp` and
`invalid_operation`) and were removed rather than reserved (ADR-049). Another
implementation of this protocol reports those conditions as `invalid_event`,
with the failing field in `details`.

**The single-event route** answers the same refusal as the status of the request
itself, with two differences: a storage failure there is a generic `500`
`internal_error`, because only the batch route reports storage failures per
event; and a statement timeout is a `503` `query_timeout` for the whole request.

### Error body

Every refusal, from every route, has one shape:

```json
{ "error": { "code": "invalid_event", "message": "…", "requestId": "…", "details": [ { "path": "event.entity.id", "message": "…" } ] } }
```

`details` is present when the refusal came from validation. `requestId` is in
the server's log line for that request, so quoting it in a bug report is enough
for an operator to find it.

---

## 5. The two 409s

**`journey_environment_mismatch`.** A journey belongs to the environment whose
key recorded its first event. An event for that journey from another
environment's key is refused, and **nothing is stored for it**: no event row, no
alias, no change to the journey. The message does not name the other
environment, which the caller's key cannot read and has no business learning
exists.

Two consequences. A journey id has to be unpredictable, which is why they are
random (ADR-038). And a context propagated across an environment boundary is
refused rather than merged, so a staging worker consuming a production message
does not append to that journey (`EVENT_PROTOCOL.md` section 4).

**`event_id_conflict`.** The id exists in this project with different content.
See section 6 for what "different" means.

---

## 6. Idempotency, by event id

The unit of idempotency is **(project, event id)**, across environments, not per
environment.

The server stores a content hash beside each event: an HMAC-SHA256 of a
canonical serialization of the event **as received**, before redaction and
masking, under a subkey of `ENCRYPTION_KEY`, stored as `h1.<keyId>.<hex>`
(ADR-021, ADR-048).

Canonical means:

- object keys sorted recursively,
- array order preserved, because it is meaningful,
- numbers as the JSON parser produced them,
- and fields the protocol does not define excluded, because the hash is taken
  over the **parsed** event.

So a resend that reorders keys, or that adds or removes an unknown field, is a
**duplicate**. One that changes a field the protocol defines is a **conflict**.

An identical resend is `202` with `duplicate: true`, and nothing is written a
second time, so a journey's `eventCount` is not inflated by retries.

**The rotation consequence**, stated plainly: hashes are compared by recomputing
under the key the stored value names, so a resend that straddles an upgrade or a
key rotation still dedupes. Once `ENCRYPTION_KEY_PREVIOUS` is removed, a resend
of an event whose hash names the removed key can no longer be compared and is
refused `409 event_id_conflict`, which a client treats as permanent. The stored
event is untouched; only a duplicate delivery older than the rotation's grace
period is affected.

---

## 7. What the server does to an accepted event

A client author needs to predict this, because it is what a read returns and
what a dry run previews.

- **Capture mode** decides how much of `input` and `output` survives:
  `metadata-only` stores neither, `allowlisted-fields` stores the configured
  paths, `redacted-payload` stores them with secrets replaced, `full-payload`
  stores them with only the built-in secret list applied, and only when the
  installation has also set `ALLOW_FULL_PAYLOAD_CAPTURE` (ADR-018). An
  environment set to `full-payload` on an installation that has not allowed it
  degrades to `redacted-payload` rather than refusing the event.
- **Redaction** applies the eleven built-in secret names in every mode that
  stores a payload at all, at any depth and inside arrays, matching names with
  case and `-` and `_` ignored (ADR-035, ADR-039). It reaches `error`,
  `runtime`, `deployment` and `metadata` as well as the payloads. A matched
  value is **replaced** with `[REDACTED]`, not deleted: evidence that a value
  existed is part of the record.

  The operator's own configured paths are applied **beside** the built-in names
  in every mode **except** effective full capture, where the built-in list alone
  is applied. Full capture means "store the payload", so the paths an operator
  added on top of it would be the operator asking for two opposite things; the
  built-in list is the part that cannot be turned off. An environment set to
  `full-payload` on an installation that has not allowed it is not in effect
  and gets both lists, like any other mode.
- **`error.message` is masked by shape** and `error.stack` is dropped unless
  full capture is in effect (ADR-046).
- **The payload diff** is computed after capture, and only when both `input` and
  `output` are present, so a stored diff can never carry a secret.
- **Timestamps** are normalized to UTC and stored to millisecond precision. A
  finer fraction is truncated, not rounded.
- **The journey's entity** is the one on its first stored event, and is not
  changed by later events.
- **Aliases** are stored per journey, type and value, and read back masked.
  `displayableAliases`, an optional list of alias types, marks aliases a reader
  may see in full: an alias is stored as displayable when the first event that
  states it lists it, and becomes masked for good when any later event states
  it without listing it (ADR-053). A listed type that the event's `aliases`
  does not name is ignored, not refused. A read returns each alias as
  `{ type, displayValue, displayable }`.
- **`journeyLabel`**, optional, is public display text for the journey: 1 to
  200 code points. An empty string refuses that event alone as `invalid_event`,
  with `details[0].path` equal to `event.journeyLabel`; a label is never cleared
  by sending one. The label is not redacted, because the host wrote it to be
  shown.
- **Unknown fields are accepted and dropped.** There is no column to store them
  in, and an unvalidated, unredacted field is not something to write to one. The
  rule is "accepted, not refused", which is what makes an additive optional
  field a compatible change (ADR-049).
- **Duplicate keys in one JSON object** are the parser's business; this server
  keeps the last. Do not send them.
- **Integers beyond 2^53** are parsed as doubles, so `9007199254740993` is
  stored as `9007199254740992`. Send a large integer as a string.

---

## 8. Validating without storing

`POST /v1/events/batch?dryRun=true` runs the whole batch and rolls it back
(ADR-050). It answers `200`, not `202`, because nothing was accepted for
processing:

```json
{
  "data": {
    "dryRun": true,
    "results": [
      { "eventId": "evt_01", "status": "accepted", "duplicate": false, "stored": { "event": { }, "journey": { } } },
      { "eventId": null, "status": "rejected", "error": { "code": "payload_too_large", "message": "…", "httpStatus": 400 } }
    ]
  }
}
```

- The parameter is strictly `true` or `false` and may be given once. Anything
  else is `400 invalid_query`, and `POST /v1/events` refuses the parameter
  outright rather than ignoring it: a client that guessed the wrong route would
  otherwise store real events while believing it had validated them.
- A dry run performs, per event, everything a real send performs: the size and
  structural limits, validation, the environment check, the content hash and its
  comparison against an existing row, the journey environment check, capture,
  redaction and masking, the diff, the insert, and the alias upsert. It is a
  real ingestion that is rolled back, not a second implementation of the rules,
  which is the only version that can be trusted: only the insert discovers
  `unstorable_payload`, and only the database settles what `jsonb` normalizes.
- **`stored`** is present on an accepted, non-duplicate result. It holds the
  event as `GET /v1/events/:eventId` returns it, **without `receivedAt`**, and
  the journey as `GET /v1/journeys/:journeyId` returns it. It is omitted for a
  duplicate and for a rejection.
- **Nothing is written**: no event, journey, alias, summary or audit row. The
  key's `last_used_at` is still updated and a verifier under a previous
  encryption key is still migrated, because both answer "is this key in use" and
  a key a conformance job uses is in use. Those two writes are about the key,
  not about the events.
- Dry-run events are **not** counted in the ingested-events metric, so a suite
  that sends refusals on purpose does not page an operator.
- **What it costs.** There is no separate rate limit and no separate body or
  batch limit; ingestion has none, and inventing one only here would be a
  control in the wrong place. A dry run costs what a real send costs plus the
  rollback, and it holds its row locks for the length of the batch rather than
  the length of one event.

  That last part has a consequence worth stating plainly, because it falls on
  somebody else: **a real ingestion contending for a row a dry run is holding
  waits, and is cancelled by `DATABASE_STATEMENT_TIMEOUT_MS` if it waits too
  long.** It is then answered `503 query_timeout`, which a client reads as
  transient and retries, so nothing is lost; but a long dry-run batch touching
  a busy journey can make a live service slower and noisier. A conformance run
  should therefore use its own environment and its own journey ids rather than
  journeys a live service is writing to. **An SDK must not use this in normal
  operation.** It is for conformance suites, for a setup check, and for a
  mapping under development.

---

## 9. The conformance case format

A case is a request to these routes, which is why the format is specified here.
Files live under `packages/protocol/conformance/<layer>/<case>.json`.

```json
{
  "id": "wire/secrets-at-depth",
  "title": "A secret three levels down, and inside an array, is redacted",
  "source": "ADR-035; docs/WHAT_RUNNING_IT_FOUND.md",
  "layer": "wire",
  "languages": ["*"],
  "setup": { "environment": { "captureMode": "redacted-payload" }, "existing": [], "otherEnvironment": [] },
  "send": { "events": [] },
  "expect": { "results": [{ "status": "accepted", "duplicate": false, "stored": { "event": {}, "journey": {} } }] }
}
```

- **`layer`** is `wire` (the input is an HTTP request body) or `sdk` (the input
  is a sequence of recorder calls). `otlp` is reserved and unused.
- A **`wire`** case carries `send`, the request body verbatim. An **`sdk`** case
  carries `calls` instead, each `{ "call": "record" | "transform" | "persist" |
  "publish" | "deliver" | "identify" | "fail" | "finish", "name": "…", "args":
  { } }`, with an optional `repeat`, and a `recorder` object for the settings
  the case needs. A wrapper call's `args` are `input`, `output` (what the
  callback returns) and `options`, the wrapper's options. A call with
  `"journeys": n` is made on a group of n journeys, the case's own first, and
  expects n results. An `sdk` case's `expect` may carry `wire`, the event the SDK
  is expected to send, beside `results`.
- **`languages`** is `["*"]` or a list. A harness skips what it cannot express
  **and reports the skip**; a skip nobody sees is a case that quietly stopped
  running.
- **`setup.environment`** names the capture mode and redaction the case needs.
  In an `sdk` case it is the server's setting only: the recorder never sees it,
  and the harness applies it to the environment the captured bytes are sent
  to.
  **`setup.existing`** holds envelopes ingested **for real** before the case
  runs, which is how a duplicate or conflict case gets its prior row;
  **`setup.otherEnvironment`** is ingested with a second environment's key,
  which is how a cross-environment case gets its journey.
- **`expect`** is either `request` (a whole-request refusal: a status and a
  code, and nothing stored) or `results`, one entry per sent event. A refused
  result's `error` carries `code` and `httpStatus`, and may carry `details`, a
  list of `{ "path": "…" }` compared in order with the refusal's own details.
  A detail's `message` is the server's wording and is not compared, so a case
  may not list it.

### Comparison

**A subset at the top level, and exact underneath.** A key listed in
`stored.event`, `stored.journey` or `wire` must be present and deep-equal; a key
not listed is not compared. Below that first level the comparison is exact,
**including the key set**, so a dropped field fails. That is deliberate:
"does not contain the secret" passes just as well against a field that was
deleted, which is the mistake `WHAT_RUNNING_IT_FOUND.md` records.

Two matcher objects are allowed anywhere in an expectation:

| Matcher | Means |
| --- | --- |
| `{"$matches": "<regex>"}` | the value is a string matching this expression, for a value the client generates |
| `{"$absent": true}` | the key must not be present |

### Builders and tagged values

Four builders keep a large case small, in a case's input and in its expectation:

| Builder | Produces |
| --- | --- |
| `{"$string": {"char": "a", "count": 70000}}` | a string of that many characters |
| `{"$array": {"value": 1, "count": 1001}}` | an array of that many copies, each its own object |
| `{"$nest": {"depth": 33, "leaf": 1}}` | that many levels of nesting around the leaf |
| `{"$concat": ["a", {"$string": {"char": "x", "count": 5000}}]}` | the pieces joined into one string |

`{"$literal": …}` escapes data that genuinely starts with `$`.

An **`sdk`** case may also carry host values JSON cannot write, as single-key
tagged objects from a closed list. A `wire` case may not: its `send` is a
request body, so a tag there is a mistake rather than a value.

| Tag | Produces |
| --- | --- |
| `{"$date": "2026-01-02T03:04:05.678Z"}` | a date |
| `{"$bigint": "9007199254740993"}` | an arbitrary-precision integer |
| `{"$number": "NaN" \| "Infinity" \| "-Infinity"}` | a non-finite number |
| `{"$undefined": true}` | the language's absent value |
| `{"$cycle": "#/input"}` | a reference to an ancestor, by JSON pointer |
| `{"$ref": "#/input/shipTo"}` | a second reference to an earlier node |
| `{"$utf16": [55296]}` | a string from code units, for a lone surrogate |
| `{"$projection": "/invoiceId"}` | a function returning the value at that JSON pointer in its first argument, for a wrapper's `captureInput` or `captureOutput` |
| `{"$throwingProjection": "message"}` | a function that throws an error with that message |
| `{"$map": {}}`, `{"$set": []}`, `{"$error": {}}`, `{"$buffer": ""}`, `{"$throwingGetter": ""}` | Node-only host values |

`{{run}}` in any string, key or value, is replaced by a value unique to the run,
so ids do not collide between runs and a case can be run twice against one
database.

### Running them

- A **`wire`** case is sent to `POST /v1/events/batch`. Run it twice: once for
  real, reading the result back through `GET /v1/events/:id` and
  `GET /v1/journeys/:id`, and once through `?dryRun=true`. Both must equal the
  expectation. That is what ties the dry run to reality.
- An **`sdk`** case is driven against your recorder with a stub endpoint. Capture
  the request body it sent, compare it with `expect.wire`, then send those exact
  bytes to `?dryRun=true` and compare `expect.results[].stored`. Your SDK never
  calls the dry run itself.
- The loader, the expander and the matcher have to be reimplemented in your
  language. This repository's copy is `packages/protocol/src/conformance.ts`,
  which is around five hundred lines including its comments and its tagged host
  values; the parts a `wire` harness needs are the loader, `{{run}}`
  substitution, the four builders and the comparison, and they are the smaller
  half. Everything they have to do is specified above.
