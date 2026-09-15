import { describe, expect, it } from "vitest";
import { AuthThrottle, MAX_TRACKED_ADDRESSES, clientAddress } from "./auth-throttle.js";

const NOW = 1_800_000_000_000;
const options = { maxFailures: 3, windowMs: 60_000, cooldownMs: 300_000 };

describe("clientAddress", () => {
  it("is the socket's address when no proxy is trusted, whatever the header says", () => {
    expect(clientAddress("203.0.113.1", "198.51.100.9", 0)).toBe("203.0.113.1");
    expect(clientAddress("203.0.113.1", undefined, 0)).toBe("203.0.113.1");
  });

  it("takes the entry that many hops from the right", () => {
    expect(clientAddress("10.0.0.5", "spoofed, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientAddress("10.0.0.6", "spoofed, 198.51.100.7, 10.0.0.5", 2)).toBe("198.51.100.7");
    // A repeated header arrives as an array; it is one list.
    expect(clientAddress("10.0.0.5", ["spoofed", "198.51.100.7"], 1)).toBe("198.51.100.7");
  });

  it("falls back to the socket when the header is shorter than the count", () => {
    expect(clientAddress("10.0.0.5", "198.51.100.7", 2)).toBe("10.0.0.5");
    expect(clientAddress("10.0.0.5", " , ", 1)).toBe("10.0.0.5");
    expect(clientAddress("10.0.0.5", undefined, 1)).toBe("10.0.0.5");
  });

  it("keys an IPv6 address on its /64, so one subnet's addresses share a bucket", () => {
    // A single IPv6 host is routinely given a /64: 2^64 addresses, each of
    // which would otherwise be a fresh budget of guesses.
    const forms = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0db8:0001:0002:0000:0000:0000:0009",
      "2001:DB8:1:2::abcd"
    ];
    const keys = new Set(forms.map((address) => clientAddress(address, undefined, 0)));
    expect([...keys]).toEqual(["2001:db8:1:2::/64"]);
    // Through a trusted proxy too.
    expect(clientAddress("10.0.0.5", "2001:db8:1:2::77", 1)).toBe("2001:db8:1:2::/64");

    expect(clientAddress("2001:db8:1:3::1", undefined, 0)).not.toBe("2001:db8:1:2::/64");
    expect(clientAddress("::1", undefined, 0)).toBe("0:0:0:0::/64");
  });

  it("reads an IPv4-mapped IPv6 address as the IPv4 address it is", () => {
    expect(clientAddress("::ffff:203.0.113.5", undefined, 0)).toBe("203.0.113.5");
  });
});

describe("AuthThrottle", () => {
  it("locks at the limit and releases after the cooldown", () => {
    const throttle = new AuthThrottle(options);
    throttle.recordFailure("a", NOW);
    throttle.recordFailure("a", NOW);
    expect(throttle.lockedFor("a", NOW)).toBe(0);
    throttle.recordFailure("a", NOW);
    expect(throttle.lockedFor("a", NOW)).toBe(options.cooldownMs);
    expect(throttle.lockedFor("b", NOW)).toBe(0);
    expect(throttle.lockedFor("a", NOW + options.cooldownMs)).toBe(0);
  });

  it("forgets failures outside the window", () => {
    const throttle = new AuthThrottle(options);
    throttle.recordFailure("a", NOW);
    throttle.recordFailure("a", NOW);
    throttle.recordFailure("a", NOW + options.windowMs + 1);
    expect(throttle.lockedFor("a", NOW + options.windowMs + 1)).toBe(0);
  });

  describe("admitting attempts before they are verified", () => {
    it("admits no more unverified attempts than failures remain, however many arrive at once", () => {
      // Verification awaits the database, so failures counted only when they
      // came back let hundreds of concurrent guesses through before the first
      // was recorded.
      const throttle = new AuthThrottle(options);
      const admitted = Array.from({ length: 50 }, () => throttle.admit("a", NOW)).filter(
        (result) => result.ok
      );
      expect(admitted).toHaveLength(options.maxFailures);

      for (let i = 0; i < options.maxFailures; i += 1) throttle.settle("a", NOW, true);
      expect(throttle.lockedFor("a", NOW)).toBe(options.cooldownMs);
      expect(throttle.admit("a", NOW).ok).toBe(false);
    });

    it("gives back a slot when the attempt succeeds, and counts nothing for it", () => {
      const throttle = new AuthThrottle(options);
      for (let round = 0; round < 20; round += 1) {
        expect(throttle.admit("a", NOW).ok).toBe(true);
        throttle.settle("a", NOW, false);
      }
      expect(throttle.lockedFor("a", NOW)).toBe(0);
    });

    it("counts earlier failures against what it admits", () => {
      const throttle = new AuthThrottle(options);
      throttle.recordFailure("a", NOW);
      throttle.recordFailure("a", NOW);
      expect(throttle.admit("a", NOW).ok).toBe(true);
      const refused = throttle.admit("a", NOW);
      expect(refused.ok).toBe(false);
      expect(refused.ok ? 0 : refused.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe("under many addresses", () => {
    const address = (i: number): string =>
      `2001:db8:${(i >>> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`;

    it("never holds more than its cap, even with every address inside the window", () => {
      const throttle = new AuthThrottle(options);
      let largest = 0;
      for (let i = 0; i < 200_000; i += 1) {
        throttle.recordFailure(address(i), NOW + Math.floor(i / 10));
        largest = Math.max(largest, throttle.size);
      }
      expect(largest).toBeLessThanOrEqual(MAX_TRACKED_ADDRESSES);
    });

    it("evicts the least recently seen address first", () => {
      const throttle = new AuthThrottle(options, 3);
      throttle.recordFailure("old", NOW);
      throttle.recordFailure("kept", NOW);
      throttle.recordFailure("newer", NOW);
      throttle.recordFailure("old", NOW + 1);
      throttle.recordFailure("newest", NOW + 2);
      expect(throttle.has("kept")).toBe(false);
      expect(throttle.has("old")).toBe(true);
      expect(throttle.size).toBe(3);
    });

    it("takes flat time per failure as addresses accumulate", () => {
      // The previous version swept every entry on every failure once 10,000
      // were held: 1.4 ms per 401 at 100,000 addresses, on the process that
      // also ingests. Timed in consecutive batches over 200,000 distinct
      // addresses inside one window; linear work per call would make the last
      // batch many times slower than the first.
      const throttle = new AuthThrottle(options);
      const BATCH = 40_000;
      const batches: number[] = [];
      let i = 0;
      for (let batch = 0; batch < 5; batch += 1) {
        const started = performance.now();
        for (let n = 0; n < BATCH; n += 1, i += 1) {
          throttle.recordFailure(address(i), NOW + Math.floor(i / 10));
        }
        batches.push(performance.now() - started);
      }
      const first = Math.max(batches[0] ?? 0, 5);
      const last = batches[batches.length - 1] ?? 0;
      expect(last, batches.map((ms) => ms.toFixed(1)).join(", ")).toBeLessThan(first * 4);
    });

    it("forgets addresses whose failures and locks have expired", () => {
      const throttle = new AuthThrottle(options);
      for (let i = 0; i < 1_000; i += 1) throttle.recordFailure(address(i), NOW);
      // A window and a cooldown later, one more failure sweeps the rest out.
      throttle.recordFailure("late", NOW + options.cooldownMs + options.windowMs + 1);
      expect(throttle.size).toBe(1);
    });
  });
});
