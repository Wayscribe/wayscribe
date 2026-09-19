/**
 * Narrates the demo video: renders scripts/demo-narration.json with Kokoro, an
 * open-source (Apache-2.0) text-to-speech model that runs locally, and mixes
 * each line in at the start of its caption.
 *
 *   pnpm demo:video --narrate   records the video paced to the voice, then mixes
 *   pnpm demo:narrate           mixes into an existing OUT_DIR/wayscribe-demo.mp4
 *                               and its captions.json
 *   pnpm demo:narrate --samples renders the sample sentence in each sample voice
 *
 * Writes OUT_DIR/wayscribe-demo-narrated.mp4 beside the silent video, which is
 * kept: social video autoplays muted, so the captions stay either way.
 *
 * One-time setup, in KOKORO_DIR (default OUT_DIR/tts), nothing installed
 * globally:
 *
 *   brew install espeak-ng
 *   uv venv --python 3.12 "$KOKORO_DIR/.venv"
 *   VIRTUAL_ENV="$KOKORO_DIR/.venv" uv pip install kokoro-onnx soundfile
 *   mkdir -p "$KOKORO_DIR/models" && cd "$KOKORO_DIR/models"
 *   for f in kokoro-v1.0.onnx voices-v1.0.bin; do
 *     curl -fLO "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
 *   done
 *
 * The model files are about 350 MB and are never committed. espeak-ng comes
 * from Homebrew because the copy kokoro-onnx bundles cannot find its own data
 * from a deep scratch directory (espeak-ng keeps that path in 160 bytes).
 *
 * Every line has to say only what the screen shows at that moment. A caption
 * stays up for at least LEAD + its narration + BREATH: when recording with
 * --narrate the script waits that long, and when mixing into a recording that
 * was not paced, the last frame of a short segment is frozen to make room, so
 * the voice never runs over the next caption.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NARRATION = join(HERE, "demo-narration.json");
const FFMPEG = process.env["FFMPEG"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE"] ?? "ffprobe";

/** Seconds between a caption appearing and its voice starting (the caption fades in). */
export const LEAD = 0.25;
/** Seconds of quiet after a line before the next caption may appear. */
export const BREATH = 0.4;
const LOUDNESS = { I: -16, TP: -1.5, LRA: 11 };

export const outDir = () => process.env["OUT_DIR"] ?? join(tmpdir(), "wayscribe-demo-video");
const kokoroDir = (out) => process.env["KOKORO_DIR"] ?? join(out, "tts");

function runTts(out, target, extra = []) {
  const tts = kokoroDir(out);
  execFileSync(
    join(tts, ".venv", "bin", "python"),
    [join(HERE, "demo-tts.py"), NARRATION, target, join(tts, "models"), ...extra],
    { stdio: "inherit" }
  );
}

/** Renders every line; returns the seconds each caption must stay up, by name. */
export async function renderNarration(out = outDir()) {
  const dir = join(out, "narration");
  runTts(out, dir);
  const durations = JSON.parse(await readFile(join(dir, "durations.json"), "utf8"));
  return Object.fromEntries(durations.map((line) => [line.name, LEAD + line.seconds + BREATH]));
}

export function renderSamples(out = outDir()) {
  runTts(out, join(out, "voice-samples"), ["--samples"]);
}

const ffmpeg = (args) =>
  execFileSync(FFMPEG, ["-hide_banner", "-nostats", "-y", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024
  });

function probeSeconds(file) {
  const seconds = execFileSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" }
  );
  return Number(seconds.trim());
}

