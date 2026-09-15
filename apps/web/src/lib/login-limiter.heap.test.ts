import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = new URL("./login-limiter.ts", import.meta.url).href;
/** More than any structure proportional to what is live could need here. */
const BOUND_MB = 10;

/**
 * Run `scenario` against the limiter in a fresh Node process with a real
 * `gc()`, and return how many MB of heap it left behind.
 *
 * A child process for the reason the API's throttle test gives
 * (`apps/api/src/auth-throttle.heap.test.ts`): exposing the collector from
 * inside the test hid the retention. `login-limiter.ts` imports nothing and
 * uses no syntax TypeScript must transform, so Node strips its types itself.
 */
function heapLeftBehind(scenario: string): number {
  const program = `
    const { LoginLimiter, MAX_TRACKED_ADDRESSES } = await import(${JSON.stringify(MODULE)});
    const NOW = 1_800_000_000_000;
    const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
    const before = heap();
    // Held on a global, so what the scenario built is still reachable when the
    // heap is read: the measurement is of what it keeps, not what it dropped.
    globalThis.keptAlive = await (async () => { ${scenario} })();
    const after = heap();
    const kept = globalThis.keptAlive;
    console.log(JSON.stringify({ grownMb: (after - before) / 1e6, held: kept?.size ?? null }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--expose-gc", "--no-warnings", "--input-type=module", "-e", program],
    { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" }
  );
  const { grownMb } = JSON.parse(output.trim().split("\n").pop() ?? "{}") as { grownMb: number };
  return grownMb;
}

describe("the login limiter's memory", () => {
  it("stays bounded across 2,000,000 failures from one address", () => {
    const grown = heapLeftBehind(`
      const limiter = new LoginLimiter();
      for (let i = 0; i < 2_000_000; i += 1) limiter.recordFailure("203.0.113.9", NOW);
      if (!limiter.isLocked("203.0.113.9", NOW)) throw new Error("not locked");
      return limiter;
    `);
    expect(grown, `${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
  }, 120_000);

  it("stays bounded across 1,000,000 sign-ins, each after a mistyped token, from a few addresses", () => {
    const grown = heapLeftBehind(`
      const limiter = new LoginLimiter();
      for (let i = 0; i < 1_000_000; i += 1) {
        const address = "10.0.0." + (i % 3);
        limiter.recordFailure(address, NOW);
        limiter.recordSuccess(address);
      }
      return limiter;
    `);
    expect(grown, `${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
  }, 120_000);

  it("returns to its baseline after churn across 200,000 addresses", () => {
    const grown = heapLeftBehind(`
      const limiter = new LoginLimiter();
      for (let i = 0; i < 200_000; i += 1) {
        limiter.recordFailure("198.51." + (i >>> 8) + "." + (i & 0xff), NOW + i * 3);
        if (limiter.size > MAX_TRACKED_ADDRESSES) throw new Error("over the cap");
      }
      limiter.recordFailure("late", NOW + 200_000 * 3 + 3_600_000);
      if (limiter.size !== 1) throw new Error("not swept: " + limiter.size);
      return limiter;
    `);
    expect(grown, `${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
  }, 120_000);
});
