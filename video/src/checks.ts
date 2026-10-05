export type Probe = {
  format: { duration: string; size: string };
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    color_space?: string;
  }[];
};

export type Expectation = {
  width: number;
  height: number;
  minSeconds: number;
  maxSeconds: number;
  maxBytes: number;
};

export const LUFS_TARGET = -20;
export const LUFS_TOLERANCE = 1.5;
export const MAX_MP4_BYTES = 8_000_000;
export const MAX_GIF_BYTES = 2_000_000;

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** Everything about a probed cut that misses the spec, as sentences. */
export function videoProblems(name: string, probe: Probe, expect: Expectation): string[] {
  const problems: string[] = [];
  const seconds = Number(probe.format.duration);
  if (!(seconds >= expect.minSeconds && seconds <= expect.maxSeconds)) {
    problems.push(
      `${name}: ${seconds.toFixed(1)} s, outside ${String(expect.minSeconds)} to ${String(expect.maxSeconds)} s.`
    );
  }
  const bytes = Number(probe.format.size);
  if (bytes > expect.maxBytes) problems.push(`${name}: ${mb(bytes)}, over ${mb(expect.maxBytes)}.`);
  const videos = probe.streams.filter((s) => s.codec_type === "video");
  const video = videos[0];
  if (videos.length !== 1 || video === undefined) {
    problems.push(`${name}: ${String(videos.length)} video streams, not 1.`);
  } else if (
    video.codec_name !== "h264" ||
    video.width !== expect.width ||
    video.height !== expect.height
  ) {
    problems.push(
      `${name}: video is ${video.codec_name} ${String(video.width)}x${String(video.height)}, not h264 ${String(expect.width)}x${String(expect.height)}.`
    );
  }
  // Untagged video is decoded with whichever matrix the player guesses (browsers
  // assume BT.709 for HD), so saturated colours shift unless the cut says bt709.
  if (video !== undefined && video.color_space !== "bt709") {
    problems.push(`${name}: video colour space is ${video.color_space ?? "unknown"}, not bt709.`);
  }
  const aac = probe.streams.filter(
    (s) => s.codec_type === "audio" && s.codec_name === "aac"
  ).length;
  if (aac !== 1) problems.push(`${name}: ${String(aac)} AAC audio streams, not 1.`);
  return problems;
}

/** The integrated loudness, in LUFS, from the summary ffmpeg's ebur128 filter prints last. */
export function integratedLufs(stderr: string): number {
  const matches = [...stderr.matchAll(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?) LUFS/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) throw new Error("ffmpeg printed no integrated loudness.");
  return Number(last);
}

export type LoudnormMeasure = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/** loudnorm's first-pass measurement: the JSON block it prints last. */
export function loudnormMeasure(stderr: string): LoudnormMeasure {
  const json = JSON.parse(
    stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)
  ) as Record<string, string>;
  const pick = (key: keyof LoudnormMeasure) => {
    const value = json[key];
    if (value === undefined) throw new Error(`loudnorm printed no ${key}.`);
    return value;
  };
  return {
    input_i: pick("input_i"),
    input_tp: pick("input_tp"),
    input_lra: pick("input_lra"),
    input_thresh: pick("input_thresh"),
    target_offset: pick("target_offset")
  };
}
