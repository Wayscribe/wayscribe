// Renders the demo's music: the calm arrangement, the two soft ticks, and the
// fades, mixed by the mixer copied from Shorts Studio. Final loudness is set by
// ffmpeg's loudnorm in scripts/render.ts.
import { composeCalm } from "./calm";
import { SAMPLE_RATE } from "./constants";
import { mix } from "./mixer";
import { renderNotes } from "./synth";
import type { NoteEvent, Stereo } from "./types";

export type MusicOptions = {
  totalSec: number;
  seed: number;
  /** Seconds at which a highlight lands. */
  ticks: readonly number[];
  fadeInSec: number;
  fadeOutSec: number;
};

const TICK_MIDI = 88;

export const tickNotes = (ticks: readonly number[]): NoteEvent[] =>
  ticks.map((start) => ({ voice: "tick", start, dur: 0.05, midi: TICK_MIDI, vel: 0.35 }));

export function renderMusic(options: MusicOptions, sr = SAMPLE_RATE): Stereo {
  const { notes } = composeCalm({ totalSec: options.totalSec, seed: options.seed });
  const music = renderNotes(notes, options.totalSec, sr);
  const ticks = renderNotes(tickNotes(options.ticks), options.totalSec, sr);
  const nothing: Stereo = {
    left: new Float32Array(music.left.length),
    right: new Float32Array(music.right.length)
  };
  // Ticks ride on top of the music without ducking it.
  return applyFades(mix(music, nothing, ticks, sr), options.fadeInSec, options.fadeOutSec, sr);
}

/** Linear fades from and to silence, in place. */
export function applyFades(s: Stereo, inSec: number, outSec: number, sr = SAMPLE_RATE): Stereo {
  const n = s.left.length;
  const fadeIn = Math.round(inSec * sr);
  const fadeOut = Math.round(outSec * sr);
  for (let i = 0; i < n; i++) {
    const gain = Math.min(1, fadeIn > 0 ? i / fadeIn : 1, fadeOut > 0 ? (n - 1 - i) / fadeOut : 1);
    s.left[i] = (s.left[i] ?? 0) * gain;
    s.right[i] = (s.right[i] ?? 0) * gain;
  }
  return s;
}
