import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { compare, growth } from "./support/timing.js";

/** Busy work proportional to `units`, which the optimiser cannot remove. */
let sink = 0;
function spin(units: number): void {
  let total = 0;
  for (let index = 0; index < units; index += 1) total = (total + index * 31) % 1_000_003;
  sink += total;
}

describe("the timing helper (tests/support/timing.ts)", () => {
  it("passes linear work and fails quadratic work", () => {
    const linear = growth(
      (n: number) => {
        spin(n * 200);
      },
      { input: 1_000, units: 1_000 },
      { input: 4_000, units: 4_000 },
      2
    );
    expect(linear.ratio).toBeLessThanOrEqual(2);

    const quadratic = growth(
      (n: number) => {
        spin(n * n);
      },
      { input: 500, units: 500 },
      { input: 2_000, units: 2_000 },
      2
    );
    expect(quadratic.ratio).toBeGreaterThan(2);
    expect(sink).toBeGreaterThan(0);
  });

  it("does not stop on a round just inside the limit when the true ratio is over it", () => {
    // 2.6 against a limit of 2: stopping at the first round within the limit
    // is what let a true 2.2 pass, 6 times in 30.
    for (let trial = 0; trial < 5; trial += 1) {
      const result = compare(
        {
          run: () => {
            spin(26_000);
          },
          units: 1
        },
        {
          run: () => {
            spin(10_000);
          },
          units: 1
        },
        2
      );
      expect(result.ratio, `trial ${String(trial)}`).toBeGreaterThan(2);
    }
  });

  it("fails, rather than passes, when the work outruns the budget", () => {
    const started = performance.now();
    expect(() =>
      compare(
        {
          run: () => {
            spin(20_000_000);
          },
          units: 1
        },
        {
          run: () => {
            spin(1_000);
          },
          units: 1
        },
        2,
        500
      )
    ).toThrow(/ran out of its 500 ms budget/);
    // One run of the slow side past the budget, at most.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
