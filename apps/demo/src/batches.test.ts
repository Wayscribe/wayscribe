import { describe, expect, it } from "vitest";
import { backfillWindowProblem, inBatches } from "./batches.js";

describe("inBatches", () => {
  it("splits into batches of at most the size, keeping order", () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("backfillWindowProblem", () => {
  it("refuses a window retention would sweep before the next nightly reset", () => {
    expect(backfillWindowProblem(5, 7)).toBeNull();
    expect(backfillWindowProblem(6, 7)).toMatch(/DEMO_HISTORY_DAYS/);
    expect(backfillWindowProblem(7, 7)).toMatch(/DEMO_HISTORY_DAYS/);
  });
});
