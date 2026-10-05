// Copied from Shorts Studio, tests/audio/synth.test.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: added cases for the sine and tick voices, and prettier formatting.

import { describe, expect, it } from "vitest";
import { ECHO, midiToHz, renderNotes, vibratoAt } from "../../src/audio/synth";
import type { NoteEvent } from "../../src/audio/types";

const SR = 48000;

function risingEdges(x: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] <= 0 && x[i] > 0) n++;
  return n;
}

describe("synth", () => {
  it("converts MIDI to Hz", () => {
    expect(midiToHz(69)).toBeCloseTo(440);
    expect(midiToHz(81)).toBeCloseTo(880);
  });

  it("renders a pulse note at the right pitch", () => {
    const note: NoteEvent = { voice: "pulse1", start: 0, dur: 1, midi: 69, vel: 1, duty: 0.5 };
    const { left } = renderNotes([note], 1.2);
    const edges = risingEdges(left, Math.round(0.1 * SR), Math.round(0.9 * SR));
    expect(Math.abs(edges - 440 * 0.8)).toBeLessThanOrEqual(2);
  });

  it("is silent before a note starts and after its release", () => {
    const { left } = renderNotes(
      [{ voice: "pulse1", start: 0.5, dur: 0.2, midi: 60, vel: 1 }],
      1.5
    );
    expect(left.slice(0, Math.round(0.49 * SR)).every((v) => v === 0)).toBe(true);
    expect(left.slice(Math.round(1.0 * SR)).every((v) => v === 0)).toBe(true);
  });

  it("is deterministic, including noise", () => {
    const notes: NoteEvent[] = [
      { voice: "noise", start: 0, dur: 0.3, midi: 90, vel: 1 },
      { voice: "pad", start: 0.1, dur: 0.5, midi: 60, vel: 1, vibrato: true },
      { voice: "triangle", start: 0, dur: 0.4, midi: 40, slideTo: 28, vel: 1 }
    ];
    const a = renderNotes(notes, 1);
    const b = renderNotes(notes, 1);
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
    expect(a.left.some((v) => v !== 0)).toBe(true);
  });

  it("pans pulse1 left of center", () => {
    const { left, right } = renderNotes(
      [{ voice: "pulse1", start: 0, dur: 0.5, midi: 60, vel: 1 }],
      0.5
    );
    const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
    expect(energy(left)).toBeGreaterThan(energy(right));
  });

  it("drops samples that fall past the buffer end", () => {
    const { left } = renderNotes([{ voice: "pulse1", start: 0.9, dur: 1, midi: 60, vel: 1 }], 1);
    expect(left.length).toBe(SR);
  });

  it("does not produce NaN for a zero-duration slide", () => {
    const { left } = renderNotes(
      [{ voice: "triangle", start: 0, dur: 0, midi: 40, slideTo: 28, vel: 1 }],
      0.2
    );
    expect(left.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("starts vibrato at zero pitch offset", () => {
    expect(Math.abs(vibratoAt(0.1501))).toBeLessThan(0.01);
    expect(vibratoAt(0.1)).toBe(0);
  });

  it("echoes pad notes after their release has ended", () => {
    expect(ECHO).toEqual([
      [0.3, 0.35],
      [0.6, 0.12]
    ]);
    const { left } = renderNotes([{ voice: "pad", start: 0, dur: 0.1, midi: 60, vel: 1 }], 1.5);
    const win = left.slice(Math.round(0.8 * SR), Math.round(1.2 * SR));
    expect(win.some((v) => v !== 0)).toBe(true);
  });

  it("quantizes the triangle to at most 16 levels", () => {
    const { left } = renderNotes(
      [{ voice: "triangle", start: 0, dur: 0.6, midi: 45, vel: 1 }],
      0.7
    );
    const win = Array.from(left.slice(Math.round(0.2 * SR), Math.round(0.4 * SR)));
    const max = Math.max(...win.map(Math.abs));
    const levels = new Set(win.map((v) => Math.round((v / max) * 1e4)));
    expect(levels.size).toBeLessThanOrEqual(16);
    expect(levels.size).toBeGreaterThan(4);
  });

  it("slides a pulse note to the target pitch", () => {
    const { left } = renderNotes(
      [{ voice: "pulse1", start: 0, dur: 1, midi: 57, slideTo: 69, vel: 1 }],
      1.1
    );
    const edges = risingEdges(left, Math.round(0.9 * SR), SR);
    expect(Math.abs(edges - 44)).toBeLessThanOrEqual(3);
  });

  it("renders a sine note at the right pitch", () => {
    const { left } = renderNotes([{ voice: "sine", start: 0, dur: 1, midi: 69, vel: 1 }], 1.6);
    const edges = risingEdges(left, Math.round(0.1 * SR), Math.round(0.9 * SR));
    expect(Math.abs(edges - 440 * 0.8)).toBeLessThanOrEqual(2);
  });

  it("ends a tick within a tenth of a second of its start", () => {
    const { left } = renderNotes([{ voice: "tick", start: 0.1, dur: 0.05, midi: 88, vel: 1 }], 1);
    const peak = left
      .slice(Math.round(0.1 * SR), Math.round(0.15 * SR))
      .reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.01);
    expect(left.slice(Math.round(0.25 * SR)).every((v) => v === 0)).toBe(true);
  });
});
