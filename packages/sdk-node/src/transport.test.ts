import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, type Diagnostic, type Diagnostics } from "./diagnostics.js";
import { Transport, UnsentError, type SendOutcome } from "./transport.js";

const envelope = { protocolVersion: "0.1", event: { id: "evt_1" } };

/** A controllable clock, so breaker timing is deterministic rather than slept through. */
function harness(
  // Returns the accepted count. Existing cases resolve void, which TypeScript
  // will not accept, so they are adapted at the call site below rather than
  // rewritten — what they assert about retries and the breaker is unchanged.
  send: (batch: readonly unknown[]) => Promise<number | SendOutcome | undefined>,
  overrides: Record<string, unknown> = {},
  seen: Diagnostic[] = []
): { transport: Transport; diagnostics: Diagnostics; advance: (ms: number) => void } {
  let currentTime = 1_000_000;
  const diagnostics = createDiagnostics((d) => seen.push(d));
  const transport = new Transport(
    {
      send: async (batch) => {
        const outcome = await send(batch);
        if (typeof outcome === "object") return outcome;
        return { accepted: outcome ?? batch.length, retry: [] };
      },
      maxAttempts: 3,
      baseBackoffMs: 10,
      maxBackoffMs: 100,
      breakerThreshold: 3,
      breakerCooldownMs: 1_000,
      retryBudgetMs: 30_000,
      maxRefusedSends: 10,
      now: () => currentTime,
      sleep: () => Promise.resolve(),
      random: () => 0.5,
      ...overrides
    },
    diagnostics
  );
  return {
    transport,
    diagnostics,
    advance: (ms) => {
      currentTime += ms;
    }
  };
}

describe("Transport", () => {
  it("sends a batch once when it succeeds", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { transport, diagnostics } = harness(send);
    await transport.send([envelope]);
    expect(send).toHaveBeenCalledOnce();
    expect(diagnostics.counters().sent).toBe(1);
  });

  it("retries a failed send up to maxAttempts", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport } = harness(send);
    await expect(transport.send([envelope])).rejects.toThrow("network");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once it succeeds", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(undefined);
    const { transport } = harness(send);
    await transport.send([envelope]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("opens the breaker after consecutive failures and stops attempting", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const seen: Diagnostic[] = [];
    const { transport, diagnostics } = harness(send, { maxAttempts: 1 }, seen);

    for (let i = 0; i < 3; i += 1) {
      await expect(transport.send([envelope])).rejects.toThrow();
    }
    expect(diagnostics.counters().breakerOpened).toBe(1);
    expect(seen.filter((d) => d.kind === "breaker_opened")).toEqual([
      {
        kind: "breaker_opened",
        code: "consecutive_failures",
        reason: "3 sends failed in a row, so sending pauses for 1 seconds.",
        detail: { failures: 3, cooldownMs: 1_000 }
      }
    ]);
    expect(seen.filter((d) => d.kind === "transport_error").map((d) => d.code)).toEqual([
      "request_failed",
      "request_failed",
      "request_failed"
    ]);

    send.mockClear();
    await expect(transport.send([envelope])).rejects.toThrow(/circuit open/i);
    // While open, no network attempt is made: the breaker exists to stop a
    // failing recorder consuming the host's sockets.
    expect(send).not.toHaveBeenCalled();
  });

  it("closes the breaker after the cooldown", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport, advance } = harness(send, { maxAttempts: 1 });

    for (let i = 0; i < 3; i += 1) {
      await expect(transport.send([envelope])).rejects.toThrow();
    }

    advance(1_001);
    send.mockClear();
    send.mockResolvedValue(undefined);
    await transport.send([envelope]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("resets the failure count on success", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockResolvedValue(undefined);
    const { transport, diagnostics } = harness(send, { maxAttempts: 1 });

    await expect(transport.send([envelope])).rejects.toThrow();
    await expect(transport.send([envelope])).rejects.toThrow();
    await transport.send([envelope]);
    // Two failures then a success must not leave the breaker one away from open.
    expect(diagnostics.counters().breakerOpened).toBe(0);
  });

  it("caps backoff rather than growing without bound", async () => {
    const delays: number[] = [];
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport } = harness(send, {
      maxAttempts: 6,
      baseBackoffMs: 10,
      maxBackoffMs: 40,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      }
    });

    await expect(transport.send([envelope])).rejects.toThrow();
    expect(Math.max(...delays)).toBeLessThanOrEqual(40);
  });
});

