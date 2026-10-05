// Copied from Shorts Studio, src/audio/rng.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: formatting only (prettier).

export type Rng = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(xs: readonly T[]): T;
};

// mulberry32
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]
  };
}
