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
 * the fastest of them was no estimate of the work. Each sample repeats the
 * work until it lasts at least `SAMPLE_MS`, so no side is below the timer's
 * resolution; the two sides alternate, in alternating order, so a move to a
 * slower core or a collection lands on both; and each side keeps its fastest
 * sample per unit of work, because a disturbance only ever makes a sample
 * slower. It stops as soon as the fastest samples are within the limit after
 * `MIN_ROUNDS`, and otherwise keeps sampling up to `MAX_ROUNDS` or
 * `BUDGET_MS` of wall-clock time.
 *
 * Sampling on does not wear a real regression down. The fastest sample of
 * each side only approaches that side's true cost from above, so work that is
 * really four times dearer per unit stays four times dearer however long it
 * is sampled, while a comparison that failed because of noise passes once one
 * clean sample of each side has been seen.
 */

/** Each sample repeats the work until it takes at least this much processor time, in ms. */
const SAMPLE_MS = 3;
const MIN_ROUNDS = 5;
const MAX_ROUNDS = 40;
/** Sampling stops after this long even when a comparison is still over its limit. */
const BUDGET_MS = 6_000;

export interface Side {
  /** Does the work once. */
  run: () => void;
  /** How many units of work one run is: bytes, calls, items. */
  units: number;
}

export interface Comparison {
  /** The fastest time per unit of `measured`, over the fastest time per unit of `reference`. */
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

/** How many runs of `side` fill one sample. */
function repetitions(side: Side): number {
  side.run();
  let count = 1;
  for (;;) {
    const elapsed = processorTime(side, count);
    if (elapsed >= SAMPLE_MS || count >= 1 << 20) return count;
    count = elapsed <= 0 ? count * 8 : Math.ceil((count * SAMPLE_MS * 1.5) / elapsed);
  }
}

/** Milliseconds of processor time per unit, over one sample of `count` runs. */
function sample(side: Side, count: number): number {
  return processorTime(side, count) / (count * side.units);
}

/**
 * The cost per unit of `measured` against that of `reference`, sampled until
 * it is at most `limit` or the sampling budget runs out. The caller asserts on
 * `ratio`; the result also carries the figures for the failure message.
 */
export function compare(measured: Side, reference: Side, limit: number): Comparison {
  const measuredRuns = repetitions(measured);
  const referenceRuns = repetitions(reference);
  const deadline = performance.now() + BUDGET_MS;
  let fastestMeasured = Number.POSITIVE_INFINITY;
  let fastestReference = Number.POSITIVE_INFINITY;
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    if (rounds % 2 === 0) {
      fastestMeasured = Math.min(fastestMeasured, sample(measured, measuredRuns));
      fastestReference = Math.min(fastestReference, sample(reference, referenceRuns));
    } else {
      fastestReference = Math.min(fastestReference, sample(reference, referenceRuns));
      fastestMeasured = Math.min(fastestMeasured, sample(measured, measuredRuns));
    }
    rounds += 1;
    const ratio = fastestMeasured / fastestReference;
    if (rounds >= MIN_ROUNDS && (ratio <= limit || performance.now() > deadline)) break;
  }
  return {
    ratio: fastestMeasured / fastestReference,
    measured: fastestMeasured,
    reference: fastestReference,
    rounds
  };
}

/**
 * How much dearer a unit of input is at a larger size: `work(large)` per unit
 * of `largeUnits` against `work(small)` per unit of `smallUnits`. Linear work
 * reads about 1 at any sizes; quadratic work reads the ratio of the sizes.
 */
export function growth<T>(
  work: (input: T) => unknown,
  small: { input: T; units: number },
  large: { input: T; units: number },
  limit: number
): Comparison {
  return compare(
    { run: () => work(large.input), units: large.units },
    { run: () => work(small.input), units: small.units },
    limit
  );
}

/** A comparison's figures, for an assertion's message. */
export function describeComparison(comparison: Comparison): string {
  const micro = (ms: number): string => `${(ms * 1_000).toPrecision(3)} µs`;
  return `${micro(comparison.measured)} a unit against ${micro(comparison.reference)}, ratio ${comparison.ratio.toFixed(2)}, after ${String(comparison.rounds)} rounds`;
}
