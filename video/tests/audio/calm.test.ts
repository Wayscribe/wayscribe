import { describe, expect, it } from "vitest";
import { CALM, composeCalm, makeMotif, scaleMidi } from "../../src/audio/calm";
import { makeRng } from "../../src/audio/rng";
import { TAIL_SEC } from "../../src/audio/synth";

describe("the calm arrangement", () => {
  const track = composeCalm({ totalSec: 61.5, seed: 7 });
  const pitchClass = (midi: number) => (((midi - track.root) % 12) + 12) % 12;

  it("is the same track for the same seed and another for another seed", () => {
    expect(composeCalm({ totalSec: 61.5, seed: 7 })).toEqual(track);
    expect(composeCalm({ totalSec: 61.5, seed: 8 }).notes).not.toEqual(track.notes);
  });

  it("keeps a slow tempo", () => {
    expect(track.bpm).toBeGreaterThanOrEqual(CALM.bpm[0]);
    expect(track.bpm).toBeLessThanOrEqual(CALM.bpm[1]);
    expect(CALM.bpm[0]).toBeGreaterThanOrEqual(70);
    expect(CALM.bpm[1]).toBeLessThanOrEqual(85);
  });

  it("uses only soft voices", () => {
    expect(new Set(track.notes.map((n) => n.voice))).toEqual(new Set(["pad", "triangle", "sine"]));
  });

  it("stays in key", () => {
    for (const note of track.notes) expect(CALM.scale).toContain(pitchClass(note.midi));
  });

  it("lets every note ring out before the video ends", () => {
    for (const note of track.notes) {
      expect(note.start + note.dur + TAIL_SEC[note.voice]).toBeLessThan(61.5);
    }
  });

  it("ends on the home chord", () => {
    const lastStart = Math.max(...track.notes.filter((n) => n.voice === "pad").map((n) => n.start));
    const lastChord = track.notes.filter((n) => n.voice === "pad" && n.start === lastStart);
    expect(new Set(lastChord.map((n) => pitchClass(n.midi)))).toEqual(new Set([0, 4, 7]));
  });

  it("keeps Shorts Studio's scale and motif helpers' behaviour", () => {
    expect(scaleMidi([0, 2, 4, 5, 7, 9, 11], 0, 60, 7)).toBe(72);
    expect(scaleMidi([0, 2, 4, 5, 7, 9, 11], 0, 60, -1)).toBe(59);
    const motif = makeMotif(makeRng(1));
    expect(motif.reduce((sum, m) => sum + m.beats, 0)).toBe(4);
  });
});
