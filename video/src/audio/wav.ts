// Copied from Shorts Studio, src/audio/wav.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: import paths only.

import { SAMPLE_RATE } from "./constants";
import type { Stereo } from "./types";

const toI16 = (x: number): number => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));

export function encodeWav({ left, right }: Stereo, sampleRate = SAMPLE_RATE): Buffer {
  const frames = left.length;
  const dataBytes = frames * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(toI16(left[i]), 44 + i * 4);
    buf.writeInt16LE(toI16(right[i]), 46 + i * 4);
  }
  return buf;
}
