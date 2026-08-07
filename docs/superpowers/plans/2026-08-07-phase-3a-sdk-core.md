# Phase 3a: SDK Reliability Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An SDK that records events into a bounded queue and ships them reliably, and that cannot break the application it is embedded in — under any injected failure.

**Architecture:** One `safely()` boundary wraps every public entry point. Capture is synchronous with a size guard. A bounded queue drops oldest. Transport batches, retries with capped jittered backoff, and opens a circuit breaker — all against an injected clock so timing is tested deterministically.

**Tech Stack:** TypeScript 5.9, Zod 4 (via protocol), Vitest 4, node:crypto.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-3a-sdk-core-design.md`

---

## Conventions

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

**Run `pnpm lint` and `pnpm typecheck` before every commit.**

Write the failure-injection tests before the code they guard. In this package that is not
a style preference — the tests are the deliverable, and the implementation is what makes
them pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/payload-security/src/redaction.ts` | Subpath entry: redact, limits, secrets |
| `packages/sdk-node/src/diagnostics.ts` | Counters and the diagnostics callback |
| `packages/sdk-node/src/safely.ts` | The single failure boundary |
| `packages/sdk-node/src/queue.ts` | Bounded queue, drop-oldest |
| `packages/sdk-node/src/transport.ts` | Batching, retry, backoff, breaker |
| `packages/sdk-node/src/clock.ts` | Injectable clock and timers |
| `packages/sdk-node/src/recorder.ts` | createRecorder, journey handles |
| `packages/sdk-node/src/config.ts` | Config with defaults |

---

## Task 1: payload-security subpath export

**Files:**
- Create: `packages/payload-security/src/redaction.ts`
- Modify: `packages/payload-security/package.json`, `tsconfig.build.json` if needed

- [ ] **Step 1: Create the subpath entry**

```typescript
/**
 * Client-safe subset of payload-security.
 *
 * The SDK is embedded in other companies' applications. It needs redaction and
 * size checks; it must not pull in AES encryption, API-key generation, or HMAC
 * search tokens, which are server-side concerns and pure bloat in a customer's
 * bundle.
 */
export { DEFAULT_LIMITS, checkLimits, type LimitResult, type LimitViolation, type Limits } from "./limits.js";
export { CIRCULAR, REDACTED, redact } from "./redact.js";
export { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
```

- [ ] **Step 2: Publish the subpath**

In `packages/payload-security/package.json`, add to `exports`:

```json
    "./redaction": {
      "development": "./src/redaction.ts",
      "types": "./dist/redaction.d.ts",
      "default": "./dist/redaction.js"
    }
```

- [ ] **Step 3: Verify and commit**

```bash
pnpm build && pnpm lint && pnpm typecheck
git add packages/payload-security
git commit -m "feat(payload-security): add client-safe redaction subpath export"
```

---

## Task 2: Clock and diagnostics

**Files:**
- Create: `packages/sdk-node/src/clock.ts`, `packages/sdk-node/src/diagnostics.ts`
- Test: `packages/sdk-node/src/diagnostics.test.ts`

- [ ] **Step 1: Clock**

```typescript
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): { unref?: () => void; clear: () => void };
}

/**
 * Injected so backoff and breaker recovery are tested deterministically rather
 * than with sleeps — the difference between a fast suite and a flaky one.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => {
    const handle = setTimeout(handler, ms);
    // Never hold the host's event loop open on our account.
    handle.unref?.();
    return { clear: () => { clearTimeout(handle); } };
  }
};
```

- [ ] **Step 2: Write the diagnostics test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "./diagnostics.js";

