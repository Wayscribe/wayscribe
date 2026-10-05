// Copied from Shorts Studio, tests/audio/wav.test.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: none.

import { describe, expect, it } from "vitest";
import { encodeWav } from "../../src/audio/wav";

describe("encodeWav", () => {
  it("writes a 16-bit stereo PCM header and clamps samples", () => {
    const left = Float32Array.from([0, 1, -1, 2]);
    const right = Float32Array.from([0.5, -0.5, 0, -2]);
    const buf = encodeWav({ left, right }, 48000);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.readUInt16LE(22)).toBe(2);
    expect(buf.readUInt32LE(24)).toBe(48000);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.readUInt32LE(40)).toBe(16);
    expect(buf.length).toBe(44 + 16);
    expect(buf.readInt16LE(44 + 4)).toBe(32767);
    expect(buf.readInt16LE(44 + 8)).toBe(-32767);
    expect(buf.readInt16LE(44 + 12)).toBe(32767);
    expect(buf.readInt16LE(44 + 14)).toBe(-32768);
  });
});