describe("Transport, when the server refuses some events for now", () => {
  const events = ["a", "b", "c", "d"].map((id) => ({ protocolVersion: "0.1", event: { id } }));
  const idsOf = (batch: readonly unknown[]): string[] =>
    batch.map((entry) => (entry as { event: { id: string } }).event.id);

  /** Refuses the named events with a 5xx on every attempt; stores the rest. */
  function refusing(ids: readonly string[]): {
    send: (batch: readonly unknown[]) => Promise<SendOutcome>;
    batches: string[][];
  } {
    const batches: string[][] = [];
    return {
      batches,
      send: (batch) => {
        batches.push(idsOf(batch));
        const retry = batch.filter((entry) => ids.includes(idsOf([entry])[0] ?? ""));
        return Promise.resolve({
          accepted: batch.length - retry.length,
          retry,
          reason: "storage_error: The event could not be stored."
        });
      }
    };
  }

  /** What a send threw for requeueing, or nothing if it resolved. */
  async function unsentAfter(send: Promise<void>): Promise<string[]> {
    const failure: unknown = await send.then(
      () => undefined,
      (error: unknown) => error
    );
    if (failure === undefined) return [];
    expect(failure).toBeInstanceOf(UnsentError);
    return idsOf((failure as UnsentError).unsent);
  }

  it("resends only the refused events, after a backoff, until they are stored", async () => {
    let refuseB = 2;
    const batches: string[][] = [];
    const delays: number[] = [];
    const { transport, diagnostics } = harness(
      (batch) => {
        batches.push(idsOf(batch));
        const retry = refuseB > 0 ? batch.filter((entry) => idsOf([entry])[0] === "b") : [];
        refuseB -= 1;
        return Promise.resolve({ accepted: batch.length - retry.length, retry, reason: "x" });
      },
      {
        sleep: (ms: number) => {
          delays.push(ms);
          return Promise.resolve();
        }
      }
    );

    await transport.send(events);

    // Resending the stored ones would count them as sent twice.
    expect(batches).toEqual([["a", "b", "c", "d"], ["b"], ["b"]]);
    expect(delays).toHaveLength(2);
    expect(diagnostics.counters()).toMatchObject({
      sent: 4,
      rejected: 0,
      transportErrors: 0,
      dropped: 0
    });
  });

  it("hands a refused event back for requeueing once its attempts in a send run out", async () => {
    // Three refusals inside about 300 ms of backoff said nothing about a
    // database restart that takes seconds, and used to drop the event.
    const { send, batches } = refusing(["b"]);
    const { transport, diagnostics } = harness(send);

    expect(await unsentAfter(transport.send(events))).toEqual(["b"]);
    expect(batches).toEqual([["a", "b", "c", "d"], ["b"], ["b"]]);
    expect(diagnostics.counters()).toMatchObject({ sent: 3, transportErrors: 1, dropped: 0 });
  });

  it("drops an event once it has been refused for thirty seconds", async () => {
    const { send } = refusing(["b"]);
    const seen: string[] = [];
    let now = 1_000_000;
    const diagnostics = createDiagnostics((d) => seen.push(`${d.kind}|${d.code}|${d.reason}`));
    const transport = new Transport(
      {
        send,
        maxAttempts: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        breakerThreshold: 1_000,
        breakerCooldownMs: 30_000,
        retryBudgetMs: 30_000,
        maxRefusedSends: 10,
        now: () => now,
        sleep: () => Promise.resolve(),
        random: () => 0.5
      },
      diagnostics
    );

    // A send every five seconds, so the time bound and not the send cap is
    // what decides: the seventh send is thirty seconds after the first refusal.
    let offered: readonly unknown[] = events.slice(1, 2);
    for (let send = 1; send <= 6; send += 1) {
      const failure: unknown = await transport.send(offered).catch((error: unknown) => error);
      offered = (failure as UnsentError).unsent;
      expect(idsOf(offered)).toEqual(["b"]);
      now += 5_000;
    }
    expect(diagnostics.counters().dropped).toBe(0);

    expect(await unsentAfter(transport.send(offered))).toEqual([]);
    expect(diagnostics.counters().dropped).toBe(1);
    expect(seen.join()).toContain("storage_error");
    const codes = seen.map((line) => line.split("|").slice(0, 2).join("|"));
    expect(new Set(codes)).toEqual(
      new Set(["transport_error|refused_for_now", "dropped|retry_budget"])
    );
  });

  it("drops an event refused in ten sends, even inside thirty seconds", async () => {
    const { send, batches } = refusing(["b"]);
    const { transport, diagnostics, advance } = harness(send);

    let offered: readonly unknown[] = events.slice(1, 2);
    for (let send = 1; send <= 9; send += 1) {
      offered = ((await transport.send(offered).catch((error: unknown) => error)) as UnsentError)
        .unsent;
      advance(1_000);
    }
    expect(diagnostics.counters().dropped).toBe(0);
    expect(await unsentAfter(transport.send(offered))).toEqual([]);
    expect(diagnostics.counters().dropped).toBe(1);
    // Ten sends of three attempts each, and not one more.
    expect(batches).toHaveLength(30);
  });

  it("does not open the breaker over one event while the server stores the rest", async () => {
    const { send } = refusing(["b"]);
    const { transport, diagnostics } = harness(send);
    for (let i = 0; i < 12; i += 1) {
      await transport.send(events).catch(() => undefined);
    }
    expect(diagnostics.counters().breakerOpened).toBe(0);
    expect(diagnostics.counters().sent).toBe(36);
  });

  it("counts toward the breaker when the server stores nothing", async () => {
    const { send } = refusing(["a", "b", "c", "d"]);
    const { transport, diagnostics } = harness(send, { maxAttempts: 1 });
    for (let i = 0; i < 3; i += 1) {
      await transport.send(events.map((e) => ({ ...e }))).catch(() => undefined);
    }
    expect(diagnostics.counters().breakerOpened).toBe(1);
  });

  it("hands back only the unsent events when the connection fails part way", async () => {
    const send = vi
      .fn<(batch: readonly unknown[]) => Promise<SendOutcome>>()
      .mockImplementationOnce((batch) =>
        Promise.resolve({ accepted: 3, retry: batch.slice(1, 2), reason: "x" })
      )
      .mockRejectedValue(new Error("network"));
    const { transport } = harness(send);

    expect(await unsentAfter(transport.send(events))).toEqual(["b"]);
  });
});
