# Phase 4: Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A journey survives crossing a process boundary — over HTTP and over a queue — as one journey rather than three.

**Architecture:** One `propagation.ts` module holding the wire format, driven by a `propagate` level. The recorder exposes it; the module itself is pure and has no dependency on recorder state.

**Tech Stack:** TypeScript 5.9, Vitest 4.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-4-propagation-design.md`

---

## Conventions

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

**Run `pnpm lint` and `pnpm typecheck` before every commit.**

---

## Task 1: The propagation module

**Files:**
- Create: `packages/sdk-node/src/propagation.ts`
- Test: `packages/sdk-node/src/propagation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import {
  extractHttpContext,
  fromQueueAttributes,
  injectHttpHeaders,
  toQueueAttributes,
  unwrapPayload,
  wrapPayload
} from "./propagation.js";

const context = {
  journeyId: "jrn_11111111-2222-3333-4444-555555555555",
  entity: { type: "customer", id: "0018Z00002ABC" }
};

describe("HTTP propagation", () => {
  it("round-trips a context at the full level", () => {
    const headers = injectHttpHeaders({}, context, "full");
    expect(extractHttpContext(headers)).toEqual(context);
  });

  it("omits the entity id at the default level", () => {
    // SECURITY section 10: the primary entity ID propagates only when allowed.
    const headers = injectHttpHeaders({}, context, "journey-and-type");
    expect(headers["x-flight-entity-id"]).toBeUndefined();
    expect(headers["x-flight-entity-type"]).toBe("customer");
  });

  it("emits only the journey id at journey-only", () => {
    const headers = injectHttpHeaders({}, context, "journey-only");
    expect(Object.keys(headers)).toEqual(["x-flight-journey-id"]);
  });

  it("never emits an alias", () => {
    const headers = injectHttpHeaders({}, context, "full");
    expect(JSON.stringify(headers)).not.toContain("alias");
  });

  it("does not mutate the caller's header object", () => {
    const original = { "content-type": "application/json" };
    injectHttpHeaders(original, context, "full");
    expect(original).toEqual({ "content-type": "application/json" });
  });

  it("preserves existing headers", () => {
    const headers = injectHttpHeaders({ authorization: "Bearer x" }, context, "journey-only");
    expect(headers["authorization"]).toBe("Bearer x");
  });

  it("returns undefined when no context is present", () => {
    expect(extractHttpContext({})).toBeUndefined();
  });

  it.each([
    ["an empty journey id", ""],
    ["a wrong prefix", "trace_11111111-2222-3333-4444-555555555555"],
    ["an oversized value", `jrn_${"x".repeat(400)}`],
    ["a control character", "jrn_1111\n1111"],
    ["a space", "jrn_1111 1111"]
  ])("rejects %s", (_label, journeyId) => {
    // Inbound context is attacker-controlled. Rejecting means the consumer
    // starts a fresh journey rather than joining a malformed one.
    expect(extractHttpContext({ "x-flight-journey-id": journeyId })).toBeUndefined();
  });

  it("extracts a journey without an entity when only the id was sent", () => {
    const headers = injectHttpHeaders({}, context, "journey-only");
    expect(extractHttpContext(headers)?.journeyId).toBe(context.journeyId);
    expect(extractHttpContext(headers)?.entity).toBeUndefined();
  });
});

describe("queue propagation", () => {
  it("round-trips through SQS-shaped attributes", () => {
    expect(fromQueueAttributes(toQueueAttributes(context, "full"))).toEqual(context);
  });

  it("emits the SQS attribute shape", () => {
    const attributes = toQueueAttributes(context, "journey-only");
    expect(attributes["flightJourneyId"]).toEqual({
      DataType: "String",
      StringValue: context.journeyId
    });
  });

  it("accepts a plain name-to-value map", () => {
    // ElasticMQ and other brokers differ; a consumer should not have to
    // normalise before calling us.
    const plain = { flightJourneyId: context.journeyId, flightEntityType: "customer" };
    expect(fromQueueAttributes(plain)?.journeyId).toBe(context.journeyId);
  });

  it("returns undefined for absent attributes", () => {
    expect(fromQueueAttributes({})).toBeUndefined();
    expect(fromQueueAttributes(undefined)).toBeUndefined();
  });

  it("rejects a malformed journey id", () => {
    expect(fromQueueAttributes({ flightJourneyId: "nope" })).toBeUndefined();
  });
});

