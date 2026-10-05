import { describe, expect, it } from "vitest";
import { SAMPLE_RATE } from "../../src/audio/constants";
import { CEILING } from "../../src/audio/mixer";
import { applyFades, renderMusic, tickNotes } from "../../src/audio/music";

describe("the music track", () => {
  const options = { totalSec: 10, seed: 3, ticks: [4], fadeInSec: 2, fadeOutSec: 3 };
  const track = renderMusic(options);

  it("lasts exactly as long as the video", () => {
    expect(track.left.length).toBe(Math.ceil(10 * SAMPLE_RATE));
    expect(track.right.length).toBe(track.left.length);
  });

  it("fades in from silence and out to silence", () => {
    expect(track.left[0]).toBe(0);
    expect(track.left[track.left.length - 1]).toBe(0);
  });

  it("stays under the mixer's ceiling", () => {
    let peak = 0;
    for (let i = 0; i < track.left.length; i++) {
      peak = Math.max(peak, Math.abs(track.left[i] ?? 0), Math.abs(track.right[i] ?? 0));
    }
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peak).toBeGreaterThan(0.1);
  });

  it("is the same track for the same seed", () => {
    expect(renderMusic(options).left).toEqual(track.left);
  });

  it("puts one soft tick at each moment asked for", () => {
    expect(tickNotes([4, 9.5])).toEqual([
      { voice: "tick", start: 4, dur: 0.05, midi: 88, vel: 0.35 },
      { voice: "tick", start: 9.5, dur: 0.05, midi: 88, vel: 0.35 }
    ]);
  });

  it("fades linearly at both ends and leaves the middle alone", () => {
    const s = { left: Float32Array.of(1, 1, 1, 1, 1), right: Float32Array.of(1, 1, 1, 1, 1) };
    applyFades(s, 2, 2, 1);
    expect(Array.from(s.left)).toEqual([0, 0.5, 1, 0.5, 0]);
  });
});
