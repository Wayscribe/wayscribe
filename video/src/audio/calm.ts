// A calm arrangement for the demo video, written for this repository on top of
// the synth copied from Shorts Studio. scaleMidi and makeMotif are copied from
// Shorts Studio's src/audio/composer.ts at commit 5675fc1; the rest is new.
import { fitBefore } from "./notes";
import { makeRng, type Rng } from "./rng";
import type { NoteEvent } from "./types";

export const CALM = {
  scale: [0, 2, 4, 5, 7, 9, 11],
  bpm: [72, 84] as const,
  progressions: [
    [0, 5, 3, 4],
    [0, 3, 5, 4],
    [5, 3, 0, 4]
  ]
};

const BEATS_PER_BAR = 4;
const BASS = 36;
const MID = 60;
const LEAD = 72;
// The last bar starts at least this long before the end, so its chord can ring.
const FINAL_BAR_LEAD_SEC = 2;

export type MotifNote = { step: number; beats: number };

export function scaleMidi(scale: number[], root: number, base: number, degree: number): number {
  const n = scale.length;
  const octave = Math.floor(degree / n);
  const d = ((degree % n) + n) % n;
  return base + root + (scale[d] ?? 0) + 12 * octave;
}

// 4 to 8 notes spread over 8 eighth-notes, ending on a chord tone.
export function makeMotif(rng: Rng): MotifNote[] {
  const count = rng.int(4, 8);
  const eighths = new Array<number>(count).fill(1);
  for (let extra = 8 - count; extra > 0; extra--) eighths[rng.int(0, count - 1)]++;
  let step = 0;
  return eighths.map((len, i) => {
    if (i > 0) step += rng.pick([-2, -1, 1, 1, 2, 3, -3, 0]);
    if (i === count - 1) step = rng.pick([0, 2, 4]);
    return { step, beats: len / 2 };
  });
}

export type CalmTrack = { bpm: number; root: number; notes: NoteEvent[] };

/** Pads holding each bar's chord, a soft bass, a gentle eighth-note pulse and a sparse sine lead. */
export function composeCalm({ totalSec, seed }: { totalSec: number; seed: number }): CalmTrack {
  const rng = makeRng(seed);
  const bpm = rng.int(CALM.bpm[0], CALM.bpm[1]);
  const root = rng.int(0, 11);
  const progression = rng.pick(CALM.progressions);
  const motif = makeMotif(rng);
  const beat = 60 / bpm;
  const bar = beat * BEATS_PER_BAR;
  const lastBar = Math.max(0, Math.floor((totalSec - FINAL_BAR_LEAD_SEC) / bar));
  const deg = (base: number, degree: number) => scaleMidi(CALM.scale, root, base, degree);
  const notes: NoteEvent[] = [];
  const add = (note: NoteEvent) => {
    const fit = fitBefore(note, totalSec);
    if (fit !== undefined) notes.push(fit);
  };

  for (let b = 0; b <= lastBar; b++) {
    const t = b * bar;
    const chord = b === lastBar ? 0 : (progression[b % progression.length] ?? 0);
    for (const degree of [chord, chord + 2, chord + 4]) {
      add({ voice: "pad", start: t, dur: bar, midi: deg(MID, degree), vel: 0.5 });
    }
    for (const at of [0, 2]) {
      add({
        voice: "triangle",
        start: t + at * beat,
        dur: beat * 1.5,
        midi: deg(BASS, chord),
        vel: 0.45
      });
    }
    if (b === lastBar) continue;
    for (let e = 0; e < 8; e++) {
      const degree = chord + ([0, 2, 4, 2][e % 4] ?? 0);
      add({
        voice: "sine",
        start: t + (e * beat) / 2,
        dur: (beat / 2) * 0.8,
        midi: deg(MID + 12, degree),
        vel: 0.18
      });
    }
    if (b >= 2 && b % 2 === 0) {
      let at = 0;
      for (const m of motif) {
        add({
          voice: "sine",
          start: t + at * beat,
          dur: m.beats * beat * 0.9,
          midi: deg(LEAD, chord + m.step),
          vel: 0.3
        });
        at += m.beats;
      }
    }
  }
  return { bpm, root, notes };
}
