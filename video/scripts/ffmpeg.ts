import { spawnSync } from "node:child_process";
import { integratedLufs, loudnormMeasure, LUFS_TARGET, type Probe } from "../src/checks";
import { spawnFailure } from "../src/spawn";

const FFMPEG = process.env["FFMPEG"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE"] ?? "ffprobe";

function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // A program that never started (not installed) or was killed has no stderr: say that first.
  const failure = spawnFailure(command, args, result);
  if (failure !== undefined) throw new Error(failure);
  return { stdout: result.stdout, stderr: result.stderr };
}

const ffmpeg = (args: string[]) => run(FFMPEG, ["-hide_banner", "-y", ...args]);

export function probe(file: string): Probe {
  const { stdout } = run(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,codec_name,width,height,color_space,color_primaries,color_transfer,color_range",
    "-of",
    "json",
    file
  ]);
  return JSON.parse(stdout) as Probe;
}

/** Two-pass loudnorm to the spec's target: measure, then apply linearly. */
export function loudnorm(input: string, output: string): void {
  const filter = `loudnorm=I=${String(LUFS_TARGET)}:TP=-2:LRA=11`;
  const { stderr } = run(FFMPEG, [
    "-hide_banner",
    "-i",
    input,
    "-af",
    `${filter}:print_format=json`,
    "-f",
    "null",
    "-"
  ]);
  const m = loudnormMeasure(stderr);
  ffmpeg([
    "-i",
    input,
    "-af",
    `${filter}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    "-ar",
    "48000",
    output
  ]);
}

export function loudness(file: string): number {
  const { stderr } = run(FFMPEG, [
    "-hide_banner",
    "-nostats",
    "-i",
    file,
    "-map",
    "0:a",
    "-af",
    "ebur128",
    "-f",
    "null",
    "-"
  ]);
  return integratedLufs(stderr);
}

/** The final cut: the silent render re-encoded at `crf` with the music, ready to stream. */
export function encodeFinal(silent: string, music: string, output: string, crf: number): void {
  ffmpeg([
    "-i",
    silent,
    "-i",
    music,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    // Tagged explicitly, not passed through from the silent render: untagged HD video is
    // decoded however the player guesses. Limited ("tv") range is what yuv420p carries.
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    output
  ]);
}

export function still(input: string, seconds: number, output: string): void {
  ffmpeg(["-ss", seconds.toFixed(3), "-i", input, "-frames:v", "1", output]);
}

export function gif(
  input: string,
  startSec: number,
  endSec: number,
  colors: number,
  output: string
): void {
  ffmpeg([
    "-ss",
    startSec.toFixed(2),
    "-to",
    endSec.toFixed(2),
    "-i",
    input,
    "-vf",
    `fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${String(colors)}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    output
  ]);
}
