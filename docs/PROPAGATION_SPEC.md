# Propagation specification

This document is normative for carrying Wayscribe journey context across HTTP,
SQS/SNS message attributes, and payload envelopes. It freezes the carrier names
and behavior released by `@wayscribe/node@0.1.0`. The language-neutral vectors
in [`packages/protocol/fixtures/propagation.json`](../packages/protocol/fixtures/propagation.json)
are executable examples of this contract.

The event wire remains governed by [the event protocol](EVENT_PROTOCOL.md) and
[the ingestion contract](INGESTION_CONTRACT.md). Recorder reliability, capture,
and delivery remain governed by [the SDK specification](SDK_SPEC.md). This
document governs only propagation carriers and context extraction.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are interpreted as in
RFC 2119 and RFC 8174 when they appear in capitals.

## 1. Context and privacy levels

A propagated context has this language-neutral shape:

```json
{
  "journeyId": "jrn_123",
  "entity": { "type": "order", "id": "ORD-42" }
}
```

`entity` is optional. An extracted entity exists only when both `type` and `id`
are usable. Aliases are not context fields and MUST NOT be injected at any
level.

Every injector supports these levels:

| Level | Fields emitted |
| --- | --- |
| `journey-only` | journey ID |
| `journey-and-type` | journey ID and, when present, entity type |
| `full` | journey ID and, when present, entity type and a usable entity ID |

`journey-and-type` MUST be the recorder default. `full` is an explicit privacy
opt-in. An entity ID that does not satisfy section 2 MUST be omitted even at
`full`; the journey and entity type still propagate.

Injectors receive recorder context, not untrusted carrier input. They emit its
journey ID and entity type unchanged according to the selected level. Recorder
implementations MUST create valid journey IDs, and callers that construct
contexts directly MUST supply a value that satisfies section 2. Extraction is
the validation boundary for carrier input.

## 2. Value grammar and context parsing

A usable propagated value:

- is a string from 1 through 256 characters inclusive;
- contains only ASCII letters, ASCII digits, `_`, `.`, `:`, `@`, `=`, `+`, or
  `-`; and
- for a journey ID, begins with `jrn_`.

Whitespace, `/`, non-ASCII characters, and control characters are therefore
invalid. The 256-character limit is inclusive; 257 characters are invalid.

Extraction MUST apply these rules after reading carrier values:

1. If the journey ID is absent or unusable, extraction returns no context.
2. If both entity type and entity ID are usable, extraction returns the journey
   and complete entity.
3. If either optional identity field is absent or unusable, extraction returns
   only the journey. It MUST NOT return a partial entity.
4. Unknown carrier and context fields do not become propagated context.

No extraction failure throws into host application code. The public Node
helpers return `undefined`; the JSON vectors represent that result as `null`.

## 3. HTTP carrier

The field names are:

| Context field | HTTP header |
| --- | --- |
| journey ID | `x-wayscribe-journey-id` |
| entity type | `x-wayscribe-entity-type` |
| entity ID | `x-wayscribe-entity-id` |

HTTP names compare without case. Injection MUST copy the supplied header map,
remove every existing spelling of the three Wayscribe names, then add the
selected fields under the lower-case names above. It MUST preserve every other
header, including `traceparent`, and MUST NOT mutate the caller's map.

Extraction accepts a Fetch-compatible `Headers` reader or a name-to-value map.
It reads names without case. For a map, an exact lower-case key wins if another
case spelling is also present. A string value is read directly; from a list,
only the first item is considered and it must be a string. Numbers, later list
items, and other value shapes are absent.

## 4. SQS/SNS message-attribute carrier

The attribute names are:

| Context field | Message attribute |
| --- | --- |
| journey ID | `wayscribeJourneyId` |
| entity type | `wayscribeEntityType` |
| entity ID | `wayscribeEntityId` |

Attribute names compare with case. Injection MUST copy the supplied map, remove
the three exact Wayscribe names, and add each selected value as:

```json
{ "DataType": "String", "StringValue": "jrn_123" }
```

Other attributes, including names that differ only by case, are preserved.
The caller's map is not mutated.

Extraction accepts either the object above or a plain string value. For
compatibility with the released reader, an object contributes its
`StringValue` when that property is a string; extraction does not inspect
`DataType`. Attribute names remain case-sensitive. Other shapes are absent.

## 5. Payload-envelope carrier

Injection returns a new envelope:

```json
{
  "_wayscribe": {
    "journeyId": "jrn_123",
    "entityType": "order",
    "entityId": "ORD-42"
  },
  "data": { "order": 42 }
}
```

The `_wayscribe` key and its `journeyId`, `entityType`, and `entityId` fields
are case-sensitive. The selected privacy level determines which fields are
present. The data value is passed through unchanged. Payload injection creates
a fresh envelope, so it has no carrier map from which to preserve or strip
fields.

Extraction distinguishes carrier recognition from context parsing:

- A non-object, `null`, or object without the exact `_wayscribe` key is not an
  envelope. The entire input is returned as `data`, with no context.
- An object with `_wayscribe` is an envelope even when that field or its
  journey is malformed. Its `data` property is returned, and an unusable
  context is omitted.
- Unknown fields inside `_wayscribe` do not enter the context. Other top-level
  envelope fields do not enter the extracted data.

The Node `hasJourney` helper is a structural type guard, not the parser above.
It returns true when `_wayscribe.journeyId` is a non-empty string and never
throws; it does not apply the prefix, character, or length rules. Call
`extractPayload` when validated context or legacy-body pass-through is needed.

## 6. Trace and environment boundaries

Wayscribe propagation MUST NOT add, replace, or interpret `traceparent`.
OpenTelemetry owns trace-context propagation. A caller-provided `traceparent`
is just another non-Wayscribe carrier field and is preserved by injection.

These carriers deliberately contain no project or environment field. The
receiving recorder uses its own configured environment, and the API key binds
ingestion to a project and environment. If a journey ID from another
environment is submitted, the server refuses it with
`journey_environment_mismatch`; the host application must then start a new
journey for the receiver's environment. Implementations MUST NOT invent
environment carrier metadata or silently treat a refused cross-environment
journey as stored.

## 7. Conformance vectors

[`propagation.json`](../packages/protocol/fixtures/propagation.json) is a JSON
object with this schema:

```text
{
  "version": 1,
  "cases": [
    {
      "name": string,
      "carrier": "http" | "sqs" | "payload",
      "action": "inject" | "extract",
      "input": object,
      "expected": any JSON value
    }
  ]
}
```

For HTTP and SQS injection, `input` contains `context`, `level`, and `carrier`;
`expected` is the complete output carrier. Payload injection uses `data`
instead of `carrier`; `expected` is the complete envelope.

For HTTP and SQS extraction, `input.carrier` is the complete input carrier and
`expected` is the extracted context or `null`. For payload extraction,
`input.carrier` is the complete body and `expected` has exactly `context` and
`data`; `context` is `null` when no usable context exists.

Expected values are literals. A runner MUST compare the complete result and
MUST NOT build expected values with the implementation under test. Every
implementation claiming these carriers MUST run every applicable case.

The fixture version describes the fixture schema, not a wire-version field.
Additive cases keep version 1. A schema change increments `version`. A change to
any carrier name, grammar, stripping rule, or extraction result is a contract
change and requires an architecture decision and compatibility plan.