describe("diagnostics", () => {
  it("counts events by kind", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    diagnostics.report({ kind: "transport_error", reason: "timeout" });

    expect(diagnostics.counters().dropped).toBe(2);
    expect(diagnostics.counters().transportErrors).toBe(1);
  });

  it("invokes the callback when one is supplied", () => {
    const onDiagnostic = vi.fn();
    const diagnostics = createDiagnostics(onDiagnostic);
    diagnostics.report({ kind: "dropped", reason: "queue_full" });
    expect(onDiagnostic).toHaveBeenCalledOnce();
  });

  it("never throws when the callback throws", () => {
    // A diagnostics callback that throws must not become the failure it reports.
    const diagnostics = createDiagnostics(() => {
      throw new Error("callback exploded");
    });
    expect(() => {
      diagnostics.report({ kind: "dropped", reason: "queue_full" });
    }).not.toThrow();
    expect(diagnostics.counters().dropped).toBe(1);
  });

  it("does not write to the console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createDiagnostics().report({ kind: "transport_error", reason: "boom" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./diagnostics.js`.

- [ ] **Step 4: Implement**

```typescript
export type DiagnosticKind = "dropped" | "transport_error" | "capture_error" | "breaker_open";

export interface Diagnostic {
  kind: DiagnosticKind;
  reason: string;
  detail?: unknown;
}

export interface Counters {
  dropped: number;
  transportErrors: number;
  captureErrors: number;
  breakerOpened: number;
  sent: number;
}

export interface Diagnostics {
  report(diagnostic: Diagnostic): void;
  recordSent(count: number): void;
  counters(): Counters;
}

/**
 * Failures go to counters and an optional callback, never to the console.
 *
 * SECURITY.md section 12 forbids recursive logging of recorder failures: a
 * recorder that writes to stderr on every failed flush becomes the incident
 * during an outage.
 */
export function createDiagnostics(onDiagnostic?: (diagnostic: Diagnostic) => void): Diagnostics {
  const counters: Counters = {
    dropped: 0,
    transportErrors: 0,
    captureErrors: 0,
    breakerOpened: 0,
    sent: 0
  };

  return {
    report(diagnostic) {
      if (diagnostic.kind === "dropped") counters.dropped += 1;
      if (diagnostic.kind === "transport_error") counters.transportErrors += 1;
      if (diagnostic.kind === "capture_error") counters.captureErrors += 1;
      if (diagnostic.kind === "breaker_open") counters.breakerOpened += 1;

      try {
        onDiagnostic?.(diagnostic);
      } catch {
        // A diagnostics callback that throws must not become the failure it
        // was reporting.
      }
    },
    recordSent(count) {
      counters.sent += count;
    },
    counters: () => ({ ...counters })
  };
}
```

- [ ] **Step 5: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add injectable clock and non-logging diagnostics"
```

---

## Task 3: The safety boundary

**Files:**
- Create: `packages/sdk-node/src/safely.ts`
- Test: `packages/sdk-node/src/safely.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "./diagnostics.js";
import { safely, safelyAsync } from "./safely.js";

describe("safely", () => {
  it("returns the value when nothing throws", () => {
    expect(safely(createDiagnostics(), "capture_error", () => 42)).toBe(42);
  });

  it("swallows a thrown error and returns undefined", () => {
    const diagnostics = createDiagnostics();
    const result = safely(diagnostics, "capture_error", () => {
      throw new Error("boom");
    });
    expect(result).toBeUndefined();
    expect(diagnostics.counters().captureErrors).toBe(1);
  });

  it("swallows a thrown non-Error", () => {
    const diagnostics = createDiagnostics();
    expect(
      safely(diagnostics, "capture_error", () => {
        throw "a string";
      })
    ).toBeUndefined();
    expect(diagnostics.counters().captureErrors).toBe(1);
  });

  it("reports the reason", () => {
    const onDiagnostic = vi.fn();
    safely(createDiagnostics(onDiagnostic), "capture_error", () => {
      throw new Error("specific message");
    });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "capture_error", reason: "specific message" })
    );
  });
});

