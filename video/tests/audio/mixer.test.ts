// Copied from Shorts Studio, tests/audio/mixer.test.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: dropped the cases that need Shorts Studio's script and timeline, and
// prettier formatting.

import { describe, expect, it } from "vitest";
import { CEILING, FADE_OUT_SEC, mix, SFX_GAIN } from "../../src/audio/mixer";

const constant = (n: number, v: number) => new Float32Array(n).fill(v);

describe("mix", () => {
  it("ducks music under sound effects", () => {
    const n = 48000;
    const music = { left: constant(n, 0.5), right: constant(n, 0.5) };
    const sfxL = new Float32Array(n);
    sfxL.fill(0.3, 20000, 30000);
    const out = mix(music, { left: sfxL, right: sfxL.slice() });
    const k = out.left[10000] / 0.5; // normalization gain where no SFX play
    const musicDuring = out.left[25000] - SFX_GAIN * 0.3 * k;
    expect(musicDuring).toBeLessThan(out.left[10000] * 0.8);
  });

  it("keeps even quiet sound effects audible over the music", () => {
    const n = 48000;
    const music = { left: constant(n, 0.5), right: constant(n, 0.5) };
    const sfxL = new Float32Array(n);
    sfxL.fill(0.05, 20000, 30000);
    // SFX on the left only: the right channel carries the same ducked music.
    const out = mix(music, { left: sfxL, right: new Float32Array(n) });
    const duckedMusic = out.right[25000];
    const contribution = out.left[25000] - duckedMusic;
    expect(contribution).toBeGreaterThanOrEqual(0.6 * duckedMusic);
  });

  it("declicks the last 5 ms to silence", () => {
    const n = 48000;
    const out = mix(
      { left: constant(n, 0.5), right: constant(n, 0.5) },
      { left: new Float32Array(n), right: new Float32Array(n) }
    );
    expect(FADE_OUT_SEC).toBe(0.005);
    expect(out.left[n - 1]).toBe(0);
    expect(out.left[n - 1 - Math.round(FADE_OUT_SEC * 48000)]).toBeGreaterThan(CEILING * 0.95);
  });

  it("does not duck the music under the over bus", () => {
    const n = 48000;
    const music = { left: constant(n, 0.5), right: constant(n, 0.5) };
    const overL = new Float32Array(n);
    overL.fill(0.3, 20000, 30000);
    const silent = { left: new Float32Array(n), right: new Float32Array(n) };
    const out = mix(music, silent, { left: overL, right: new Float32Array(n) });
    expect(out.right[25000]).toBeCloseTo(out.right[10000], 6); // right carries only the music
    expect(out.left[25000]).toBeGreaterThan(out.left[10000]);
  });

  it("never exceeds the ceiling", () => {
    const n = 4800;
    const loud = { left: constant(n, 3), right: constant(n, -3) };
    const out = mix(loud, { left: constant(n, 2), right: constant(n, 2) });
    const peak = Math.max(...out.left.map(Math.abs), ...out.right.map(Math.abs));
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
  });
});
