# Phase 3b: SDK Wrapper API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer wraps their existing functions and gets a timeline, without the wrappers changing what those functions return or throw.

**Architecture:** One internal `wrap()` runs every operation, so the contract cannot drift between the seven public wrappers. OpenTelemetry is resolved once at construction and cached, because `record()` is synchronous.

**Tech Stack:** TypeScript 5.9, Vitest 4, optional `@opentelemetry/api`.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-3b-sdk-wrappers-design.md`

---

## Conventions

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

**Run `pnpm lint` and `pnpm typecheck` before every commit.**

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/sdk-node/src/trace.ts` | Optional OpenTelemetry resolution |
| `packages/sdk-node/src/recorder.ts` | The single wrapper implementation, and wires wrappers onto the journey handle |

---

## Task 1: Optional OpenTelemetry

**Files:**
- Create: `packages/sdk-node/src/trace.ts`
- Test: `packages/sdk-node/src/trace.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { createTraceReader } from "./trace.js";

describe("createTraceReader", () => {
  it("returns no context when OpenTelemetry is not installed", () => {
    // ADR-010: OpenTelemetry is optional interoperability, not a dependency.
    // The package is genuinely absent here, which is the case that must not throw.
    const read = createTraceReader();
    expect(read()).toBeUndefined();
  });

  it("never throws when the resolver itself fails", () => {
    const read = createTraceReader(() => {
      throw new Error("resolution exploded");
    });
    expect(() => read()).not.toThrow();
    expect(read()).toBeUndefined();
  });

  it("reads traceId and spanId from an active span", () => {
    const read = createTraceReader(() => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({ traceId: "abc123", spanId: "def456" })
        })
      }
    }));
    expect(read()).toEqual({ traceId: "abc123", spanId: "def456" });
  });

  it("returns no context when there is no active span", () => {
    const read = createTraceReader(() => ({ trace: { getActiveSpan: () => undefined } }));
    expect(read()).toBeUndefined();
  });

  it("never throws when the OpenTelemetry implementation throws", () => {
    const read = createTraceReader(() => ({
      trace: {
        getActiveSpan: () => {
          throw new Error("otel exploded");
        }
      }
    }));
    expect(() => read()).not.toThrow();
    expect(read()).toBeUndefined();
  });

  it("ignores an all-zero span context", () => {
    // OpenTelemetry uses all-zero IDs for an invalid span; recording them would
    // put meaningless identifiers on every event.
    const read = createTraceReader(() => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16) })
        })
      }
    }));
    expect(read()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./trace.js`.

- [ ] **Step 3: Implement**

```typescript
import { createRequire } from "node:module";

export interface TraceContext {
  traceId: string;
  spanId: string;
}

interface OtelApi {
  trace: { getActiveSpan: () => { spanContext: () => TraceContext } | undefined };
}

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/**
 * Read trace context from OpenTelemetry when it happens to be present.
 *
 * Resolution runs once, here, rather than on every record: `record()` is
 * synchronous, so an async dynamic import cannot be used at record time.
 *
 * An absent package, an absent active span, and a throwing OpenTelemetry
 * implementation all degrade to no trace context. ADR-010 makes this optional
 * interoperability, so none of those is an error condition.
 */
export function createTraceReader(resolve?: () => OtelApi | undefined): () => TraceContext | undefined {
  let api: OtelApi | undefined;

  try {
    api = resolve === undefined ? defaultResolve() : resolve();
  } catch {
    api = undefined;
  }

  if (api === undefined) return () => undefined;

  return () => {
    try {
      const context = api.trace.getActiveSpan()?.spanContext();
      if (context === undefined) return undefined;
      if (context.traceId === INVALID_TRACE_ID || context.spanId === INVALID_SPAN_ID) {
        return undefined;
      }
      return { traceId: context.traceId, spanId: context.spanId };
    } catch {
      return undefined;
    }
  };
}

function defaultResolve(): OtelApi | undefined {
  const require = createRequire(import.meta.url);
  return require("@opentelemetry/api") as OtelApi;
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add optional OpenTelemetry trace reader"
```

---

## Task 2: The wrapper contract

