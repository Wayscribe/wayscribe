import { type Capture, findMark, markNamed } from "./capture";
import { type CaptureScene, FPS, type Scene } from "./scenes";

/** Fastest a scene may play its capture. */
export const MAX_RATE = 3;
/** How long the camera takes to arrive on a shot (0.8 s). */
export const GLIDE_FRAMES = 24;
/** How long a scene takes to fade in over the previous one (0.3 s). */
export const FADE_FRAMES = 9;

export type TimedScene = {
  scene: Scene;
  index: number;
  startFrame: number;
  frames: number;
  /** Capture scenes only: where the source window opens, how long it runs, how long the opening holds, how fast it plays. */
  fromMs: number;
  spanMs: number;
  holdMs: number;
  rate: number;
};

/** `ticks` are when each tick sounds, in seconds from the start of the video. */
export type Timeline = { fps: number; totalFrames: number; scenes: TimedScene[]; ticks: number[] };

/** Every mark and box the scenes refer to that the capture lacks, as sentences. */
export function missingForScenes(scenes: readonly Scene[], capture: Capture): string[] {
  const problems: string[] = [];
  const needMark = (scene: Scene, name: string) => {
    if (findMark(capture, name) === undefined)
      problems.push(`Scene "${scene.id}": the capture has no mark "${name}".`);
  };
  const needBox = (scene: Scene, mark: string, box: string) => {
    const found = findMark(capture, mark);
    if (found !== undefined && found.boxes[box] === undefined) {
      problems.push(`Scene "${scene.id}": mark "${mark}" has no box "${box}".`);
    }
  };
  for (const scene of scenes) {
    if (scene.kind !== "capture") continue;
    needMark(scene, scene.from);
    if (scene.until !== undefined) needMark(scene, scene.until);
    for (const shots of Object.values(scene.shots)) {
      for (const shot of shots) {
        needMark(scene, shot.mark);
        needBox(scene, shot.mark, shot.box);
      }
    }
    if (scene.highlight !== undefined) {
      needMark(scene, scene.highlight.mark);
      needBox(scene, scene.highlight.mark, scene.highlight.box);
    }
  }
  return problems;
}

/**
 * Each shot's camera glide takes GLIDE_FRAMES from the shot's first frame, and
 * the next glide starts from the finished view of this one. So a shot may start
 * no sooner than GLIDE_FRAMES after the one before it, or the camera would jump
 * from where it had got to the view it never reached. The opening shot's glide
 * starts on the scene's first frame, whatever its mark, so the second shot is
 * measured from frame 0: this covers the glide in from the previous scene or
 * the widest view alike. Shots out of order (a negative gap) fail the same way.
 */
function checkShotSpacing(scene: CaptureScene, timed: TimedScene, capture: Capture, fps: number) {
  for (const [format, shots] of Object.entries(scene.shots)) {
    let before = 0;
    for (const [i, shot] of shots.entries()) {
      // The camera starts the opening shot at frame 0 and every other at its mark.
      const start = i === 0 ? 0 : frameAtSourceMs(timed, markNamed(capture, shot.mark).at, fps);
      if (i > 0 && start - before < GLIDE_FRAMES) {
        throw new Error(
          `Scene "${scene.id}": its shot on mark "${shot.mark}" (${format}) starts on frame ${String(start)}, less than ${String(GLIDE_FRAMES)} frames after frame ${String(before)}, where the shot before it starts its glide. Move the mark, or drop the shot.`
        );
      }
      before = start;
    }
  }
}

