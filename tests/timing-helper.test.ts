import { describe, expect, it } from "vitest";
import { compare, growth, processorNow, type Measure, type Side } from "./support/timing.js";

/** Busy work proportional to `units`, which the optimiser cannot remove. */
let sink = 0;
function spin(units: number): void {
  let total = 0;
  for (let index = 0; index < units; index += 1) total = (total + index * 31) % 1_000_003;
  sink += total;
}

const REFERENCE_MS = 10;

/**
 * A clock that reads a script instead of the processor: the reference side
 * always takes `REFERENCE_MS`, and each sample of the measured side takes
 * the next ratio in `ratios` times that. The first call for each side is its
 * calibration, which one reading of at least 3 ms settles. So the stopping
 * rule is tested on exact rounds, with nothing left to chance.
 */
function scripted(ratios: readonly number[]): {
  measured: Side;
  reference: Side;
  measure: Measure;
} {
  const measured: Side = { run: () => undefined, units: 1 };
  const reference: Side = { run: () => undefined, units: 1 };
  let calibrated = false;
  let next = 0;
  const measure: Measure = (side, count) => {
    if (side === reference) return REFERENCE_MS * count;
    if (!calibrated) {
      calibrated = true;
      return REFERENCE_MS * count;
    }
    const ratio = ratios[next % ratios.length] ?? Number.NaN;
    next += 1;
    return ratio * REFERENCE_MS * count;
  };
  return { measured, reference, measure };
}

function comparing(ratios: readonly number[]): ReturnType<typeof compare> {
  const { measured, reference, measure } = scripted(ratios);
  return compare(measured, reference, 2, 60_000, measure);
}

describe("the timing helper's stopping rule (tests/support/timing.ts)", () => {
  it("does not stop on single rounds just inside the limit, and reports the median", () => {
    // What let a true 2.2 pass a limit of 2 in 6 of 30 trials: the first
    // round within the limit ended the comparison.
    const result = comparing([2.6, 1.9]);
    expect(result.rounds).toBe(40);
    expect(result.ratio).toBeCloseTo(2.25);
  });

  it("does not let one fast round pass a comparison whose rounds mostly read over the limit", () => {
    // A CI runner read a true 2.6 as 1.92 when the verdict was the ratio of
    // the fastest samples, which one fast round decides.
    const result = comparing([2.6, 2.6, 2.6, 2.6, 1.5, ...Array<number>(35).fill(2.6)]);
    expect(result.rounds).toBe(40);
    expect(result.ratio).toBeCloseTo(2.6);
  });

  it("stops on two rounds in a row within the limit, reporting the higher", () => {
    const result = comparing([2.6, 2.6, 2.6, 1.9, 1.95, 2.6]);
    expect(result.rounds).toBe(5);
    expect(result.ratio).toBeCloseTo(1.95);
  });

  it("stops on one round within the limit divided by 1.5", () => {
    const result = comparing([2.6, 2.6, 1.2, 2.6]);
    expect(result.rounds).toBe(3);
    expect(result.ratio).toBeCloseTo(1.2);
  });

  it("does not stop before the third round", () => {
    const clear = comparing([1.2, 1.2, 1.2]);
    expect(clear.rounds).toBe(3);
    const early = comparing([1.2, ...Array<number>(39).fill(2.6)]);
    expect(early.rounds).toBe(40);
    expect(early.ratio).toBeCloseTo(2.6);
  });
});

describe("the timing helper on real work", () => {
  it("passes linear work and fails quadratic work", () => {
    // Linear reads about 1 and quadratic about 8 from 250 to 2,000, against a
    // limit of 2: far enough apart that no reading lands on the wrong side.
    const linear = growth(
      (n: number) => {
        spin(n * 200);
      },
      { input: 250, units: 250 },
      { input: 2_000, units: 2_000 },
      2
    );
    expect(linear.ratio).toBeLessThanOrEqual(2);

    const quadratic = growth(
      (n: number) => {
        spin(n * n);
      },
      { input: 250, units: 250 },
      { input: 2_000, units: 2_000 },
      2
    );
    expect(quadratic.ratio).toBeGreaterThan(2);
    expect(sink).toBeGreaterThan(0);
  }, 60_000);

  it("fails, rather than passes, when the work outruns the budget", () => {
    const started = processorNow();
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
    ).toThrow(/ran out of its budget of 500 ms of processor time/);
    // The budget and one run of the slow side past it, at most, in processor
    // time: the wall clock is the machine's load, not the helper's.
    expect(processorNow() - started).toBeLessThan(2_000);
  }, 60_000);
});
