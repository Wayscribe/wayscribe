import { describe, expect, it } from "vitest";
import {
  crfSummary,
  encodeWithinBudget,
  integratedLufs,
  loudnormMeasure,
  parseNumber,
  type Probe,
  videoProblems
} from "../src/checks";

const wide = { width: 1920, height: 1080, minSeconds: 55, maxSeconds: 65, maxBytes: 8_000_000 };
const bt709 = {
  color_space: "bt709",
  color_primaries: "bt709",
  color_transfer: "bt709",
  color_range: "tv"
};
const good: Probe = {
  format: { duration: "61.5", size: "6000000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, ...bt709 },
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
      "wide: video colour primaries are unknown, not bt709.",
      "wide: video colour transfer is unknown, not bt709.",
      "wide: video colour range is unknown, not tv.",
      "wide: 0 AAC audio streams, not 1."
    ]);
  });

  const withVideo = (tags: Record<string, string>): Probe => ({
    ...good,
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, ...tags },
      { codec_type: "audio", codec_name: "aac" }
    ]
  });

  it("names an untagged or BT.601 cut, whose colours players would shift", () => {
    expect(videoProblems("wide", withVideo({}), wide)).toEqual([
      "wide: video colour space is unknown, not bt709.",
      "wide: video colour primaries are unknown, not bt709.",
      "wide: video colour transfer is unknown, not bt709.",
      "wide: video colour range is unknown, not tv."
    ]);
    expect(videoProblems("wide", withVideo({ ...bt709, color_space: "smpte170m" }), wide)).toEqual([
      "wide: video colour space is smpte170m, not bt709."
    ]);
  });

  it("checks the primaries, the transfer and the range, not only the matrix", () => {
    expect(
      videoProblems("wide", withVideo({ ...bt709, color_primaries: "smpte170m" }), wide)
    ).toEqual(["wide: video colour primaries are smpte170m, not bt709."]);
    expect(
      videoProblems("wide", withVideo({ ...bt709, color_transfer: "smpte170m" }), wide)
    ).toEqual(["wide: video colour transfer is smpte170m, not bt709."]);
    // Full-range video decoded as limited range crushes blacks and clips whites.
    expect(videoProblems("wide", withVideo({ ...bt709, color_range: "pc" }), wide)).toEqual([
      "wide: video colour range is pc, not tv."
    ]);
  });

  it("fails a cut whose size or duration cannot be read, instead of passing it as NaN", () => {
    const named = (format: Partial<Probe["format"]>): Probe => ({ ...good, format });
    expect(videoProblems("wide", named({ duration: "61.5" }), wide)).toEqual([
      "wide: no readable file size."
    ]);
    expect(videoProblems("wide", named({ size: "6000000" }), wide)).toEqual([
      "wide: no readable duration."
    ]);
    // ffprobe prints N/A for a field it cannot read; an empty string must not become 0.
    expect(videoProblems("wide", named({ duration: "N/A", size: "" }), wide)).toEqual([
      "wide: no readable duration.",
      "wide: no readable file size."
    ]);
    expect(videoProblems("wide", named({ duration: "61.5", size: "0" }), wide)).toEqual([
      "wide: no readable file size."
    ]);
  });

  it("parses a number ffprobe printed, or nothing", () => {
    expect(parseNumber("61.5")).toBe(61.5);
    expect(parseNumber(" 7 ")).toBe(7);
    for (const bad of [undefined, "", "  ", "N/A", "abc", "Infinity"])
      expect(parseNumber(bad)).toBeUndefined();
  });

  it("reads the integrated loudness from ffmpeg's ebur128 summary", () => {
    const stderr =
      "[Parsed_ebur128_0 @ 0x1] t: 1.0 M: -21.0\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -20.3 LUFS\n    Threshold: -30.6 LUFS\n";
    expect(integratedLufs(stderr)).toBe(-20.3);
    expect(() => integratedLufs("nothing")).toThrow();
  });

  it("names the failure when loudnorm printed no measurement", () => {
    expect(() => loudnormMeasure("size=N/A time=00:00:10 speed=50x")).toThrow(
      "loudnorm printed no measurement"
    );
    expect(() => loudnormMeasure("")).toThrow("loudnorm printed no measurement");
    // A closing brace with nothing before it is no block either.
    expect(() => loudnormMeasure("} then {")).toThrow("loudnorm printed no measurement");
    expect(() => loudnormMeasure("{ not json }")).toThrow("loudnorm printed no measurement");
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

  describe("fitting a cut to the size budget", () => {
    // An encoder whose output shrinks as the CRF rises: 12 MB at 20, 1 MB less per step of 2.
    const sizeAt = (crf: number) => 12_000_000 - (crf - 20) * 500_000;

    it("stops at the first CRF that fits", async () => {
      const tried: number[] = [];
      const result = await encodeWithinBudget((crf) => {
        tried.push(crf);
        return Promise.resolve(sizeAt(crf));
      }, 8_000_000);
      expect(result).toEqual({
        crf: 28,
        bytes: 8_000_000,
        tried: [20, 22, 24, 26, 28],
        fits: true
      });
      expect(tried).toEqual([20, 22, 24, 26, 28]);
    });

    it("gives up at CRF 30 and remembers every CRF it tried", async () => {
      const result = await encodeWithinBudget(() => Promise.resolve(9_000_000), 8_000_000);
      expect(result).toEqual({
        crf: 30,
        bytes: 9_000_000,
        tried: [20, 22, 24, 26, 28, 30],
        fits: false
      });
    });

    it("reports the CRF used when the cut fits", () => {
      const fits = { crf: 22, bytes: 7_900_000, tried: [20, 22], fits: true };
      expect(crfSummary("wide.mp4", fits, 8_000_000)).toEqual({ line: "wide.mp4: CRF 22" });
    });

    it("records the CRFs tried, and the failure, when the cut never fits", () => {
      const over = { crf: 30, bytes: 9_000_000, tried: [20, 22, 24, 26, 28, 30], fits: false };
      expect(crfSummary("wide.mp4", over, 8_000_000)).toEqual({
        line: "wide.mp4: CRF 20, 22, 24, 26, 28, 30 tried, 9.0 MB at CRF 30, over 8.0 MB",
        problem:
          "wide.mp4: still over budget at CRF 30 (tried 20, 22, 24, 26, 28, 30): 9.0 MB, max 8.0 MB."
      });
    });
  });
});
