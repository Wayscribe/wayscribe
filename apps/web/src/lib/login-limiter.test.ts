import { describe, expect, it } from "vitest";
import { LoginLimiter, MAX_TRACKED_ADDRESSES } from "./login-limiter";

const options = { maxFailures: 3, windowMs: 60_000, cooldownMs: 300_000 };
const NOW = 1_800_000_000_000;

describe("LoginLimiter", () => {
  it("allows attempts below the threshold", () => {
    const limiter = new LoginLimiter(options);
    limiter.recordFailure("ip", NOW);
    limiter.recordFailure("ip", NOW);
    expect(limiter.isLocked("ip", NOW)).toBe(false);
  });

  it("locks once the threshold is reached", () => {
    const limiter = new LoginLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("ip", NOW);
    expect(limiter.isLocked("ip", NOW)).toBe(true);
  });

  it("recovers after the cooldown", () => {
    const limiter = new LoginLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("ip", NOW);
    expect(limiter.isLocked("ip", NOW + options.cooldownMs + 1)).toBe(false);
  });

  it("forgets failures that fall outside the window", () => {
    const limiter = new LoginLimiter(options);
    limiter.recordFailure("ip", NOW);
    limiter.recordFailure("ip", NOW);
    // Third failure arrives after the first two have aged out.
    limiter.recordFailure("ip", NOW + options.windowMs + 1);
    expect(limiter.isLocked("ip", NOW + options.windowMs + 1)).toBe(false);
  });

  it("clears the record on success", () => {
    const limiter = new LoginLimiter(options);
    limiter.recordFailure("ip", NOW);
    limiter.recordFailure("ip", NOW);
    limiter.recordSuccess("ip");
    limiter.recordFailure("ip", NOW);
    expect(limiter.isLocked("ip", NOW)).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new LoginLimiter(options);
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("attacker", NOW);
    expect(limiter.isLocked("attacker", NOW)).toBe(true);
    expect(limiter.isLocked("operator", NOW)).toBe(false);
  });
});

describe("LoginLimiter under many addresses", () => {
  const address = (i: number): string =>
    `2001:db8:${(i >>> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`;

  it("never holds more than its cap, even with every address inside the window", () => {
    // It held every address it had ever seen: a million used 325 MB.
    const limiter = new LoginLimiter(options);
    let largest = 0;
    for (let i = 0; i < 200_000; i += 1) {
      limiter.recordFailure(address(i), NOW + Math.floor(i / 10));
      largest = Math.max(largest, limiter.size);
    }
    expect(largest).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
  });

  it("evicts the least recently seen address first", () => {
    const limiter = new LoginLimiter(options, 3);
    limiter.recordFailure("old", NOW);
    limiter.recordFailure("kept", NOW);
    limiter.recordFailure("newer", NOW);
    limiter.recordFailure("old", NOW + 1);
    limiter.recordFailure("newest", NOW + 2);
    expect(limiter.has("kept")).toBe(false);
    expect(limiter.has("old")).toBe(true);
    expect(limiter.size).toBe(3);
  });

  it("takes flat time per failure as addresses accumulate", () => {
    // Eviction once walked a fresh `keys()` iterator over the deleted slots,
    // so it slowed the more it evicted, and a sweep on every failure would
    // cost the same at the cap. The same number of failures, each from a new
    // address and each evicting the oldest, is timed on a LoginLimiter holding 1,000 addresses
    // and on one holding the cap. Work proportional to the addresses held makes
    // the second about fifty times slower; constant work keeps them close.
    //
    // Timing consecutive batches of one run compared two wall-clock samples, so
    // one batch slowed by an unrelated process failed the test. The fastest of
    // several runs of each is the least noisy estimate of the work, and a
    // difference under the noise floor is not complexity.
    const SMALL = 1_000;
    const CALLS = 5_000;
    const RUNS = 5;
    const RATIO = 5;
    const NOISE_FLOOR_MS = 2;
    let next = 0;
    const filled = (held: number): LoginLimiter => {
      const limiter = new LoginLimiter(options, held);
      for (let n = 0; n < held; n += 1, next += 1) limiter.recordFailure(address(next), NOW);
      return limiter;
    };
    const timed = (limiter: LoginLimiter): number => {
      const started = performance.now();
      for (let n = 0; n < CALLS; n += 1, next += 1) limiter.recordFailure(address(next), NOW);
      return performance.now() - started;
    };
    const small = filled(SMALL);
    const large = filled(MAX_TRACKED_ADDRESSES);
    let fastestSmall = Number.POSITIVE_INFINITY;
    let fastestLarge = Number.POSITIVE_INFINITY;
    for (let run = 0; run < RUNS; run += 1) {
      fastestSmall = Math.min(fastestSmall, timed(small));
      fastestLarge = Math.min(fastestLarge, timed(large));
    }
    expect(small.size).toBe(SMALL);
    expect(large.size).toBe(MAX_TRACKED_ADDRESSES);
    expect(
      fastestLarge,
      `${fastestSmall.toFixed(2)} ms at ${String(SMALL)}, ${fastestLarge.toFixed(2)} ms at the cap`
    ).toBeLessThan(Math.max(fastestSmall, NOISE_FLOOR_MS) * RATIO);
  }, 60_000);

  it("forgets addresses whose failures and locks have expired", () => {
    const limiter = new LoginLimiter(options);
    for (let i = 0; i < 1_000; i += 1) limiter.recordFailure(address(i), NOW);
    limiter.recordFailure("late", NOW + options.cooldownMs + options.windowMs + 1);
    expect(limiter.size).toBe(1);
  });
});
