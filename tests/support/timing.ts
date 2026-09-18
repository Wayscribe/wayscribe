import { performance } from "node:perf_hooks";
import process from "node:process";

/**
 * Timing comparisons that a busy machine cannot fail.
 *
 * A unit test that holds a complexity bound has to time something, and a
 * wall-clock sample on a shared machine is the work plus whatever else the
 * machine did meanwhile. Three things kept these comparisons failing on a
 * loaded laptop (load average 16 to 22) and not on a quiet one:
 *
 * - the two sides were timed one after the other, so a process that moved to
 *   a slower core, or a burst of other work, landed on one side only;
 * - a side that took under a millisecond was mostly timer and scheduler noise,
 *   which an absolute "noise floor" in milliseconds then had to cover, and a
 *   floor is exactly what a loaded runner exceeds;
 * - a fixed, small number of samples, so one unlucky stretch failed the test.
 *
 * `compare` answers all three, and measures the calling thread's processor
 * time rather than the clock on the wall (`process.threadCpuUsage`), so time
 * the thread spent waiting for a core is not counted at all. With the load
 * average at eight times the cores, every wall-clock sample was stretched and
 * the fastest of them was no estimate of the work. Each side is first run
 * `WARM_RUNS` times on its own, so neither is measured in a slower tier of
 * the compiler than the other. Each sample then repeats the work until it
 * lasts at least `SAMPLE_MS`, so no side is below the timer's resolution; the
 * two sides alternate, in alternating order, so a move to a slower core or a
 * collection lands on both; and each side keeps its fastest sample per unit
 * of work, because a disturbance only ever makes a sample slower.
 *
 * It stops early only on clear evidence: a round whose ratio is at most the
 * limit divided by `CLEAR_MARGIN`, or two rounds in a row within the limit.
 * Stopping at the first round within the limit let a true ratio of 2.2 pass a
 * limit of 2 in 6 of 30 trials. Otherwise it samples up to `MAX_ROUNDS` and
 * reports the ratio of the fastest samples. Sampling on does not wear a real
 * regression down: the fastest sample of each side only approaches that
 * side's true cost from above, so work that is really four times dearer per
 * unit stays four times dearer however long it is sampled.
 *
 * `BUDGET_MS` of wall-clock time caps the whole comparison, warming and
 * calibration included, and is checked after every run of the work while
 * warming and calibrating and after every sample. Running out of it throws:
 * work so slow that the comparison cannot finish is the regression these
 * tests exist to catch (a backtracking pattern took 69.6 seconds before this
 * cap), not a pass. A single run cannot be interrupted from the thread doing
 * it, so work that may never return, such as a pattern that can backtrack
 * exponentially, belongs in a child process with a deadline, as
 * `packages/sdk-node/src/personal-data.test.ts` does.
 */

/** Each sample repeats the work until it takes at least this much processor time, in ms. */
const SAMPLE_MS = 3;
/** Runs of each side, on its own, before anything is measured. */
const WARM_RUNS = 3;
const MIN_ROUNDS = 3;
const MAX_ROUNDS = 40;
/** A round this far inside the limit ends the comparison on its own. */
const CLEAR_MARGIN = 1.5;
/** Wall-clock milliseconds the whole comparison may take before it fails. */
export const BUDGET_MS = 6_000;

export interface Side {
  /** Does the work once. */
  run: () => void;
  /** How many units of work one run is: bytes, calls, items. */
  units: number;
}

export interface Comparison {
  /**
   * The evidence for the verdict: the round, or the higher of the two rounds
   * in a row, that ended the comparison early, or else the fastest time per
   * unit of `measured` over the fastest time per unit of `reference`.
   */
  ratio: number;
  /** Milliseconds per unit, the fastest sample of each. */
  measured: number;
  reference: number;
  rounds: number;
}

/** Milliseconds of processor time the calling thread spends on `count` runs of `side`. */
function processorTime(side: Side, count: number): number {
  const started = process.threadCpuUsage();
  for (let index = 0; index < count; index += 1) side.run();
  const spent = process.threadCpuUsage(started);
  return (spent.user + spent.system) / 1_000;
}

/** Throws once the comparison has used its budget of wall-clock time. */
type BudgetCheck = (stage: string) => void;

