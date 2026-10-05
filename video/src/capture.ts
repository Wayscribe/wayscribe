import type { Box } from "./geometry";

// The capture's manifest, written by scripts/demo-video.mjs as marks.json.
// `at` values are milliseconds from the start of the capture; boxes and click
// points are CSS pixels; frames are `scale` device pixels per CSS pixel.

export type Frame = { at: number; file: string };
export type Mark = { name: string; at: number; boxes: Record<string, Box> };
export type Click = { at: number; x: number; y: number };
export type Capture = {
  version: 1;
  viewport: { width: number; height: number };
  scale: number;
  frames: Frame[];
  marks: Mark[];
  clicks: Click[];
};

/** The frame on screen at `at` ms: the last one captured at or before it (the first, before any). */
export function frameAt(frames: readonly Frame[], at: number): Frame {
  const first = frames[0];
  if (first === undefined) throw new Error("The capture has no frames.");
  if (at <= first.at) return first;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((frames[middle]?.at ?? Infinity) <= at) low = middle;
    else high = middle - 1;
  }
  return frames[low] ?? first;
}

export function findMark(capture: Capture, name: string): Mark | undefined {
  return capture.marks.find((mark) => mark.name === name);
}

export function markNamed(capture: Capture, name: string): Mark {
  const mark = findMark(capture, name);
  if (mark === undefined) throw new Error(`The capture has no mark "${name}".`);
  return mark;
}

export function boxOf(capture: Capture, mark: string, box: string): Box {
  const found = markNamed(capture, mark).boxes[box];
  if (found === undefined) throw new Error(`Mark "${mark}" has no box "${box}".`);
  return found;
}