describe("safelyAsync", () => {
  it("returns the resolved value", async () => {
    await expect(
      safelyAsync(createDiagnostics(), "transport_error", () => Promise.resolve(7))
    ).resolves.toBe(7);
  });

  it("swallows a rejection", async () => {
    // The reason this exists: `safely` returns the promise before it rejects, so
    // its try/catch never sees the failure.
    const diagnostics = createDiagnostics();
    await expect(
      safelyAsync(diagnostics, "transport_error", () => Promise.reject(new Error("boom")))
    ).resolves.toBeUndefined();
    expect(diagnostics.counters().transportErrors).toBe(1);
  });

  it("swallows a synchronous throw inside an async callback", async () => {
    const diagnostics = createDiagnostics();
    await expect(
      safelyAsync(diagnostics, "transport_error", () => {
        throw new Error("sync throw");
      })
    ).resolves.toBeUndefined();
    expect(diagnostics.counters().transportErrors).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./safely.js`.

- [ ] **Step 3: Implement**

```typescript
import type { DiagnosticKind, Diagnostics } from "./diagnostics.js";

/**
 * The single failure boundary. Every public entry point goes through it.
 *
 * ADR-007 requires that recorder failure never break the host application. A
 * try/catch per method would work until someone adds a method and forgets one;
 * one boundary cannot be forgotten.
 *
 * Returns undefined on failure. Callers treat that as "the recorder did not
 * manage it", which is always an acceptable outcome for telemetry.
 */
export function safely<T>(
  diagnostics: Diagnostics,
  kind: DiagnosticKind,
  operation: () => T
): T | undefined {
  try {
    return operation();
  } catch (error) {
    report(diagnostics, kind, error);
    return undefined;
  }
}

/**
 * The async half of the boundary.
 *
 * `safely` cannot guard an async callback: it returns the promise before the
 * rejection happens, so the try/catch never sees it. Any await-ing entry point
 * must use this instead.
 */
export async function safelyAsync<T>(
  diagnostics: Diagnostics,
  kind: DiagnosticKind,
  operation: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    report(diagnostics, kind, error);
    return undefined;
  }
}

function report(diagnostics: Diagnostics, kind: DiagnosticKind, error: unknown): void {
  diagnostics.report({
    kind,
    reason: error instanceof Error ? error.message : String(error),
    detail: error
  });
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add the single failure boundary"
```

---

## Task 4: Bounded queue

**Files:**
- Create: `packages/sdk-node/src/queue.ts`
- Test: `packages/sdk-node/src/queue.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it } from "vitest";
import { createDiagnostics } from "./diagnostics.js";
import { BoundedQueue } from "./queue.js";

describe("BoundedQueue", () => {
  it("holds items up to its capacity", () => {
    const queue = new BoundedQueue<number>(3, createDiagnostics());
    queue.push(1);
    queue.push(2);
    expect(queue.size()).toBe(2);
  });

  it("drops the oldest item when full", () => {
    // Phase 1b's ingestion creates a journey from whichever event arrives first,
    // so dropping the front orphans nothing, and recent events are the ones
    // still worth having after an outage.
    const queue = new BoundedQueue<number>(2, createDiagnostics());
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(queue.drain(10)).toEqual([2, 3]);
  });

  it("counts drops rather than dropping silently", () => {
    const diagnostics = createDiagnostics();
    const queue = new BoundedQueue<number>(1, diagnostics);
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(diagnostics.counters().dropped).toBe(2);
  });

  it("drains at most the requested count, oldest first", () => {
    const queue = new BoundedQueue<number>(10, createDiagnostics());
    for (const n of [1, 2, 3, 4]) queue.push(n);
    expect(queue.drain(2)).toEqual([1, 2]);
    expect(queue.drain(10)).toEqual([3, 4]);
  });

  it("returns an empty array when empty", () => {
    expect(new BoundedQueue<number>(5, createDiagnostics()).drain(3)).toEqual([]);
  });

  it("puts items back at the front when a flush fails", () => {
    // A failed batch must retain ordering, or a retry reorders the timeline.
    const queue = new BoundedQueue<number>(10, createDiagnostics());
    queue.push(3);
    queue.requeue([1, 2]);
    expect(queue.drain(10)).toEqual([1, 2, 3]);
  });

  it("drops oldest when a requeue exceeds capacity", () => {
    const diagnostics = createDiagnostics();
    const queue = new BoundedQueue<number>(2, diagnostics);
    queue.push(9);
    queue.requeue([1, 2, 3]);
    expect(queue.size()).toBe(2);
    expect(diagnostics.counters().dropped).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./queue.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Diagnostics } from "./diagnostics.js";

/**
 * A bounded FIFO that drops the oldest item when full.
 *
 * Dropping the front sounds destructive, but Phase 1b's ingestion creates a
 * journey from whichever event arrives first — it does not require the
 * `received` event specifically — so nothing is orphaned. On recovery from an
 * outage the recent events are the ones still worth having.
 *
 * Drops are counted. A silent drop turns a gap in a timeline into a mystery.
 */
export class BoundedQueue<T> {
  private items: T[] = [];

  public constructor(
    private readonly capacity: number,
    private readonly diagnostics: Diagnostics
  ) {}

  public push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  /** Return a failed batch to the front, preserving order. */
  public requeue(items: readonly T[]): void {
    this.items.unshift(...items);
    this.trim();
  }

  public drain(count: number): T[] {
    return this.items.splice(0, count);
  }

  public size(): number {
    return this.items.length;
  }

  private trim(): void {
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.diagnostics.report({ kind: "dropped", reason: "queue_full" });
    }
  }
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add bounded queue with counted drop-oldest"
```

---

## Task 5: Transport with retry and circuit breaker

**Files:**
- Create: `packages/sdk-node/src/transport.ts`
- Test: `packages/sdk-node/src/transport.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { createDiagnostics } from "./diagnostics.js";
import { Transport } from "./transport.js";

const envelope = { protocolVersion: "0.1" as const, event: { id: "evt_1" } };

function transport(send: (batch: unknown[]) => Promise<void>, overrides = {}) {
  const diagnostics = createDiagnostics();
  return {
    diagnostics,
    transport: new Transport(
      {
        send,
        maxAttempts: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        breakerThreshold: 3,
        breakerCooldownMs: 1000,
        ...overrides
      },
      diagnostics
    )
  };
}

describe("Transport", () => {
  it("sends a batch once when it succeeds", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { transport: t, diagnostics } = transport(send);
    await t.send([envelope]);
    expect(send).toHaveBeenCalledOnce();
    expect(diagnostics.counters().sent).toBe(1);
  });

  it("retries a failed send up to maxAttempts", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport: t } = transport(send);
    await expect(t.send([envelope])).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once it succeeds", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const { transport: t } = transport(send);
    await t.send([envelope]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("opens the breaker after consecutive failures and stops attempting", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport: t, diagnostics } = transport(send, { maxAttempts: 1 });

    for (let i = 0; i < 3; i += 1) {
      await expect(t.send([envelope])).rejects.toThrow();
    }
    expect(diagnostics.counters().breakerOpened).toBeGreaterThan(0);

    send.mockClear();
    await expect(t.send([envelope])).rejects.toThrow(/circuit open/i);
    // While open, no network attempt is made — the breaker exists to stop a
    // failing recorder consuming the host's sockets.
    expect(send).not.toHaveBeenCalled();
  });

  it("closes the breaker after the cooldown", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport: t } = transport(send, { maxAttempts: 1, breakerCooldownMs: 50 });

    for (let i = 0; i < 3; i += 1) {
      await expect(t.send([envelope])).rejects.toThrow();
    }

    send.mockClear();
    send.mockResolvedValue(undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await t.send([envelope]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("resets the failure count on success", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValue(undefined);
    const { transport: t, diagnostics } = transport(send, { maxAttempts: 1 });

    await expect(t.send([envelope])).rejects.toThrow();
    await expect(t.send([envelope])).rejects.toThrow();
    await t.send([envelope]);
    // Two failures then a success must not leave the breaker one away from open.
    expect(diagnostics.counters().breakerOpened).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./transport.js`.

- [ ] **Step 3: Implement**

```typescript
import type { Diagnostics } from "./diagnostics.js";

export interface TransportOptions {
  send: (batch: readonly unknown[]) => Promise<void>;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Retrying transport with a circuit breaker.
 *
 * Retries reuse the caller's batch unchanged, so the client-generated event IDs
 * make a duplicate delivery harmless under Phase 1b's idempotency.
 *
 * The clock, sleep, and jitter source are injectable so backoff and breaker
 * recovery are tested deterministically rather than with real waits.
 */
export class Transport {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  public constructor(
    private readonly options: TransportOptions,
    private readonly diagnostics: Diagnostics
  ) {}

  public async send(batch: readonly unknown[]): Promise<void> {
    const now = this.options.now ?? Date.now;

    if (this.openedAt !== null) {
      if (now() - this.openedAt < this.options.breakerCooldownMs) {
        throw new Error("Recorder transport circuit open.");
      }
      // Cooldown elapsed: try again, and let the outcome decide.
      this.openedAt = null;
      this.consecutiveFailures = 0;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        await this.options.send(batch);
        this.consecutiveFailures = 0;
        this.diagnostics.recordSent(batch.length);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxAttempts) await this.backoff(attempt);
      }
    }

    this.consecutiveFailures += 1;
    this.diagnostics.report({
      kind: "transport_error",
      reason: lastError instanceof Error ? lastError.message : String(lastError)
    });

    if (this.consecutiveFailures >= this.options.breakerThreshold) {
      this.openedAt = now();
      this.diagnostics.report({ kind: "breaker_open", reason: "consecutive failures" });
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async backoff(attempt: number): Promise<void> {
    const random = this.options.random ?? Math.random;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

    const capped = Math.min(this.options.baseBackoffMs * 2 ** (attempt - 1), this.options.maxBackoffMs);
    // Full jitter: without it, every client that failed together retries
    // together and the server sees the same thundering herd repeatedly.
    await sleep(Math.floor(random() * capped));
  }
}
```

- [ ] **Step 4: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add retrying transport with circuit breaker"
```

---

## Task 6: createRecorder and failure isolation

**Files:**
- Create: `packages/sdk-node/src/config.ts`, `packages/sdk-node/src/recorder.ts`
- Modify: `packages/sdk-node/src/index.ts`, `packages/sdk-node/package.json`
- Test: `packages/sdk-node/src/recorder.test.ts`, `packages/sdk-node/src/isolation.test.ts`

- [ ] **Step 1: Write the isolation test first**

This is the phase's deliverable. Every case asserts the host is unaffected.

```typescript
import { describe, expect, it } from "vitest";
import { createRecorder } from "./recorder.js";

const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "development"
};

function circular(): Record<string, unknown> {
  const value: Record<string, unknown> = { name: "x" };
  value["self"] = value;
  return value;
}

describe("failure isolation (ADR-007)", () => {
  it("does not throw when the endpoint refuses connections", async () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
    await recorder.shutdown({ timeoutMs: 100 });
  });

  it("does not throw on a circular payload", () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "transformed", name: "n", input: circular() });
    }).not.toThrow();
  });

  it("does not throw when the queue is full", () => {
    const recorder = createRecorder({ ...base, maxBufferedEvents: 2 });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      for (let i = 0; i < 50; i += 1) journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
    expect(recorder.diagnostics().dropped).toBeGreaterThan(0);
  });

  it("does not throw when the diagnostics callback throws", () => {
    const recorder = createRecorder({
      ...base,
      maxBufferedEvents: 1,
      onDiagnostic: () => {
        throw new Error("callback exploded");
      }
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    expect(() => {
      journey.record({ operation: "received", name: "n" });
      journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
  });

  it("does not throw on an invalid entity", () => {
    const recorder = createRecorder(base);
    expect(() => {
      recorder.startJourney({ entity: { type: "", id: "" } });
    }).not.toThrow();
  });

  it("shutdown always returns, even against a dead endpoint", async () => {
    const recorder = createRecorder(base);
    recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
      operation: "received",
      name: "n"
    });
    const diagnostics = await recorder.shutdown({ timeoutMs: 100 });
    expect(diagnostics).toBeDefined();
  });

  it("shutdown is idempotent", async () => {
    const recorder = createRecorder(base);
    await recorder.shutdown({ timeoutMs: 50 });
    await expect(recorder.shutdown({ timeoutMs: 50 })).resolves.toBeDefined();
  });

  it("ignores records after shutdown without throwing", async () => {
    const recorder = createRecorder(base);
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    await recorder.shutdown({ timeoutMs: 50 });
    expect(() => {
      journey.record({ operation: "received", name: "n" });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/sdk-node`
Expected: FAIL, cannot resolve `./recorder.js`.

- [ ] **Step 3: Implement config**

```typescript
import { DEFAULT_SECRET_PATHS } from "@flight-recorder/payload-security/redaction";
import type { Diagnostic } from "./diagnostics.js";

export interface RecorderConfig {
  endpoint: string;
  apiKey: string;
  serviceName: string;
  environment: string;
  captureMode?: "metadata-only" | "redacted-payload" | "full-payload";
  redact?: readonly string[];
  batchSize?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  maxBufferedEvents?: number;
  maxPayloadBytes?: number;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export interface ResolvedConfig extends Required<Omit<RecorderConfig, "onDiagnostic">> {
  onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined;
}

export function resolveConfig(config: RecorderConfig): ResolvedConfig {
  return {
    endpoint: config.endpoint.replace(/\/$/, ""),
    apiKey: config.apiKey,
    serviceName: config.serviceName,
    environment: config.environment,
    captureMode: config.captureMode ?? "redacted-payload",
    redact: [...(config.redact ?? []), ...DEFAULT_SECRET_PATHS],
    batchSize: config.batchSize ?? 20,
    flushIntervalMs: config.flushIntervalMs ?? 1_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 1_500,
    maxBufferedEvents: config.maxBufferedEvents ?? 1_000,
    maxPayloadBytes: config.maxPayloadBytes ?? 262_144,
    onDiagnostic: config.onDiagnostic
  };
}
```

- [ ] **Step 4: Implement the recorder**

```typescript
import { randomUUID } from "node:crypto";
import { DEFAULT_LIMITS, checkLimits, redact } from "@flight-recorder/payload-security/redaction";
import { resolveConfig, type RecorderConfig } from "./config.js";
import { createDiagnostics, type Counters } from "./diagnostics.js";
import { BoundedQueue } from "./queue.js";
import { safely, safelyAsync } from "./safely.js";
import { Transport } from "./transport.js";

export interface JourneyContext {
  journeyId: string;
  entity: { type: string; id: string };
}

export interface RecordInput {
  operation: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: { message: string; type?: string; code?: string };
  metadata?: Record<string, unknown>;
  durationMs?: number;
}

export interface Journey {
  context(): JourneyContext;
  record(input: RecordInput): void;
  identify(aliases: Record<string, string>): void;
}

export interface Recorder {
  startJourney(options: { entity: { type: string; id: string }; aliases?: Record<string, string> }): Journey;
  continueJourney(context: JourneyContext): Journey;
  flush(): Promise<void>;
  shutdown(options?: { timeoutMs?: number }): Promise<Counters>;
  diagnostics(): Counters;
}

const TOO_LARGE = "[PAYLOAD_TOO_LARGE]";

export function createRecorder(config: RecorderConfig): Recorder {
  const resolved = resolveConfig(config);
  const diagnostics = createDiagnostics(resolved.onDiagnostic);
  const queue = new BoundedQueue<unknown>(resolved.maxBufferedEvents, diagnostics);
  let stopped = false;

  const transport = new Transport(
    {
      send: async (batch) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, resolved.requestTimeoutMs);
        try {
          const response = await fetch(`${resolved.endpoint}/v1/events/batch`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${resolved.apiKey}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ events: batch }),
            signal: controller.signal
          });
          if (!response.ok) throw new Error(`Ingestion responded ${String(response.status)}.`);
        } finally {
          clearTimeout(timer);
        }
      },
      maxAttempts: 3,
      baseBackoffMs: 100,
      maxBackoffMs: 2_000,
      breakerThreshold: 5,
      breakerCooldownMs: 30_000
    },
    diagnostics
  );

  /**
   * Capture is synchronous: the application may mutate the object after this
   * returns, and recording values the step never saw would make the diff lie.
   * A size guard bounds the cost, because a server-side limit does not help a
   * host that already spent the CPU.
   */
  function capture(value: unknown): unknown {
    if (value === undefined) return undefined;
    if (resolved.captureMode === "metadata-only") return undefined;

    const limits = checkLimits(value, { ...DEFAULT_LIMITS, maxBytes: resolved.maxPayloadBytes });
    if (!limits.ok) return TOO_LARGE;

    return redact(value, resolved.redact);
  }

  function enqueue(journeyId: string, entity: JourneyContext["entity"], input: RecordInput): void {
    if (stopped) return;

    queue.push({
      protocolVersion: "0.1",
      event: {
        id: `evt_${randomUUID()}`,
        journeyId,
        environment: resolved.environment,
        service: resolved.serviceName,
        entity,
        operation: input.operation,
        name: input.name,
        timestamp: new Date().toISOString(),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.input === undefined ? {} : { input: capture(input.input) }),
        ...(input.output === undefined ? {} : { output: capture(input.output) }),
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata })
      }
    });

    if (queue.size() >= resolved.batchSize) void flush();
  }

  async function flush(): Promise<void> {
    const batch = queue.drain(resolved.batchSize);
    if (batch.length === 0) return;
    try {
      await transport.send(batch);
    } catch {
      // Ordering matters: a retried batch must not reorder the timeline.
      queue.requeue(batch);
    }
  }

  const interval = setInterval(() => void flush(), resolved.flushIntervalMs);
  interval.unref?.();

  function makeJourney(context: JourneyContext): Journey {
    return {
      context: () => context,
      record(input) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, input);
        });
      },
      identify(aliases) {
        safely(diagnostics, "capture_error", () => {
          enqueue(context.journeyId, context.entity, {
            operation: "identified",
            name: "identify",
            metadata: { aliases }
          });
        });
      }
    };
  }

  return {
    startJourney(options) {
      const context: JourneyContext =
        safely(diagnostics, "capture_error", () => ({
          journeyId: `jrn_${randomUUID()}`,
          entity: options.entity
        })) ?? { journeyId: `jrn_${randomUUID()}`, entity: { type: "unknown", id: "unknown" } };

      const journey = makeJourney(context);
      if (options.aliases !== undefined) journey.identify(options.aliases);
      return journey;
    },
    continueJourney: (context) => makeJourney(context),
    async flush() {
      await safelyAsync(diagnostics, "transport_error", flush);
    },
    async shutdown(options) {
      stopped = true;
      clearInterval(interval);
      const timeoutMs = options?.timeoutMs ?? 2_000;
      // Never hang: a process that cannot exit because of a telemetry library is
      // the same failure ADR-007 forbids, arriving later.
      await Promise.race([
        (async () => {
          try {
            await flush();
          } catch {
            // Shutdown reports; it does not fail.
          }
        })(),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
      return diagnostics.counters();
    },
    diagnostics: () => diagnostics.counters()
  };
}
```

- [ ] **Step 5: Wire the package**

`packages/sdk-node/src/index.ts`:

```typescript
export { createRecorder } from "./recorder.js";
export type { Journey, JourneyContext, Recorder, RecordInput } from "./recorder.js";
export type { RecorderConfig } from "./config.js";
export type { Diagnostic, Counters } from "./diagnostics.js";
```

Add `@flight-recorder/payload-security` as a dependency in
`packages/sdk-node/package.json`, and the `development` export condition if absent.

- [ ] **Step 6: Run, lint, commit**

```bash
pnpm vitest run packages/sdk-node && pnpm lint && pnpm typecheck
git add packages/sdk-node
git commit -m "feat(sdk-node): add createRecorder with structural failure isolation"
```

---

## Task 7: Verify Phase 3a

- [ ] **Step 1: Confirm events reach a real server**

Bring up the stack, seed an API key, and run a short script that records three events and
flushes. Confirm they appear through `GET /v1/journeys/:id/events`.

- [ ] **Step 2: Clean-clone pipeline**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q --branch phase-3a-sdk-core . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

- [ ] **Step 3: Merge, confirm CI, tag**

```bash
git checkout main && git merge --no-ff phase-3a-sdk-core
git push origin main
glab ci list --per-page 1
git tag -a phase-3a-complete -m "Phase 3a: SDK reliability core"
git push origin phase-3a-complete
```

---

## Definition of done

Every checkbox, Task 7 passing, CI green.

**Not in this phase:** the wrapper API and OpenTelemetry (3b), propagation (Phase 4),
and npm publishing (Phase 7).
