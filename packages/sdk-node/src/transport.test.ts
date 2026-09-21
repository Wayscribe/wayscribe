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
        return { accepted: outcome ?? batch.length, retry: [], noVerdict: 0 };
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

  it("says whether a send now would be refused by the open breaker", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const { transport, advance } = harness(send, { maxAttempts: 1 });

    expect(transport.isOpen()).toBe(false);
    for (let i = 0; i < 2; i += 1) {
      await expect(transport.send([envelope])).rejects.toThrow();
    }
    expect(transport.isOpen()).toBe(false);
    await expect(transport.send([envelope])).rejects.toThrow();
    expect(transport.isOpen()).toBe(true);

    // Asking changes nothing: the breaker is still open for a send.
    await expect(transport.send([envelope])).rejects.toThrow(/circuit open/i);

    advance(999);
    expect(transport.isOpen()).toBe(true);
    advance(2);
    // Past the cooldown a send would be attempted, so the breaker no longer
    // stands in its way, though only a send closes it.
    expect(transport.isOpen()).toBe(false);
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
          noVerdict: 0,
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
        return Promise.resolve({
          accepted: batch.length - retry.length,
          retry,
          noVerdict: 0,
          reason: "x"
        });
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

  it("counts later transport-only work toward the refused event's logical-send cap", async () => {
    const event = { protocolVersion: "0.1", event: { id: "b" } };
    const send = vi
      .fn<(batch: readonly unknown[]) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ accepted: 0, retry: [event], noVerdict: 0, reason: "x" })
      .mockRejectedValue(new Error("network"));
    const { transport, diagnostics } = harness(send, {
      maxAttempts: 2,
      maxRefusedSends: 2,
      breakerThreshold: 100
    });

    const first = await transport.send([event]).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(UnsentError);
    expect((first as UnsentError).unsent).toEqual([event]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(diagnostics.counters().droppedByCause.retry_budget).toBe(0);

    expect(await unsentAfter(transport.send((first as UnsentError).unsent))).toEqual([]);
    expect(send).toHaveBeenCalledTimes(4);
    expect(diagnostics.counters().droppedByCause.retry_budget).toBe(1);
  });

  it("drops an expired refused event after backoff without another HTTP attempt", async () => {
    const event = { protocolVersion: "0.1", event: { id: "b" } };
    let advance: (ms: number) => void = () => undefined;
    const send = vi.fn<(batch: readonly unknown[]) => Promise<SendOutcome>>().mockResolvedValue({
      accepted: 0,
      retry: [event],
      noVerdict: 0,
      reason: "x"
    });
    const harnessed = harness(send, {
      maxAttempts: 2,
      breakerThreshold: 1,
      sleep: () => {
        advance(30_000);
        return Promise.resolve();
      }
    });
    advance = harnessed.advance;

    await harnessed.transport.send([event]);

    expect(send).toHaveBeenCalledOnce();
    expect(harnessed.diagnostics.counters().droppedByCause.retry_budget).toBe(1);
    expect(harnessed.diagnostics.counters().breakerOpened).toBe(1);
  });

  it("leaves breaker state unchanged when an expired requeue makes no HTTP attempt", async () => {
    const refused = { protocolVersion: "0.1", event: { id: "b" } };
    const stored = { protocolVersion: "0.1", event: { id: "a" } };
    const send = vi
      .fn<(batch: readonly unknown[]) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ accepted: 1, retry: [refused], noVerdict: 0, reason: "x" })
      .mockResolvedValue({ accepted: 1, retry: [], noVerdict: 0 });
    const { transport, diagnostics, advance } = harness(send, {
      maxAttempts: 1,
      breakerThreshold: 1
    });

    const first = await transport.send([stored, refused]).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(UnsentError);
    expect(diagnostics.counters().breakerOpened).toBe(0);

    advance(30_000);
    send.mockClear();
    await transport.send((first as UnsentError).unsent);

    expect(send).not.toHaveBeenCalled();
    expect(diagnostics.counters().droppedByCause.retry_budget).toBe(1);
    expect(diagnostics.counters().breakerOpened).toBe(0);
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
        Promise.resolve({ accepted: 3, retry: batch.slice(1, 2), noVerdict: 0, reason: "x" })
      )
      .mockRejectedValue(new Error("network"));
    const { transport } = harness(send);

    expect(await unsentAfter(transport.send(events))).toEqual(["b"]);
  });
});

