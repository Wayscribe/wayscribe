import { describe, expect, it, vi } from "vitest";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { Transport } from "./transport.js";

const envelope = { protocolVersion: "0.1", event: { id: "evt_1" } };

/** A controllable clock, so breaker timing is deterministic rather than slept through. */
function harness(
  // Returns the accepted count. Existing cases resolve void, which TypeScript
  // will not accept, so they are adapted at the call site below rather than
  // rewritten — what they assert about retries and the breaker is unchanged.
  send: (batch: readonly unknown[]) => Promise<number | undefined>,
  overrides: Record<string, unknown> = {}
): { transport: Transport; diagnostics: Diagnostics; advance: (ms: number) => void } {
  let currentTime = 1_000_000;
  const diagnostics = createDiagnostics();
  const transport = new Transport(
    {
      send: async (batch) => (await send(batch)) ?? batch.length,
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