describe("payload envelope", () => {
  it("round-trips and leaves the caller's payload untouched", () => {
    const payload = { customerId: 18492 };
    const wrapped = wrapPayload(payload, context, "full");
    expect(payload).toEqual({ customerId: 18492 });

    const { context: extracted, data } = unwrapPayload(wrapped);
    expect(extracted).toEqual(context);
    expect(data).toEqual(payload);
  });

  it("returns the body as data when there is no envelope", () => {
    const body = { plain: true };
    expect(unwrapPayload(body)).toEqual({ data: body });
  });

  it("ignores a malformed envelope but keeps the data", () => {
    const { context: extracted, data } = unwrapPayload({ _flight: { journeyId: "bad" }, data: 1 });
    expect(extracted).toBeUndefined();
    expect(data).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./propagation.js`.

- [ ] **Step 3: Implement**

```typescript
export type PropagationLevel = "journey-only" | "journey-and-type" | "full";

export interface PropagatedContext {
  journeyId: string;
  entity?: { type: string; id: string };
}

const HEADER_JOURNEY = "x-flight-journey-id";
const HEADER_ENTITY_TYPE = "x-flight-entity-type";
const HEADER_ENTITY_ID = "x-flight-entity-id";

const ATTR_JOURNEY = "flightJourneyId";
const ATTR_ENTITY_TYPE = "flightEntityType";
const ATTR_ENTITY_ID = "flightEntityId";

const MAX_VALUE_LENGTH = 256;
// Printable ASCII without whitespace or control characters: enough for our own
// identifiers, and it rejects header injection outright.
const SAFE_VALUE = /^[\w.:@=+-]+$/;

interface Fields {
  journeyId: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Which fields a level emits.
 *
 * Aliases appear in no branch and are not configurable: SECURITY section 10
 * states that unconditionally, and an alias is exactly the identifier a
 * downstream system should not receive incidentally.
 */
function fieldsFor(context: PropagatedContext, level: PropagationLevel): Fields {
  if (level === "journey-only") return { journeyId: context.journeyId };
  if (level === "journey-and-type") {
    return {
      journeyId: context.journeyId,
      ...(context.entity === undefined ? {} : { entityType: context.entity.type })
    };
  }
  return {
    journeyId: context.journeyId,
    ...(context.entity === undefined
      ? {}
      : { entityType: context.entity.type, entityId: context.entity.id })
  };
}

export function injectHttpHeaders(
  headers: Record<string, string>,
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): Record<string, string> {
  const fields = fieldsFor(context, level);
  // A copy: mutating the caller's header object would surprise anyone reusing it.
  return {
    ...headers,
    [HEADER_JOURNEY]: fields.journeyId,
    ...(fields.entityType === undefined ? {} : { [HEADER_ENTITY_TYPE]: fields.entityType }),
    ...(fields.entityId === undefined ? {} : { [HEADER_ENTITY_ID]: fields.entityId })
  };
}

// Shipped differently: the implementation validates `entity.id` against
// `SAFE_VALUE` before including it at the `full` level, and wraps all six
// propagation helpers in `safely()` with degrade-not-break fallbacks
// (commit 4fdf1a4, 2026-08-09).

export function extractHttpContext(
  headers: Record<string, string | string[] | undefined> | undefined
): PropagatedContext | undefined {
  if (headers === undefined) return undefined;
  return build(
    single(headers[HEADER_JOURNEY]),
    single(headers[HEADER_ENTITY_TYPE]),
    single(headers[HEADER_ENTITY_ID])
  );
}

export function toQueueAttributes(
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): Record<string, { DataType: string; StringValue: string }> {
  const fields = fieldsFor(context, level);
  const attribute = (StringValue: string) => ({ DataType: "String", StringValue });
  return {
    [ATTR_JOURNEY]: attribute(fields.journeyId),
    ...(fields.entityType === undefined ? {} : { [ATTR_ENTITY_TYPE]: attribute(fields.entityType) }),
    ...(fields.entityId === undefined ? {} : { [ATTR_ENTITY_ID]: attribute(fields.entityId) })
  };
}

export function fromQueueAttributes(attributes: unknown): PropagatedContext | undefined {
  if (typeof attributes !== "object" || attributes === null) return undefined;
  const record = attributes as Record<string, unknown>;
  return build(
    attributeValue(record[ATTR_JOURNEY]),
    attributeValue(record[ATTR_ENTITY_TYPE]),
    attributeValue(record[ATTR_ENTITY_ID])
  );
}

export function wrapPayload(
  payload: unknown,
  context: PropagatedContext,
  level: PropagationLevel = "journey-and-type"
): { _flight: Fields; data: unknown } {
  return { _flight: fieldsFor(context, level), data: payload };
}

export function unwrapPayload(body: unknown): { context?: PropagatedContext; data: unknown } {
  if (typeof body !== "object" || body === null || !("_flight" in body)) {
    return { data: body };
  }
  const envelope = (body as { _flight: unknown; data: unknown })._flight;
  const data = (body as { data: unknown }).data;
  if (typeof envelope !== "object" || envelope === null) return { data };

  const fields = envelope as Record<string, unknown>;
  const context = build(
    stringOrUndefined(fields["journeyId"]),
    stringOrUndefined(fields["entityType"]),
    stringOrUndefined(fields["entityId"])
  );
  return context === undefined ? { data } : { context, data };
}

/** Accepts either the SQS attribute shape or a plain value. */
function attributeValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "StringValue" in value) {
    return stringOrUndefined((value as { StringValue: unknown }).StringValue);
  }
  return undefined;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Build a context from untrusted input.
 *
 * Rejecting a malformed journey ID means the consumer starts a fresh journey
 * rather than joining a corrupted one. This stops injection, absurd lengths, and
 * control characters — it does not stop a well-formed forgery, and is not an
 * authorization control.
 */
function build(
  journeyId: string | undefined,
  entityType: string | undefined,
  entityId: string | undefined
): PropagatedContext | undefined {
  if (!isSafe(journeyId) || !journeyId.startsWith("jrn_")) return undefined;

  if (isSafe(entityType) && isSafe(entityId)) {
    return { journeyId, entity: { type: entityType, id: entityId } };
  }
  return { journeyId };
}

function isSafe(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    SAFE_VALUE.test(value)
  );
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add HTTP and queue context propagation"
```

---

## Task 2: Expose it on the recorder

**Files:**
- Modify: `packages/sdk-node/src/config.ts`, `packages/sdk-node/src/recorder.ts`, `packages/sdk-node/src/index.ts`
- Test: `packages/sdk-node/src/propagation-recorder.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

describe("recorder propagation", () => {
  it("uses the configured level", () => {
    const recorder = createRecorder({ ...base, propagate: "full" });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "42" } });
    const headers = recorder.injectHttpHeaders({}, journey.context());
    expect(headers["x-flight-entity-id"]).toBe("42");
  });

  it("defaults to omitting the entity id", () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "42" } });
    expect(recorder.injectHttpHeaders({}, journey.context())["x-flight-entity-id"]).toBeUndefined();
  });

  it("continues a journey across a simulated process boundary", () => {
    const producer = createRecorder({ ...base, propagate: "full" });
    const journey = producer.startJourney({ entity: { type: "customer", id: "42" } });
    const attributes = producer.toQueueAttributes(journey.context());

    // A different recorder instance, as a separate process would have.
    const consumer = createRecorder(base);
    const continued = consumer.consume({
      context: consumer.fromQueueAttributes(attributes),
      entityFallback: { type: "customer", id: "42" }
    });

    expect(continued.context().journeyId).toBe(journey.context().journeyId);
  });

  it("starts a new journey when the inbound context is malformed", () => {
    const consumer = createRecorder(base);
    const continued = consumer.consume({
      context: consumer.fromQueueAttributes({ flightJourneyId: "forged" }),
      entityFallback: { type: "customer", id: "42" }
    });
    expect(continued.context().journeyId).toMatch(/^jrn_/);
    expect(continued.context().entity.id).toBe("42");
  });
});
```

- [ ] **Step 2: Add `propagate` to config**

In `config.ts`, add `propagate?: PropagationLevel` to `RecorderConfig`, `propagate:
PropagationLevel` to `ResolvedConfig`, and `propagate: config.propagate ??
"journey-and-type"` to `resolveConfig`.

- [ ] **Step 3: Expose the helpers**

Add to the `Recorder` interface and its implementation, passing `resolved.propagate` so
callers never have to repeat the level:

```typescript
    injectHttpHeaders: (headers, context) =>
      injectHttpHeaders(headers, context, resolved.propagate),
    extractHttpContext,
    toQueueAttributes: (context) => toQueueAttributes(context, resolved.propagate),
    fromQueueAttributes,
    wrapPayload: (payload, context) => wrapPayload(payload, context, resolved.propagate),
    unwrapPayload,