describe("a send the server gave no verdict for (F-048, ADR-063, SDK-65)", () => {
  /** A reply that is 2xx and says nothing about any event: a proxy's body. */
  const silent = (batch: readonly unknown[]): Promise<SendOutcome> =>
    Promise.resolve({ accepted: 0, retry: [], noVerdict: batch.length });

  it("counts toward the breaker, and opens it at the threshold without a transport error", async () => {
    const send = vi.fn(silent);
    const seen: Diagnostic[] = [];
    const { transport, diagnostics } = harness(send, {}, seen);

    for (let i = 0; i < 3; i += 1) await transport.send([{ ...envelope }]);

    expect(diagnostics.counters().breakerOpened).toBe(1);
    expect(seen.filter((d) => d.kind === "breaker_opened").map((d) => d.detail)).toEqual([
      { failures: 3, cooldownMs: 1_000 }
    ]);
    // Its events are already reported as dropped with no_verdict, by the sender.
    expect(seen.filter((d) => d.kind === "transport_error")).toEqual([]);

    send.mockClear();
    await expect(transport.send([{ ...envelope }])).rejects.toThrow(/circuit open/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("is not a failure when some verdicts came back, as today", async () => {
    // Two events, one verdict: a server speaking the protocol badly, not a
    // wrong collector. It resets the count.
    const partial = (batch: readonly unknown[]): Promise<SendOutcome> =>
      Promise.resolve({ accepted: 0, retry: [], noVerdict: batch.length - 1 });
    const send = vi
      .fn(silent)
      .mockImplementationOnce(silent)
      .mockImplementationOnce(silent)
      .mockImplementationOnce(partial);
    const { transport, diagnostics } = harness(send);

    await transport.send([{ ...envelope }]);
    await transport.send([{ ...envelope }]);
    await transport.send([{ ...envelope }, { ...envelope }]);
    await transport.send([{ ...envelope }]);
    await transport.send([{ ...envelope }]);
    // Two, reset, two: never three in a row.
    expect(diagnostics.counters().breakerOpened).toBe(0);
    await transport.send([{ ...envelope }]);
    expect(diagnostics.counters().breakerOpened).toBe(1);
  });

  it("is not a failure when an earlier attempt of the send got a verdict", async () => {
    const event = { ...envelope };
    const send = vi
      .fn<(batch: readonly unknown[]) => Promise<SendOutcome>>()
      .mockImplementation((batch) =>
        // Refused for now, then silent: the first attempt was answered.
        send.mock.calls.length % 2 === 1
          ? Promise.resolve({ accepted: 0, retry: [...batch], noVerdict: 0, reason: "x" })
          : silent(batch)
      );
    const { transport, diagnostics } = harness(send);
    for (let i = 0; i < 4; i += 1) await transport.send([{ ...event }]);
    expect(diagnostics.counters().breakerOpened).toBe(0);
  });

  it("is a failure when every attempt failed or was silent", async () => {
    const send = vi
      .fn<(batch: readonly unknown[]) => Promise<SendOutcome>>()
      .mockImplementation((batch) =>
        send.mock.calls.length % 2 === 1 ? Promise.reject(new Error("network")) : silent(batch)
      );
    const { transport, diagnostics } = harness(send);
    for (let i = 0; i < 3; i += 1) await transport.send([{ ...envelope }]);
    expect(diagnostics.counters().breakerOpened).toBe(1);
  });

  it("is reset by a send that stored something (SDK-32)", async () => {
    const send = vi
      .fn(silent)
      .mockImplementationOnce(silent)
      .mockImplementationOnce(silent)
      .mockImplementationOnce((batch) =>
        Promise.resolve({ accepted: 1, retry: [], noVerdict: batch.length - 1 })
      );
    const { transport, diagnostics } = harness(send);
    for (let i = 0; i < 5; i += 1) await transport.send([{ ...envelope }, { ...envelope }]);
    expect(diagnostics.counters().breakerOpened).toBe(0);
  });

  it("is neither counted nor a reset for an empty batch", async () => {
    const send = vi.fn(silent);
    const { transport, diagnostics } = harness(send);
    await transport.send([{ ...envelope }]);
    await transport.send([{ ...envelope }]);
    // Not a reset: the next silent send is still the third in a row.
    await transport.send([]);
    expect(diagnostics.counters().breakerOpened).toBe(0);
    await transport.send([{ ...envelope }]);
    expect(diagnostics.counters().breakerOpened).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not count empty batches toward the breaker", async () => {
    const send = vi.fn(silent);
    const { transport, diagnostics } = harness(send);
    for (let i = 0; i < 5; i += 1) await transport.send([]);
    expect(diagnostics.counters().breakerOpened).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves the count alone after a whole-request refusal (SDK-31)", async () => {
    const refused = Object.assign(new Error("Ingestion responded 400."), {
      permanent: true,
      httpStatus: 400
    });
    const send = vi
      .fn(silent)
      .mockImplementationOnce(silent)
      .mockImplementationOnce(silent)
      .mockImplementationOnce(() => Promise.reject(refused));
    const { transport, diagnostics } = harness(send);
    await transport.send([{ ...envelope }]);
    await transport.send([{ ...envelope }]);
    await transport.send([{ ...envelope }]);
    expect(diagnostics.counters().breakerOpened).toBe(0);
    // Not reset either: the next silent send is the third failure.
    await transport.send([{ ...envelope }]);
    expect(diagnostics.counters().breakerOpened).toBe(1);
  });
});
