import { describe, expect, it } from "vitest";
import { LoginLimiter } from "./login-limiter.js";

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