**Files:**
- Modify: `packages/sdk-node/src/recorder.ts`
- Test: `packages/sdk-node/src/wrappers.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

// Port 1 refuses connections: every assertion below holds with a dead transport.
const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

function journeyFor() {
  const recorder = createRecorder(base);
  return { recorder, journey: recorder.startJourney({ entity: { type: "customer", id: "1" } }) };
}

class DomainError extends Error {
  public constructor(public readonly code: string) {
    super("domain failure");
  }
}

describe("wrapper contract", () => {
  it("returns the callback's value unchanged", async () => {
    const { journey } = journeyFor();
    const value = { id: 7, nested: { ok: true } };
    await expect(journey.transform("t", {}, () => value)).resolves.toBe(value);
  });

  it("awaits an async callback and returns its value", async () => {
    const { journey } = journeyFor();
    await expect(journey.persist("p", {}, () => Promise.resolve("stored"))).resolves.toBe(
      "stored"
    );
  });

  it("rethrows the callback's exact error object", async () => {
    const { journey } = journeyFor();
    const thrown = new DomainError("phone_required");
    // Identity, not shape: application code branches on instanceof and on custom
    // properties, and a wrapped error would break handling that worked before.
    await expect(
      journey.deliver("d", {}, () => {
        throw thrown;
      })
    ).rejects.toBe(thrown);
  });

  it("preserves a rejected promise's error object", async () => {
    const { journey } = journeyFor();
    const thrown = new DomainError("x");
    await expect(journey.publish("pub", {}, () => Promise.reject(thrown))).rejects.toBe(thrown);
  });

  // The assertions above use a dead endpoint because they are about what the
  // caller receives. What gets *recorded* needs a real server — see the
  // "recorded events" suite below, which is the only way to verify that an
  // attempt greater than 1 becomes `retried`.

  it("records a non-throwing failure when isFailure says so", async () => {
    const { journey } = journeyFor();
    const response = { status: 422 };
    const returned = await journey.deliver("d", {}, () => response, {
      isFailure: (r) => (r as { status: number }).status >= 400
    });
    // The value still comes back untouched — isFailure changes what is recorded,
    // never what the application receives.
    expect(returned).toBe(response);
  });

  it("does not treat a normal result as a failure", async () => {
    const { journey } = journeyFor();
    await expect(
      journey.deliver("d", {}, () => ({ status: 200 }), {
        isFailure: (r) => (r as { status: number }).status >= 400
      })
    ).resolves.toEqual({ status: 200 });
  });

  it("survives an isFailure predicate that throws", async () => {
    const { journey } = journeyFor();
    await expect(
      journey.deliver("d", {}, () => "value", {
        isFailure: () => {
          throw new Error("predicate exploded");
        }
      })
    ).resolves.toBe("value");
  });

  it("fail() and finish() do not throw", () => {
    const { journey } = journeyFor();
    expect(() => {
      journey.fail("f", new Error("boom"), { attempt: 3 });
      journey.finish({ status: "failed" });
    }).not.toThrow();
  });

  it("consume builds a journey from a supplied context", () => {
    const recorder = createRecorder(base);
    const journey = recorder.consume({
      context: { journeyId: "jrn_existing", entity: { type: "customer", id: "9" } }
    });
    expect(journey.context().journeyId).toBe("jrn_existing");
  });

  it("consume falls back to an entity when no context was propagated", () => {
    const recorder = createRecorder(base);
    const journey = recorder.consume({ entityFallback: { type: "customer", id: "9" } });
    expect(journey.context().journeyId).toMatch(/^jrn_/);
    expect(journey.context().entity.id).toBe("9");
  });
});

describe("recorded events", () => {
  let server: Server;
  let endpoint: string;
  let received: Record<string, unknown>[];

  beforeEach(async () => {
    received = [];
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
        received.push(...parsed.events.map((e) => e.event));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: { results: [] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function recordAnd(fn: (journey: Journey) => Promise<void> | void) {
    const recorder = createRecorder({ ...base, endpoint });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    await fn(journey);
    await recorder.shutdown({ timeoutMs: 2_000 });
    return received;
  }

  it("records the natural operation and a duration", async () => {
    const events = await recordAnd((journey) => journey.transform("t", { a: 1 }, () => ({ a: 2 })));
    const transformed = events.find((e) => e["operation"] === "transformed");
    expect(transformed).toBeDefined();
    expect(transformed?.["durationMs"]).toBeTypeOf("number");
  });

  it("records `retried` when the attempt is greater than one", async () => {
    // ADR-022: the caller supplies attempt, because a retry commonly happens in
    // a different process consuming a redelivered message.
    const events = await recordAnd((journey) =>
      journey.deliver("d", {}, () => "ok", { attempt: 2 })
    );
    expect(events.some((e) => e["operation"] === "retried")).toBe(true);
    expect(events.some((e) => e["operation"] === "delivered")).toBe(false);
  });

  it("records an error for a non-throwing failure", async () => {
    const events = await recordAnd((journey) =>
      journey.deliver("d", {}, () => ({ status: 422 }), {
        isFailure: (r) => (r as { status: number }).status >= 400
      })
    );
    const delivered = events.find((e) => e["operation"] === "delivered");
    expect(delivered?.["error"]).toBeDefined();
  });

  it("records the thrown error's message and type", async () => {
    const events = await recordAnd(async (journey) => {
      await journey
        .persist("p", {}, () => {
          throw new DomainError("phone_required");
        })
        .catch(() => undefined);
    });
    const persisted = events.find((e) => e["operation"] === "persisted");
    expect(persisted?.["error"]).toMatchObject({ type: "Error", code: "phone_required" });
  });

  it("records finish as completed", async () => {
    const events = await recordAnd((journey) => {
      journey.finish({ status: "completed" });
    });
    expect(events.some((e) => e["operation"] === "completed")).toBe(true);
  });
});
```

The wrapper tests need these imports at the top of the file:

