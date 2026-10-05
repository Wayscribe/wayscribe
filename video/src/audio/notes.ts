// Copied from Shorts Studio, src/audio/notes.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: formatting only (prettier).

import { TAIL_SEC } from "./synth";
import type { NoteEvent } from "./types";

export const MIN_DUR = 0.005;
const END_MARGIN_SEC = 0.002;
const EPS = 1e-9;

/** The note shortened so that it, release tail included, ends before the final sample; undefined if nothing is left. */
export function fitBefore(n: NoteEvent, totalSec: number): NoteEvent | undefined {
  const room = totalSec - n.start - TAIL_SEC[n.voice] - END_MARGIN_SEC;
  if (n.start < 0 || room < MIN_DUR) return undefined;
  return { ...n, dur: Math.min(n.dur, room) };
}

export const startsIn = (n: NoteEvent, s: number, e: number): boolean =>
  n.start >= s - EPS && n.start < e - EPS;

/** A rest from `s` to `e`: nothing starts inside it, and notes that would ring into it stop short of it. */
export function rest(notes: NoteEvent[], s: number, e: number): NoteEvent[] {
  return notes.flatMap((n) => {
    if (startsIn(n, s, e)) return [];
    if (n.start >= s - EPS || n.start + n.dur + TAIL_SEC[n.voice] <= s) return [n];
    const dur = s - n.start - TAIL_SEC[n.voice];
    return dur >= MIN_DUR ? [{ ...n, dur }] : [];
  });
}
