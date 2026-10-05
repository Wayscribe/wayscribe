// Copied from Shorts Studio, src/audio/mixer.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: import paths only.

import { SAMPLE_RATE } from "./constants";
import type { Stereo } from "./types";

export const CEILING = 0.89; // about -1 dBFS; ffmpeg loudnorm sets final loudness
export const SFX_GAIN = 4; // +12 dB: effects sit above the music
export const FADE_OUT_SEC = 0.005; // a declick, not a fade: music and effects already end before the last sample
const DUCK_DEPTH = 0.5;
const ATTACK_SEC = 0.005;
const RELEASE_SEC = 0.15;

/** Music ducks under `sfx`; `over` (ticks, blips) sits on top without ducking anything. */
export function mix(music: Stereo, sfx: Stereo, over?: Stereo, sr = SAMPLE_RATE): Stereo {
  const n = Math.max(music.left.length, sfx.left.length, over?.left.length ?? 0);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const attack = Math.exp(-1 / (ATTACK_SEC * sr));
  const release = Math.exp(-1 / (RELEASE_SEC * sr));
  let env = 0;
  for (let i = 0; i < n; i++) {
    const fl = (sfx.left[i] ?? 0) * SFX_GAIN;
    const fr = (sfx.right[i] ?? 0) * SFX_GAIN;
    const level = Math.max(Math.abs(fl), Math.abs(fr));
    const c = level > env ? attack : release;
    env = c * env + (1 - c) * level;
    const gain = 1 - DUCK_DEPTH * Math.min(1, env * 12);
    left[i] = (music.left[i] ?? 0) * gain + fl + (over?.left[i] ?? 0) * SFX_GAIN;
    right[i] = (music.right[i] ?? 0) * gain + fr + (over?.right[i] ?? 0) * SFX_GAIN;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const k = peak > 0 ? CEILING / peak : 1;
  const fadeN = Math.round(FADE_OUT_SEC * sr);
  for (let i = 0; i < n; i++) {
    const f = Math.min(1, (n - 1 - i) / fadeN);
    left[i] *= k * f;
    right[i] *= k * f;
  }
  return { left, right };
}