```

Shipped differently: the implementation wraps all six of these in `safely()` with
degrade-not-break fallbacks, because a plain-JavaScript caller with no instrumentation
would otherwise dereference an `undefined` context and kill the process (commit 4fdf1a4,
2026-08-09).

**`consume` needs widening.** It currently takes `context?: JourneyContext`, where
`entity` is required — but `fromQueueAttributes` returns a context whose entity is absent
at the default propagation level, which is the normal case. Change its signature to accept
`PropagatedContext` and resolve the entity from the context when present, the fallback
otherwise:

```typescript
    consume: (options) => {
      const journeyId = options.context?.journeyId ?? `jrn_${randomUUID()}`;
      const entity =
        options.context?.entity ?? options.entityFallback ?? { type: "unknown", id: "unknown" };
      return makeJourney({ journeyId, entity });
    },
```

This is the point of the default level: the journey ID crosses the boundary, and the
consumer supplies the entity it already has from the message body.

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): expose propagation helpers on the recorder"
```

---

## Task 3: Verify Phase 4

- [ ] **Step 1: Prove one journey spans two recorder instances against the live stack**

Bring up the stack, seed a key, and run a script where a "producer" recorder starts a
journey and emits queue attributes, and a separate "consumer" recorder continues from
them and records further events. Confirm through the API that both sets of events appear
on **one** journey with both service names.

- [ ] **Step 2: Clean-clone pipeline**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q --branch phase-4-propagation . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

- [ ] **Step 3: Merge, confirm CI, tag**

```bash
git checkout main && git merge --no-ff phase-4-propagation
git push origin main
glab ci list --per-page 1
git tag -a phase-4-complete -m "Phase 4: propagation"
git push origin phase-4-complete
```

---

## Definition of done

Every checkbox, Task 3 passing, CI green.

**Not in this phase:** the demo services (Phase 5), replay (Phase 6), publishing (Phase 7).
