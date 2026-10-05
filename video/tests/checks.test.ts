import { describe, expect, it } from "vitest";
import { integratedLufs, loudnormMeasure, type Probe, videoProblems } from "../src/checks";

const wide = { width: 1920, height: 1080, minSeconds: 55, maxSeconds: 65, maxBytes: 8_000_000 };
const good: Probe = {
  format: { duration: "61.5", size: "6000000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, color_space: "bt709" },
    { codec_type: "audio", codec_name: "aac" }
  ]
};

describe("output checks", () => {
  it("passes a cut that meets the spec", () => {
    expect(videoProblems("wide", good, wide)).toEqual([]);
  });

  it("names each way a cut misses the spec", () => {
    const bad: Probe = {
      format: { duration: "70", size: "9000000" },
      streams: [{ codec_type: "video", codec_name: "hevc", width: 1280, height: 720 }]
    };
    expect(videoProblems("wide", bad, wide)).toEqual([
      "wide: 70.0 s, outside 55 to 65 s.",
      "wide: 9.0 MB, over 8.0 MB.",
      "wide: video is hevc 1280x720, not h264 1920x1080.",
      "wide: video colour space is unknown, not bt709.",
      "wide: 0 AAC audio streams, not 1."
    ]);
  });

  it("names an untagged or BT.601 cut, whose colours players would shift", () => {
    const untagged: Probe = {
      ...good,
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac" }
      ]
    };
    expect(videoProblems("wide", untagged, wide)).toEqual([
      "wide: video colour space is unknown, not bt709."
    ]);
    const bt601: Probe = {
      ...good,
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          color_space: "smpte170m"
        },
        { codec_type: "audio", codec_name: "aac" }
      ]
    };
    expect(videoProblems("wide", bt601, wide)).toEqual([
      "wide: video colour space is smpte170m, not bt709."
    ]);
  });

  it("reads the integrated loudness from ffmpeg's ebur128 summary", () => {
    const stderr =
      "[Parsed_ebur128_0 @ 0x1] t: 1.0 M: -21.0\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -20.3 LUFS\n    Threshold: -30.6 LUFS\n";
    expect(integratedLufs(stderr)).toBe(-20.3);
    expect(() => integratedLufs("nothing")).toThrow();
  });

  it("reads loudnorm's first-pass measurement", () => {
    const stderr =
      'noise\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-9.40",\n\t"input_lra" : "5.20",\n\t"input_thresh" : "-38.00",\n\t"output_i" : "-20.02",\n\t"target_offset" : "0.02"\n}\n';
    expect(loudnormMeasure(stderr)).toEqual({
      input_i: "-27.61",
      input_tp: "-9.40",
      input_lra: "5.20",
      input_thresh: "-38.00",
      target_offset: "0.02"
    });
  });
});
