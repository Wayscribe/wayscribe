// Renders both cuts of the demo video from a capture, with music, posters, the
// README GIF, the transcript, a still per caption, and the spec's checks.
// Run through `pnpm demo:video` (see docs/DEMO_RECORDING.md), or directly:
//   pnpm --dir video exec tsx scripts/render.ts --capture <dir> --out <dir>
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { renderMusic } from "../src/audio/music";
import { encodeWav } from "../src/audio/wav";
import { framingProblems } from "../src/camera";
import {
  crfSummary,
  encodeWithinBudget,
  LUFS_TARGET,
  LUFS_TOLERANCE,
  MAX_GIF_BYTES,
  MAX_MP4_BYTES,
  parseNumber,
  videoProblems
} from "../src/checks";
import { FORMATS, type FormatId, SCENES } from "../src/scenes";
import { buildTimeline } from "../src/timeline";
import { transcript } from "../src/transcript";
import { prepareBundle, readCapture } from "./bundle";
import { encodeFinal, gif, loudness, loudnorm, probe, still } from "./ffmpeg";
import { clearOutputs, writeThenRename } from "./outputs";

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    out: { type: "string" },
    seed: { type: "string", default: "20261004" }
  }
});
if (values.capture === undefined || values.out === undefined)
  throw new Error("Pass --capture and --out.");
const OUT = values.out;
const CUTS: { id: string; format: FormatId; file: string; poster: string }[] = [
  {
    id: "DemoWide",
    format: "wide",
    file: "wayscribe-demo.mp4",
    poster: "wayscribe-demo-poster.png"
  },
  {
    id: "DemoSquare",
    format: "square",
    file: "wayscribe-demo-square.mp4",
    poster: "wayscribe-demo-square-poster.png"
  }
];
const GIF = "demo-diff.gif";
const TRANSCRIPT = "wayscribe-demo-transcript.txt";
const REPORT = "report.txt";
const STILLS = "stills";

// Clear the last run's outputs first, before anything that can fail, so a run that fails
// partway leaves no report.txt saying "All checks pass." and no MP4 that looks current.
await clearOutputs(OUT, [
  REPORT,
  ...CUTS.flatMap((cut) => [cut.file, cut.poster]),
  GIF,
  TRANSCRIPT,
  STILLS
]);
const capture = await readCapture(values.capture);
const timeline = buildTimeline(SCENES, capture);
// frameBox quietly returns a view that does not frame a subject it cannot, so ask here, before any
// expensive work. The render still runs, to leave the stills that show what is wrong, and fails at the end.
const problems: string[] = framingProblems(SCENES, capture, Object.values(FORMATS));
const totalSec = timeline.totalFrames / timeline.fps;
const sceneById = (id: string) => {
  const found = timeline.scenes.find((t) => t.scene.id === id);
  if (found === undefined) throw new Error(`No scene "${id}".`);
  return found;
};
const seconds = (frame: number) => frame / timeline.fps;
const work = join(OUT, "work");
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

// Music: the calm arrangement, fading in over the hook card and out over the end card.
const hook = sceneById("hook");
const raw = join(work, "music.raw.wav");
const music = join(work, "music.wav");
await writeFile(
  raw,
  encodeWav(
    renderMusic({
      totalSec,
      seed: Number(values.seed),
      ticks: timeline.ticks,
      fadeInSec: hook.scene.seconds,
      fadeOutSec: 5
    })
  )
);
loudnorm(raw, music);

// Picture: one bundle, two silent near-lossless renders, then the final encodes.
const serveUrl = await prepareBundle(values.capture, OUT);
const report: string[] = [];
const phone = sceneById("phone");
const posterAt = seconds(phone.startFrame + phone.frames / 2);