/** loudnorm prints its measurement to stderr, which execFileSync does not return. */
function measureLoudness(file) {
  const result = spawnSync(
    FFMPEG,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      `loudnorm=I=${String(LOUDNESS.I)}:TP=${String(LOUDNESS.TP)}:LRA=${String(LOUDNESS.LRA)}:print_format=json`,
      "-f",
      "null",
      "-"
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const json = result.stderr.slice(result.stderr.lastIndexOf("{"));
  return JSON.parse(json.slice(0, json.indexOf("}") + 1));
}

/** Mixes the narration into OUT_DIR/wayscribe-demo.mp4 and returns the narrated file. */
export async function mixNarration(out = outDir()) {
  const video = join(out, "wayscribe-demo.mp4");
  const narrated = join(out, "wayscribe-demo-narrated.mp4");
  const dir = join(out, "narration");
  const captions = JSON.parse(await readFile(join(out, "captions.json"), "utf8"));
  const lines = new Map(
    JSON.parse(await readFile(join(dir, "durations.json"), "utf8")).map((line) => [line.name, line])
  );
  const total = probeSeconds(video);

  // Each caption's segment of the silent video, and how much it falls short of
  // its line. A paced recording falls short nowhere; anything else is padded
  // by freezing the segment's last frame.
  let shift = 0;
  const segments = captions.map((caption, index) => {
    const end = captions[index + 1]?.at ?? total;
    const line = lines.get(caption.name);
    const need = line === undefined ? 0 : LEAD + line.seconds + BREATH;
    const freeze = Math.max(0, need - (end - caption.at));
    const segment = {
      ...caption,
      end,
      line,
      freeze: freeze > 0.02 ? freeze : 0,
      start: caption.at + shift
    };
    shift += segment.freeze;
    return segment;
  });
  const length = total + shift;
  const voiced = segments.filter((segment) => segment.line !== undefined);

  // Pass 1: the voice track alone, every line at its caption's start plus LEAD.
  const mix = join(dir, "mix.wav");
  ffmpeg([
    ...voiced.flatMap((segment) => ["-i", join(dir, segment.line.file)]),
    "-filter_complex",
    [
      ...voiced.map(
        (segment, index) =>
          `[${String(index)}:a]aresample=48000,adelay=${String(Math.round((segment.start + LEAD) * 1000))}:all=1[a${String(index)}]`
      ),
      `${voiced.map((_, index) => `[a${String(index)}]`).join("")}amix=inputs=${String(voiced.length)}:normalize=0:dropout_transition=0,apad,atrim=0:${length.toFixed(3)}[out]`
    ].join(";"),
    "-map",
    "[out]",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s24le",
    mix
  ]);

  // Pass 2: normalize to LOUDNESS.I with the measured values, so loudnorm can
  // apply one linear gain instead of riding the level line by line.
  const measured = measureLoudness(mix);
  const loudnorm = [
    `loudnorm=I=${String(LOUDNESS.I)}:TP=${String(LOUDNESS.TP)}:LRA=${String(LOUDNESS.LRA)}`,
    `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}:linear=true`
  ].join(":");

  const frozen = segments.filter((segment) => segment.freeze > 0);
  const videoArgs =
    frozen.length === 0
      ? ["-map", "0:v", "-c:v", "copy"]
      : [
          "-filter_complex",
          `${segments
            .map(
              (segment, index) =>
                `[0:v]trim=start=${segment.at.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS${
                  segment.freeze > 0
                    ? `,tpad=stop_mode=clone:stop_duration=${segment.freeze.toFixed(3)}`
                    : ""
                }[v${String(index)}]`
            )
            .join(
              ";"
            )};${segments.map((_, index) => `[v${String(index)}]`).join("")}concat=n=${String(segments.length)}:v=1:a=0[v]`,
          "-map",
          "[v]",
          ...[
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "18",
            "-tune",
            "stillimage",
            "-pix_fmt",
            "yuv420p"
          ]
        ];

  ffmpeg([
    "-i",
    video,
    "-i",
    mix,
    ...videoArgs,
    "-map",
    "1:a",
    "-af",
    `${loudnorm},aresample=48000`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-t",
    length.toFixed(3),
    "-movflags",
    "+faststart",
    narrated
  ]);

  const timeline = voiced.map((segment) => ({
    name: segment.name,
    caption: Number(segment.start.toFixed(2)),
    voiceStart: Number((segment.start + LEAD).toFixed(2)),
    voiceEnd: Number((segment.start + LEAD + segment.line.seconds).toFixed(2)),
    nextCaption: Number((segments[segments.indexOf(segment) + 1]?.start ?? length).toFixed(2)),
    frozen: Number(segment.freeze.toFixed(2)),
    text: segment.line.text
  }));
  for (const entry of timeline) {
    if (entry.voiceEnd + BREATH > entry.nextCaption + 0.01) {
      throw new Error(`"${entry.name}" runs over the next caption.`);
    }
  }
  await writeFile(join(out, "narration-timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);

  console.log(
    frozen.length === 0
      ? "\n  Paced recording: no frames frozen."
      : `\n  Froze ${String(frozen.length)} segment end(s), ${shift.toFixed(1)}s in all: ${frozen.map((segment) => segment.name).join(", ")}`
  );
  for (const entry of timeline) {
    console.log(`  ${entry.voiceStart.toFixed(2).padStart(6)}s  ${entry.text}`);
  }
  console.log(
    `\n  ${narrated}\n  ${length.toFixed(1)}s, loudness measured ${measured.input_i} LUFS before normalizing to ${String(LOUDNESS.I)}.`
  );
  return narrated;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = outDir();
  if (process.argv.includes("--samples")) {
    renderSamples(out);
  } else {
    await renderNarration(out);
    await mixNarration(out);
  }
}
