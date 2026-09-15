import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { Transport, type SendOutcome } from "./transport.js";

const envelope = { protocolVersion: "0.1", event: { id: "evt_1" } };

/** A controllable clock, so breaker timing is deterministic rather than slept through. */
function harness(
  // Returns the accepted count. Existing cases resolve void, which TypeScript
  // will not accept, so they are adapted at the call site below rather than
  // rewritten — what they assert about retries and the breaker is unchanged.
  send: (batch: readonly unknown[]) => Promise<number | SendOutcome | undefined>,
  overrides: Record<string, unknown> = {}
): { transport: Transport; diagnostics: Diagnostics; advance: (ms: number) => void } {
  let currentTime = 1_000_000;
  const diagnostics = createDiagnostics();
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
    const { transport, diagnostics } = harness(send, { maxAttempts: 1 });

    for (let i = 0; i < 3; i += 1) {
      await expect(transport.send([envelope])).rejects.toThrow();
    }
    expect(diagnostics.counters().breakerOpened).toBeGreaterThan(0);

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

  it("gives up on an event after the attempt limit rather than holding the queue", async () => {
    const { send, batches } = refusing(["b"]);
    const seen: string[] = [];
    const diagnostics = createDiagnostics((d) => seen.push(`${d.kind}|${d.reason}`));
    const transport = new Transport(
      {
        send,
        maxAttempts: 3,
        baseBackoffMs: 10,
        maxBackoffMs: 100,
        breakerThreshold: 3,
        breakerCooldownMs: 1_000,
        sleep: () => Promise.resolve(),
        random: () => 0.5
      },
      diagnostics
    );

    // Resolves rather than rejecting: a rejection would requeue the event to
    // the front, and an event the server can never store would then lead every
    // batch for the life of the process.
    await expect(transport.send(events)).resolves.toBeUndefined();

    expect(batches).toEqual([["a", "b", "c", "d"], ["b"], ["b"]]);
    expect(diagnostics.counters()).toMatchObject({
      sent: 3,
      rejected: 0,
      transportErrors: 1,
      dropped: 1
    });
    expect(seen.join()).toContain("storage_error");
  });

  it("does not open the breaker over one event while the server stores the rest", async () => {
    const { send } = refusing(["b"]);
    const { transport, diagnostics } = harness(send);
    for (let i = 0; i < 10; i += 1) await transport.send(events);
    expect(diagnostics.counters().breakerOpened).toBe(0);
    expect(diagnostics.counters().sent).toBe(30);
  });

  it("counts toward the breaker when the server stores nothing", async () => {
    const { send } = refusing(["a", "b", "c", "d"]);
    const { transport, diagnostics } = harness(send, { maxAttempts: 1 });
    for (let i = 0; i < 3; i += 1) await transport.send(events.map((e) => ({ ...e })));
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

    const failure: unknown = await transport.send(events).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(idsOf((failure as { unsent: unknown[] }).unsent)).toEqual(["b"]);
  });

  it("keeps an event's refusals across sends, so a requeue does not reset its limit", async () => {
    let calls = 0;
    let refusals = 0;
    // By call: refuse b, lose the connection twice (so the send fails and b is
    // handed back for requeueing), then refuse b for as long as it is offered.
    const send = (batch: readonly unknown[]): Promise<SendOutcome> => {
      calls += 1;
      if (calls === 2 || calls === 3) return Promise.reject(new Error("network"));
      const retry = batch.filter((entry) => idsOf([entry])[0] === "b");
      refusals += retry.length;
      return Promise.resolve({ accepted: batch.length - retry.length, retry, reason: "x" });
    };
    const { transport, diagnostics } = harness(send);

    const failure: unknown = await transport.send(events).catch((error: unknown) => error);
    const unsent = (failure as { unsent: unknown[] }).unsent;
    expect(idsOf(unsent)).toEqual(["b"]);

    // The same object, as the queue hands it back: two more refusals reach the
    // limit of three, and the transport stops there.
    await transport.send(unsent);
    expect(refusals).toBe(3);
    expect(calls).toBe(5);
    expect(diagnostics.counters().dropped).toBe(1);
  });
});
