import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE = new URL("./address-throttle.ts", import.meta.url).href;
/** More than any structure proportional to what is live could need here. */
const BOUND_MB = 10;

/**
 * Run `scenario` against the throttle in a fresh Node process with a real
 * `gc()`, and return how many MB of heap it left behind.
 *
 * A child process, because the measurement lies in-process: exposing the
 * collector with `v8.setFlagsFromString` from inside the test hid the very
 * retention this exists to catch (0.0 MB where `--expose-gc` measured 311 MB).
 * Node strips the module's types itself, which is why `address-throttle.ts`
 * imports nothing but `node:net` and uses no syntax TypeScript must transform.
 */
function heapLeftBehind(scenario: string): number {
  const program = `
    const { AuthThrottle, MAX_TRACKED_ADDRESSES } = await import(${JSON.stringify(MODULE)});
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

/**
 * The throttle's memory is proportional to the addresses it holds, however many
 * requests it answers.
 *
 * It was not. A Map iterator kept across evictions made V8 keep every hash
 * table the Map had rehashed into while the iterator lived, and every touch
 * deleted and re-inserted its key, so the Map rehashed constantly: one locked
 * address sending `Bearer wrong` 600,000 times took the running API from 27.7
 * MB of heap to 117.6 MB, where it stayed, and valid API-key reads leaked about
 * 176 bytes each.
 */
describe("the authentication throttle's memory", () => {
  it("stays bounded across 2,000,000 refused attempts from one locked address", () => {
    const grown = heapLeftBehind(`
      const throttle = new AuthThrottle();
      for (let i = 0; i < 5; i += 1) {
        throttle.admit("203.0.113.9", NOW);
        throttle.settle("203.0.113.9", NOW, true);
      }
      if (throttle.lockedFor("203.0.113.9", NOW) === 0) throw new Error("not locked");
      for (let i = 0; i < 2_000_000; i += 1) throttle.admit("203.0.113.9", NOW);
      return throttle;
    `);
    expect(grown, `${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
  }, 120_000);

  it("stays bounded across 2,000,000 verified reads from a few addresses", () => {
    const grown = heapLeftBehind(`
      const throttle = new AuthThrottle();
      for (let i = 0; i < 2_000_000; i += 1) {
        const address = "10.0.0." + (i % 3);
        if (!throttle.admit(address, NOW).ok) throw new Error("refused");
        throttle.settle(address, NOW, false);
      }
      return throttle;
    `);
    expect(grown, `${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
  }, 120_000);

  it("returns to its baseline after churn across 200,000 addresses", () => {
    const grown = heapLeftBehind(`
      const throttle = new AuthThrottle();
      for (let i = 0; i < 200_000; i += 1) {
        // Twenty thousand new addresses a minute, each failing once: the cap is
        // reached, and entries also age out.
        throttle.recordFailure("198.51." + (i >>> 8) + "." + (i & 0xff), NOW + i * 3);
        if (throttle.size > MAX_TRACKED_ADDRESSES) throw new Error("over the cap");
      }
      // Long after every failure and lock has expired, one more sweeps them out.
      throttle.recordFailure("late", NOW + 200_000 * 3 + 3_600_000);
      if (throttle.size !== 1) throw new Error("not swept: " + throttle.size);
      return throttle;
    `);
    expect(grown, `${grown.toFixed(1)} MB`).toBeLessThan(BOUND_MB);
  }, 120_000);
});
