import { type Capture, findMark, markNamed } from "./capture";
import { FPS, type Scene } from "./scenes";

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
      rate = Math.max(1, spanMs / outMs);
      if (rate > MAX_RATE) {
        throw new Error(
          `Scene "${scene.id}" would play ${String(spanMs)} ms of capture at ${rate.toFixed(2)}x, above ${String(MAX_RATE)}x. Lengthen the scene or tighten the capture.`
        );
      }
      holdMs = Math.max(0, outMs - spanMs);
      if (scene.tick === true) ticks.push((startFrame + GLIDE_FRAMES) / fps);
    }
    timed.push({ scene, index, startFrame, frames, fromMs, spanMs, holdMs, rate });
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

/** The frame within a capture scene that first shows capture moment `ms`. */
export function frameAtSourceMs(t: TimedScene, ms: number, fps = FPS): number {
  if (ms <= t.fromMs) return 0;
  const u = t.holdMs + (Math.min(ms, t.fromMs + t.spanMs) - t.fromMs) / t.rate;
  return Math.round((u / 1000) * fps);
}