export function buildTimeline(scenes: readonly Scene[], capture: Capture, fps = FPS): Timeline {
  const problems = missingForScenes(scenes, capture);
  if (problems.length > 0) {
    throw new Error(`The capture does not cover the scenes:\n  ${problems.join("\n  ")}`);
  }
  const timed: TimedScene[] = [];
  const ticks: number[] = [];
  let startFrame = 0;
  for (const [index, scene] of scenes.entries()) {
    const frames = Math.round(scene.seconds * fps);
    if (!(frames > 0)) {
      throw new Error(
        `Scene "${scene.id}" lasts ${String(scene.seconds)} s, ${String(frames)} frames at ${String(fps)} fps, and needs at least one.`
      );
    }
    const outMs = (frames / fps) * 1000;
    let fromMs = 0;
    let spanMs = 0;
    let holdMs = outMs;
    let rate = 1;
    if (scene.kind === "capture") {
      fromMs = markNamed(capture, scene.from).at;
      const untilMs = scene.until === undefined ? fromMs : markNamed(capture, scene.until).at;
      spanMs = untilMs - fromMs;
      if (spanMs < 0)
        throw new Error(
          `Scene "${scene.id}": mark "${String(scene.until)}" comes before "${scene.from}".`
        );
      for (const shots of Object.values(scene.shots)) {
        for (const shot of shots) {
          const at = markNamed(capture, shot.mark).at;
          if (at < fromMs || at > untilMs) {
            throw new Error(
              `Scene "${scene.id}": its shot on mark "${shot.mark}" falls outside the scene.`
            );
          }
        }
      }
      if (scene.highlight !== undefined) {
        const at = markNamed(capture, scene.highlight.mark).at;
        if (at < fromMs || at > untilMs) {
          throw new Error(
            `Scene "${scene.id}": its highlight on mark "${scene.highlight.mark}" falls outside the scene.`
          );
        }
      }
      rate = Math.max(1, spanMs / outMs);
      if (rate > MAX_RATE) {
        throw new Error(
          `Scene "${scene.id}" would play ${String(spanMs)} ms of capture at ${rate.toFixed(2)}x, above ${String(MAX_RATE)}x. Lengthen the scene or tighten the capture.`
        );
      }
      holdMs = Math.max(0, outMs - spanMs);
    }
    const entry: TimedScene = { scene, index, startFrame, frames, fromMs, spanMs, holdMs, rate };
    if (scene.kind === "capture" && (scene.highlight !== undefined || scene.tick === true)) {
      // The highlight (and the tick) wait a glide after their mark shows, and nothing
      // else stops that glide running past the scene's end, where it would never appear.
      const at = highlightFrame(entry, capture, fps);
      if (at >= frames - 1) {
        const what =
          scene.highlight === undefined
            ? "its tick"
            : `its highlight on mark "${scene.highlight.mark}"`;
        throw new Error(
          `Scene "${scene.id}": ${what} would appear on frame ${String(at)}, at or past the scene's last frame (${String(frames - 1)}). Lengthen the scene, or move the mark earlier.`
        );
      }
      if (scene.tick === true) ticks.push((startFrame + at) / fps);
    }
    if (scene.kind === "capture") checkShotSpacing(scene, entry, capture, fps);
    timed.push(entry);
    startFrame += frames;
  }
  return { fps, totalFrames: startFrame, scenes: timed, ticks };
}

/** The capture moment shown `frame` frames into a capture scene: the opening held, then the action played. */
export function sourceMsAt(t: TimedScene, frame: number, fps = FPS): number {
  const u = (frame / fps) * 1000;
  if (u <= t.holdMs) return t.fromMs;
  return t.fromMs + Math.min(t.spanMs, (u - t.holdMs) * t.rate);
}

/**
 * The frame within a capture scene that first shows capture moment `ms`: the
 * first frame at or after it, never past the scene's last frame. The small
 * allowance keeps float noise from pushing an exact frame time to the next one.
 */
export function frameAtSourceMs(t: TimedScene, ms: number, fps = FPS): number {
  if (ms <= t.fromMs) return 0;
  const u = t.holdMs + (Math.min(ms, t.fromMs + t.spanMs) - t.fromMs) / t.rate;
  return Math.min(t.frames - 1, Math.ceil((u / 1000) * fps - 1e-9));
}

/**
 * The frame within a capture scene at which its highlight appears, and so
 * where its tick sounds: one glide after the first frame that shows the
 * highlight's mark, once the camera has arrived. A scene with no highlight
 * measures from its opening mark. The highlight and the tick both come from
 * here, so they cannot drift apart.
 */
export function highlightFrame(t: TimedScene, capture: Capture, fps = FPS): number {
  if (t.scene.kind !== "capture") {
    throw new Error(`Scene "${t.scene.id}" is a card, and a card has no highlight.`);
  }
  const at =
    t.scene.highlight === undefined ? t.fromMs : markNamed(capture, t.scene.highlight.mark).at;
  return frameAtSourceMs(t, at, fps) + GLIDE_FRAMES;
}