for (const cut of CUTS) {
  const inputProps = { capture, format: cut.format };
  const composition = await selectComposition({ serveUrl, id: cut.id, inputProps });
  const silent = join(work, `silent-${cut.format}.mp4`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: 12,
    imageFormat: "png",
    // Remotion's default is BT.601, untagged, which players decode as BT.709 and shift saturated colours.
    colorSpace: "bt709",
    muted: true,
    inputProps,
    outputLocation: silent,
    onProgress: ({ progress }) =>
      process.stdout.write(`\r  ${cut.format} ${(progress * 100).toFixed(0)}%   `)
  });
  process.stdout.write("\n");
  const output = join(OUT, cut.file);
  // Each attempt overwrites the temporary file; only the last is renamed into place.
  const budget = await writeThenRename(output, (partial) =>
    encodeWithinBudget(async (crf) => {
      encodeFinal(silent, music, partial, crf);
      return (await stat(partial)).size;
    }, MAX_MP4_BYTES)
  );
  const crf = crfSummary(cut.file, budget, MAX_MP4_BYTES);
  report.push(crf.line);
  if (crf.problem !== undefined) problems.push(crf.problem);
  const format = FORMATS[cut.format];
  const probed = probe(output);
  problems.push(
    ...videoProblems(cut.format, probed, {
      width: format.width,
      height: format.height,
      minSeconds: 55,
      maxSeconds: 65,
      maxBytes: MAX_MP4_BYTES
    })
  );
  const video = probed.streams.find((s) => s.codec_type === "video");
  const audio = probed.streams.find((s) => s.codec_type === "audio");
  const duration = parseNumber(probed.format.duration);
  const size = parseNumber(probed.format.size);
  report.push(
    `${cut.file}: ${duration === undefined ? "unreadable" : duration.toFixed(1)} s (55 to 65), ${size === undefined ? "unreadable" : (size / 1e6).toFixed(2)} MB (max ${(MAX_MP4_BYTES / 1e6).toFixed(1)}), ${String(video?.codec_name)} ${String(video?.width)}x${String(video?.height)} (h264 ${String(format.width)}x${String(format.height)}), audio ${String(audio?.codec_name)}`
  );
  report.push(
    `${cut.file}: colour ${String(video?.color_space)} / ${String(video?.color_primaries)} / ${String(video?.color_transfer)}, range ${String(video?.color_range)} (bt709 / bt709 / bt709, tv)`
  );
  const lufs = loudness(output);
  report.push(`${cut.file}: ${lufs.toFixed(1)} LUFS integrated`);
  if (Math.abs(lufs - LUFS_TARGET) > LUFS_TOLERANCE)
    problems.push(`${cut.file}: ${lufs.toFixed(1)} LUFS, not about ${String(LUFS_TARGET)}.`);
  await writeThenRename(join(OUT, cut.poster), (partial) => {
    still(output, posterAt, partial);
  });

  // A still at the middle of every caption, to review without playing the video.
  const dir = join(OUT, STILLS, cut.format);
  await mkdir(dir, { recursive: true });
  for (const timed of timeline.scenes) {
    const name = `${String(timed.index + 1).padStart(2, "0")}-${timed.scene.id}.png`;
    await writeThenRename(join(dir, name), (partial) => {
      still(output, seconds(timed.startFrame + timed.frames / 2), partial);
    });
  }
}

// The README's GIF: the zoom onto the lost phone, from the 16:9 cut.
const gifPath = join(OUT, GIF);
await writeThenRename(gifPath, async (partial) => {
  for (const colors of [128, 64]) {
    gif(
      join(OUT, CUTS[0]?.file ?? ""),
      seconds(phone.startFrame),
      seconds(phone.startFrame + phone.frames),
      colors,
      partial
    );
    if ((await stat(partial)).size <= MAX_GIF_BYTES) break;
  }
});
const gifBytes = (await stat(gifPath)).size;
report.push(`${GIF}: ${(gifBytes / 1e6).toFixed(2)} MB`);
if (gifBytes > MAX_GIF_BYTES)
  problems.push(`${GIF}: ${(gifBytes / 1e6).toFixed(2)} MB, over 2 MB.`);

await writeFile(join(OUT, TRANSCRIPT), transcript(SCENES));
const summary = [
  ...report,
  "",
  problems.length === 0 ? "All checks pass." : `Problems:\n  ${problems.join("\n  ")}`
].join("\n");
await writeFile(join(OUT, REPORT), `${summary}\n`);
console.log(`\n${summary}\n\n  ${OUT}`);
if (problems.length > 0) process.exitCode = 1;