```typescript
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecorder, type Journey } from "./recorder.js";
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL — `transform` is not a function.

- [ ] **Step 3: Implement the shared wrapper**

Add to `recorder.ts`, inside `createRecorder`, above `makeJourney`:

```typescript
  interface WrapOptions {
    isFailure?: (result: unknown) => boolean;
    attempt?: number;
    metadata?: Record<string, unknown>;
  }

  /**
   * One implementation behind all seven public wrappers, so the contract cannot
   * drift between them.
   *
   * Returns the callback's value unchanged and rethrows its exact error object.
   * Everything the recorder does is inside `safely`, so a recording failure
   * cannot reach the caller.
   *
   * Shipped differently: the always-async signature below was superseded by
   * commit 78c2a6c. A wrapper unconditionally async around a synchronous
   * callback silently changed a handler's control flow, so the shipped
   * `wrap` returns `T | Promise<T>` and follows the shape of its callback:
   * sync in, sync out.
   */
  async function wrap<T>(
    context: JourneyContext,
    naturalOperation: string,
    name: string,
    input: unknown,
    fn: () => T | Promise<T>,
    options: WrapOptions = {}
  ): Promise<T> {
    const startedAt = Date.now();
    const attempt = options.attempt ?? 1;
    // ADR-022: a retry records as `retried` rather than the natural verb.
    const operation = attempt > 1 ? "retried" : naturalOperation;

    let result: T;
    try {
      result = await fn();
    } catch (error) {
      safely(diagnostics, "capture_error", () => {
        enqueue(context.journeyId, context.entity, {
          operation,
          name,
          input,
          durationMs: Date.now() - startedAt,
          error: toErrorRecord(error),
          ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata, attempt } })
        });
      });
      // The original object, not a copy: application code branches on instanceof.
      throw error;
    }

    safely(diagnostics, "capture_error", () => {
      const failed = options.isFailure === undefined ? false : options.isFailure(result);
      enqueue(context.journeyId, context.entity, {
        operation,
        name,
        input,
        output: result,
        durationMs: Date.now() - startedAt,
        ...(failed
          ? { error: { message: `${name} reported a failed result.`, code: "result_failed" } }
          : {}),
        ...(options.metadata === undefined && attempt === 1
          ? {}
          : { metadata: { ...options.metadata, attempt } })
      });
    });

    return result;
  }

  function toErrorRecord(error: unknown): { message: string; type?: string; code?: string } {
    if (error instanceof Error) {
      return {
        message: error.message,
        type: error.name,
        ...(typeof (error as { code?: unknown }).code === "string"
          ? { code: (error as { code: string }).code }
          : {})
      };
    }
    return { message: String(error) };
  }
```

- [ ] **Step 4: Expose the wrappers on the journey handle**

Extend the `Journey` interface and `makeJourney` with:

```typescript
      transform: (name, input, fn, options) =>
        wrap(context, "transformed", name, input, fn, options),
      persist: (name, input, fn, options) => wrap(context, "persisted", name, input, fn, options),
      publish: (name, message, fn, options) =>
        wrap(context, "published", name, message, fn, options),
      deliver: (name, payload, fn, options) =>
        wrap(context, "delivered", name, payload, fn, options),
      fail(name, error, metadata) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "failed",
            name,
            error: toErrorRecord(error),
            ...(metadata === undefined ? {} : { metadata })
          });
        });
      },
      finish(options) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: options?.status === "failed" ? "failed" : "completed",
            name: "finish"
          });
        });
      }
```

And add `consume` to the returned recorder:

```typescript
    consume: (options) =>
      makeJourney(
        options.context ?? {
          journeyId: `jrn_${randomUUID()}`,
          entity: options.entityFallback ?? { type: "unknown", id: "unknown" }
        }
      ),
```

Shipped differently: commit 4fdf1a4 made `journeyId` and `entity` default
independently rather than as one unit, so `entityFallback` applies whenever a
context is present but lacks an entity, not only when no context is present at
all.

- [ ] **Step 5: Attach trace context**

In `enqueue`, add the trace fields when a reader returns them:

```typescript
  const readTrace = createTraceReader();
  // ...inside the event object:
        ...(readTrace() ?? {}),
```

- [ ] **Step 6: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add the wrapper API"
```

---

## Task 3: Verify Phase 3b

- [ ] **Step 1: Prove the reference scenario end to end through wrappers**

Bring up the stack, seed a key, and run a script that uses `transform` with the phone
defect and `deliver` with an `isFailure` predicate against a 422, then a `retried`
attempt, then `finish({ status: "failed" })`. Confirm through the API that the timeline
shows `transformed`, `delivered` with an error, `retried`, and `failed`.

- [ ] **Step 2: Clean-clone pipeline**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q --branch phase-3b-sdk-wrappers . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

- [ ] **Step 3: Merge, confirm CI, tag**

```bash
git checkout main && git merge --no-ff phase-3b-sdk-wrappers
git push origin main
glab ci list --per-page 1
git tag -a phase-3-complete -m "Phase 3: Node SDK"
git push origin phase-3-complete
```

---

## Definition of done

Every checkbox, Task 3 passing, CI green.

**Not in this phase:** propagation (Phase 4), demo services (Phase 5), npm publishing
(Phase 7).