function budget(budgetMs: number): BudgetCheck {
  const started = performance.now();
  return (stage) => {
    const elapsed = performance.now() - started;
    if (elapsed > budgetMs) {
      throw new Error(
        `The timing comparison ran out of its ${String(budgetMs)} ms budget while ${stage}, after ${elapsed.toFixed(0)} ms: the work is far slower than expected, as a pattern that backtracks would be.`
      );
    }
  };
}

/** How many runs of `side` fill one sample. */
function repetitions(side: Side, check: BudgetCheck): number {
  let count = 1;
  for (;;) {
    const elapsed = processorTime(side, count);
    check("calibrating a sample");
    if (elapsed >= SAMPLE_MS || count >= 1 << 20) return count;
    count = elapsed <= 0 ? count * 8 : Math.ceil((count * SAMPLE_MS * 1.5) / elapsed);
  }
}

/** Milliseconds of processor time per unit, over one sample of `count` runs. */
function sample(side: Side, count: number): number {
  return processorTime(side, count) / (count * side.units);
}

/**
 * The cost per unit of `measured` against that of `reference`. The caller
 * asserts that `ratio` is at most `limit`; the result also carries the figures
 * for the failure message. Throws when the budget runs out first.
 */
export function compare(
  measured: Side,
  reference: Side,
  limit: number,
  budgetMs: number = BUDGET_MS
): Comparison {
  const check = budget(budgetMs);
  for (const side of [measured, reference]) {
    for (let run = 0; run < WARM_RUNS; run += 1) {
      side.run();
      check("warming up");
    }
  }
  const measuredRuns = repetitions(measured, check);
  const referenceRuns = repetitions(reference, check);
  let fastestMeasured = Number.POSITIVE_INFINITY;
  let fastestReference = Number.POSITIVE_INFINITY;
  let previousRound = Number.POSITIVE_INFINITY;
  for (let rounds = 1; rounds <= MAX_ROUNDS; rounds += 1) {
    let measuredSample: number;
    let referenceSample: number;
    if (rounds % 2 === 1) {
      measuredSample = sample(measured, measuredRuns);
      check("sampling");
      referenceSample = sample(reference, referenceRuns);
    } else {
      referenceSample = sample(reference, referenceRuns);
      check("sampling");
      measuredSample = sample(measured, measuredRuns);
    }
    check("sampling");
    fastestMeasured = Math.min(fastestMeasured, measuredSample);
    fastestReference = Math.min(fastestReference, referenceSample);
    const round = measuredSample / referenceSample;
    if (rounds >= MIN_ROUNDS) {
      const evidence =
        round <= limit / CLEAR_MARGIN
          ? round
          : round <= limit && previousRound <= limit
            ? Math.max(round, previousRound)
            : undefined;
      if (evidence !== undefined) {
        return { ratio: evidence, measured: fastestMeasured, reference: fastestReference, rounds };
      }
    }
    previousRound = round;
  }
  return {
    ratio: fastestMeasured / fastestReference,
    measured: fastestMeasured,
    reference: fastestReference,
    rounds: MAX_ROUNDS
  };
}

/**
 * How much dearer a unit of input is at a larger size: `work(large.input)` per
 * one of `large.units` against `work(small.input)` per one of `small.units`.
 * Linear work reads about 1 at any sizes; quadratic work reads the ratio of
 * the sizes. Each size is warmed on its own before either is measured.
 */
export function growth<T>(
  work: (input: T) => unknown,
  small: { input: T; units: number },
  large: { input: T; units: number },
  limit: number,
  budgetMs: number = BUDGET_MS
): Comparison {
  return compare(
    { run: () => work(large.input), units: large.units },
    { run: () => work(small.input), units: small.units },
    limit,
    budgetMs
  );
}

/** A comparison's figures, for an assertion's message. */
export function describeComparison(comparison: Comparison): string {
  const micro = (ms: number): string => `${(ms * 1_000).toPrecision(3)} µs`;
  return `${micro(comparison.measured)} a unit against ${micro(comparison.reference)}, ratio ${comparison.ratio.toFixed(2)}, after ${String(comparison.rounds)} rounds`;
}
