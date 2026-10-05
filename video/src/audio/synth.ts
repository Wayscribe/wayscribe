// Copied from Shorts Studio, src/audio/synth.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: import paths, added the sine and tick voices, and prettier formatting.

import { SAMPLE_RATE } from "./constants";
import type { NoteEvent, Stereo, Voice } from "./types";

type Env = { a: number; d: number; s: number; r: number };

const PAN: Record<Voice, number> = {
  pulse1: -0.25,
  pulse2: 0.25,
  triangle: 0,
  noise: 0.1,
  pad: 0,
  sine: 0.15,
  tick: 0
};
const GAIN: Record<Voice, number> = {
  pulse1: 0.18,
  pulse2: 0.14,
  triangle: 0.32,
  noise: 0.16,
  pad: 0.12,
  sine: 0.16,
  tick: 0.2
};
const ENV: Record<Exclude<Voice, "noise">, Env> = {
  pulse1: { a: 0.005, d: 0.08, s: 0.6, r: 0.06 },
  pulse2: { a: 0.005, d: 0.06, s: 0.5, r: 0.05 },
  triangle: { a: 0.002, d: 0.05, s: 0.9, r: 0.03 },
  pad: { a: 0.25, d: 0.3, s: 0.7, r: 0.6 },
  // A soft lead: a gentle attack and a long release.
  sine: { a: 0.03, d: 0.25, s: 0.6, r: 0.5 },
  // A short struck sound: gone by the end of its decay.
  tick: { a: 0.001, d: 0.06, s: 0, r: 0.02 }
};

export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

// Noise is a percussive decay over the whole note.
const envFor = (note: NoteEvent): Env =>
  note.voice === "noise"
    ? { a: 0.001, d: Math.max(0.01, note.dur), s: 0, r: 0.01 }
    : ENV[note.voice];

// Vibrato offset in semitones; starts at zero when it kicks in at 0.15 s.
export const vibratoAt = (t: number): number =>
  t > 0.15 ? 0.25 * Math.sin(2 * Math.PI * 5.5 * (t - 0.15)) : 0;

export const ECHO = [
  [0.3, 0.35],
  [0.6, 0.12]
] as const;

/** How long each voice keeps sounding after its note's `dur`: the release, plus the longest echo for the pad. */
export const TAIL_SEC: Record<Voice, number> = {
  pulse1: ENV.pulse1.r,
  pulse2: ENV.pulse2.r,
  triangle: ENV.triangle.r,
  noise: 0.01, // envFor gives noise r = 0.01
  pad: ENV.pad.r + Math.max(...ECHO.map(([delay]) => delay)),
  sine: ENV.sine.r,
  tick: ENV.tick.r
};

function held(t: number, e: Env): number {
  if (t < e.a) return t / e.a;
  if (t < e.a + e.d) return 1 - (1 - e.s) * ((t - e.a) / e.d);
  return e.s;
}

export function envelopeAt(t: number, dur: number, e: Env): number {
  if (t < 0) return 0;
  if (t < dur) return held(t, e);
  return held(dur, e) * Math.max(0, 1 - (t - dur) / e.r);
}

function renderNote(note: NoteEvent, left: Float32Array, right: Float32Array, sr: number): void {
  const env = envFor(note);
  const start = Math.round(note.start * sr);
  const len = Math.ceil((note.dur + env.r) * sr);
  const angle = ((PAN[note.voice] + 1) * Math.PI) / 4;
  const gL = Math.cos(angle) * Math.SQRT2;
  const gR = Math.sin(angle) * Math.SQRT2;
  const amp = GAIN[note.voice] * note.vel;
  let phase = 0;
  let lfsr = 1;
  let noiseOut = 1;
  let noiseClock = 0;

  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0) continue;
    if (idx >= left.length) break;
    const t = i / sr;
    const glide =
      note.slideTo === undefined
        ? 0
        : (note.slideTo - note.midi) * (note.dur > 0 ? Math.min(1, t / note.dur) : 1);
    const vib = note.vibrato ? vibratoAt(t) : 0;
    const hz = midiToHz(note.midi + glide + vib);
    let s: number;
    switch (note.voice) {
      case "pulse1":
      case "pulse2":
        phase = (phase + hz / sr) % 1;
        s = phase < (note.duty ?? 0.5) ? 1 : -1;
        break;
      case "triangle": {
        phase = (phase + hz / sr) % 1;
        const tri = 1 - 4 * Math.abs(phase - 0.5);
        s = Math.round(tri * 7.5) / 7.5; // 4-bit stepped, NES-style
        break;
      }
      case "noise":
        noiseClock += (hz * 16) / sr;
        while (noiseClock >= 1) {
          noiseClock -= 1;
          const bit = (lfsr ^ (lfsr >> 1)) & 1;
          lfsr = (lfsr >> 1) | (bit << 14);
          noiseOut = lfsr & 1 ? 1 : -1;
        }
        s = noiseOut;
        break;
      case "sine":
      case "tick":
        phase = (phase + hz / sr) % 1;
        s = Math.sin(2 * Math.PI * phase);
        break;
      case "pad":
        phase = (phase + hz / sr) % 1;
        s =
          0.77 *
          (Math.sin(2 * Math.PI * phase) +
            0.3 * Math.sin(4 * Math.PI * phase + Math.sin(2 * Math.PI * phase)));
        break;
    }
    const v = s * amp * envelopeAt(t, note.dur, env);
    left[idx] += v * gL;
    right[idx] += v * gR;
  }
}

export function renderNotes(notes: NoteEvent[], totalSec: number, sr = SAMPLE_RATE): Stereo {
  const n = Math.ceil(totalSec * sr);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const padL = new Float32Array(n);
  const padR = new Float32Array(n);
  for (const note of notes) {
    if (note.voice === "pad") renderNote(note, padL, padR, sr);
    else renderNote(note, left, right, sr);
  }
  for (let i = 0; i < n; i++) {
    left[i] += padL[i];
    right[i] += padR[i];
  }
  for (const [delay, gain] of ECHO) {
    const off = Math.round(delay * sr);
    for (let i = 0; i + off < n; i++) {
      left[i + off] += padL[i] * gain;
      right[i + off] += padR[i] * gain;
    }
  }
  return { left, right };
}
