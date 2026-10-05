export type Probe = {
  format: { duration?: string; size?: string };
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    color_space?: string;
    color_primaries?: string;
    color_transfer?: string;
    color_range?: string;
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

/** A number ffprobe printed, or undefined for a missing, blank or non-numeric field ("N/A"). */
export function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Everything about a probed cut that misses the spec, as sentences. */
export function videoProblems(name: string, probe: Probe, expect: Expectation): string[] {
  const problems: string[] = [];
  // A field that cannot be read must fail, not turn into NaN, which no comparison catches.
  const seconds = parseNumber(probe.format.duration);
  if (seconds === undefined) {
    problems.push(`${name}: no readable duration.`);
  } else if (!(seconds >= expect.minSeconds && seconds <= expect.maxSeconds)) {
    problems.push(
      `${name}: ${seconds.toFixed(1)} s, outside ${String(expect.minSeconds)} to ${String(expect.maxSeconds)} s.`
    );
  }
  const bytes = parseNumber(probe.format.size);
  if (bytes === undefined || bytes <= 0) {
    problems.push(`${name}: no readable file size.`);
  } else if (bytes > expect.maxBytes) {
    problems.push(`${name}: ${mb(bytes)}, over ${mb(expect.maxBytes)}.`);
  }
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
  // The primaries and transfer are checked too, and the range: limited ("tv") is
  // what yuv420p H.264 means by default, and a player told "pc" stretches it.
  if (video !== undefined) {
    if (video.color_space !== "bt709") {
      problems.push(`${name}: video colour space is ${video.color_space ?? "unknown"}, not bt709.`);
    }
    if (video.color_primaries !== "bt709") {
      problems.push(
        `${name}: video colour primaries are ${video.color_primaries ?? "unknown"}, not bt709.`
      );
    }
    if (video.color_transfer !== "bt709") {
      problems.push(
        `${name}: video colour transfer is ${video.color_transfer ?? "unknown"}, not bt709.`
      );
    }
    if (video.color_range !== "tv") {
      problems.push(`${name}: video colour range is ${video.color_range ?? "unknown"}, not tv.`);
    }
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
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("loudnorm printed no measurement.");
  let json: Record<string, string>;
  try {
    json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  } catch {
    throw new Error("loudnorm printed no measurement.");
  }
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

export type BudgetResult = { crf: number; bytes: number; tried: number[]; fits: boolean };

/**
 * Encodes at CRF 20 and raises it by 2 until the file fits `maxBytes`, up to
 * CRF 30. `encode` writes the file at a CRF and returns its size. Every CRF
 * tried is kept, so a cut that never fits can say what was attempted.
 */
export async function encodeWithinBudget(
  encode: (crf: number) => Promise<number>,
  maxBytes: number
): Promise<BudgetResult> {
  const tried: number[] = [];
  for (let crf = 20; ; crf += 2) {
    tried.push(crf);
    const bytes = await encode(crf);
    if (bytes <= maxBytes || crf >= 30) return { crf, bytes, tried, fits: bytes <= maxBytes };
  }
}

/** The report line for a cut's CRF search, and the problem when no CRF made it fit. */
export function crfSummary(
  name: string,
  result: BudgetResult,
  maxBytes: number
): { line: string; problem?: string } {
  if (result.fits) return { line: `${name}: CRF ${String(result.crf)}` };
  const tried = result.tried.join(", ");
  return {
    line: `${name}: CRF ${tried} tried, ${mb(result.bytes)} at CRF ${String(result.crf)}, over ${mb(maxBytes)}`,
    problem: `${name}: still over budget at CRF ${String(result.crf)} (tried ${tried}): ${mb(result.bytes)}, max ${mb(maxBytes)}.`
  };
}
