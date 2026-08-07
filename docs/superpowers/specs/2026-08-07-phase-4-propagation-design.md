# Phase 4: Cross-Process Propagation — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** HTTP header and queue attribute propagation, the opt-in payload envelope, and
propagation levels.

## 1. Context

Phase 3 records a journey inside one process. This phase makes a journey survive crossing
a process boundary, which is the difference between three unrelated timelines and one
record's history.

## 2. Surface

```typescript
recorder.injectHttpHeaders(headers, context): Record<string, string>
recorder.extractHttpContext(headers): JourneyContext | undefined
recorder.toQueueAttributes(context): Record<string, { DataType: string; StringValue: string }>
recorder.fromQueueAttributes(attributes): JourneyContext | undefined
recorder.wrapPayload(payload, context): { _flight: {...}; data: unknown }
recorder.unwrapPayload(body): { context?: JourneyContext; data: unknown }
```

Header names come from `EVENT_PROTOCOL.md` section 10: `x-flight-journey-id`,
`x-flight-entity-type`, `x-flight-entity-id`.

Queue attribute names are `flightJourneyId`, `flightEntityType`, `flightEntityId`.

**Payload mutation is opt-in.** The envelope helpers exist for brokers without attribute
support, and nothing calls them implicitly.

## 3. Propagation levels

Configuration gains `propagate`, defaulting to `"journey-and-type"`.

| Level | Emits |
|---|---|
| `journey-only` | journey ID |
| `journey-and-type` (default) | journey ID, entity type |
| `full` | journey ID, entity type, entity ID |

This follows `SECURITY.md` section 10, which propagates the primary entity ID only "when
explicitly allowed". A journey ID is an opaque UUID that leaks nothing. An entity ID is
often a real customer identifier, and propagating it by default writes that value into
the headers, queue metadata, and logs of downstream systems the project may not control.

**Consequence:** a consumer receives no entity ID at the default level, so it supplies an
`entityFallback` — which Phase 3b's `consume` already accepts, and which the consumer
almost always has from the message body.

**Aliases never propagate, at any level.** Not configurable. `SECURITY.md` section 10
states it unconditionally, and an alias is exactly the identifier a downstream system
should not receive incidentally.

## 4. Extraction validates

An incoming `x-flight-journey-id` is attacker-controlled input. Extraction checks shape —
expected prefix, length bounds, safe character set — and returns `undefined` on failure,
so the consumer starts a fresh journey rather than joining a malformed one.

**What this does not prevent.** Someone who can set headers on a request to an
instrumented service, and who knows or guesses a valid journey ID, can attach events to
that journey. Format validation stops header injection, absurd lengths, control
characters, and accidental garbage. It does not stop a well-formed forgery.

Within a single project that is a modest concern, and the API key already bounds the
blast radius to one project and environment. It is recorded here so the validation is not
mistaken for an authorization control.

## 5. `traceparent` is not ours to write

`EVENT_PROTOCOL.md` section 10 lists `traceparent` among the headers that travel with a
request. The SDK does not write it.

If OpenTelemetry is installed it owns that header and has its own propagator; writing our
own would duplicate or conflict with it. The SDK reads trace context for its events
(Phase 3b) and leaves the wire format to the library that owns it.

## 6. Queue attribute shapes

`toQueueAttributes` emits the SQS shape, `{ Name: { DataType: "String", StringValue } }`,
because `NODE_SDK_SPEC.md` section 7 prioritises SQS.

`fromQueueAttributes` accepts both that shape and a plain `{ name: value }` map. ElasticMQ
and other brokers differ, and a consumer should not have to normalise before calling us.

## 7. Testing

- HTTP round-trip: inject then extract yields the original context.
- Queue round-trip, in both attribute shapes.
- Each level emits exactly its fields and no more.
- Aliases never appear in headers, attributes, or the envelope, even when the journey has
  them.
- Extraction returns `undefined` for: absent headers, an empty journey ID, a wrong prefix,
  an oversized value, control characters, and a non-string value.
- The envelope round-trips and does not mutate the caller's payload object.
- `injectHttpHeaders` does not mutate the caller's header object.

## 8. Acceptance criteria

- A journey survives an HTTP call and a queue hop as one journey.
- No alias is ever propagated.
- The default level omits the entity ID.
- Malformed inbound context is ignored rather than trusted.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 9. Not in this phase

The demo services (Phase 5), replay (Phase 6), and publishing (Phase 7).
