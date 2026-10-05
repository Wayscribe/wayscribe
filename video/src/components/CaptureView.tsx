import { AbsoluteFill, Img, staticFile } from "remotion";
import { PAGE_BACKGROUND, project, projectBox, sceneCamera } from "../camera";
import { boxOf, type Capture, frameAt } from "../capture";
import { cursorAt, rippleAt, showsCursor } from "../cursor";
import type { CaptureScene, Format } from "../scenes";
import { highlightFrame, sourceMsAt, type Timeline, type TimedScene } from "../timeline";
import { Caption } from "./Caption";
import { Cursor } from "./Cursor";
import { Highlight } from "./Highlight";

export const CaptureView = ({
  timed,
  timeline,
  capture,
  format,
  frame
}: {
  timed: TimedScene;
  timeline: Timeline;
  capture: Capture;
  format: Format;
  frame: number;
}) => {
  const scene = timed.scene as CaptureScene;
  const ms = sourceMsAt(timed, frame, timeline.fps);
  const camera = sceneCamera(timeline, timed.index, frame, format, capture);
  const shown = frameAt(capture.frames, ms);
  const { width, height } = capture.viewport;
  const s = capture.scale;
  const start = { x: width / 2, y: height / 2 };
  const ripple = rippleAt(capture.clicks, ms);
  // The image is placed by the camera window alone (a plain transform, no
  // object-fit), so a window that leaves the page shows PAGE_BACKGROUND there.
  return (
    <AbsoluteFill style={{ backgroundColor: PAGE_BACKGROUND, overflow: "hidden" }}>
      <Img
        src={staticFile(`capture/${shown.file}`)}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: width * s,
          height: height * s,
          transformOrigin: "0 0",
          transform: `scale(${String(camera.zoom / s)}) translate(${String(-camera.x * s)}px, ${String(-camera.y * s)}px)`
        }}
      />
      {scene.highlight === undefined ? null : (
        <Highlight
          box={projectBox(camera, boxOf(capture, scene.highlight.mark, scene.highlight.box))}
          tone={scene.highlight.tone}
          frame={frame}
          at={highlightFrame(timed, capture, timeline.fps)}
        />
      )}
      {showsCursor(capture.clicks, timed.fromMs, timed.spanMs) ? (
        <Cursor
          at={project(camera, cursorAt(capture.clicks, ms, start))}
          ripple={
            ripple === undefined
              ? undefined
              : { ...project(camera, ripple), progress: ripple.progress }
          }
        />
      ) : null}
      <Caption text={scene.caption} format={format} frame={frame} />
    </AbsoluteFill>
  );
};
