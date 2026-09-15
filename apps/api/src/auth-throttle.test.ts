import { describe, expect, it } from "vitest";
import { AuthThrottle, clientAddress } from "./auth-throttle.js";

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

  it("does not grow without bound as addresses come and go", () => {
    const throttle = new AuthThrottle(options);
    for (let i = 0; i < 25_000; i += 1) {
      // Each address fails once, a window apart from the batch before it.
      throttle.recordFailure(`addr-${String(i)}`, NOW + Math.floor(i / 1000) * 61_000);
    }
    expect(throttle.size).toBeLessThanOrEqual(11_000);
  });
});
