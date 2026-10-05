import { useMemo } from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import type { Capture } from "./capture";
import { CaptureView } from "./components/CaptureView";
import { Card } from "./components/Card";
import { FORMATS, type FormatId, SCENES } from "./scenes";
import { INK } from "./theme";
import { buildTimeline, FADE_FRAMES, type Timeline, type TimedScene } from "./timeline";

export type DemoProps = { capture: Capture; format: FormatId };

export const Demo = ({ capture, format }: DemoProps) => {
  const timeline = useMemo(() => buildTimeline(SCENES, capture), [capture]);
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      {timeline.scenes.map((timed) => {
        const last = timed.index === timeline.scenes.length - 1;
        // Each scene stays on screen, frozen on its last frame, while the next fades in over it.
        return (
          <Sequence
            key={timed.scene.id}
            from={timed.startFrame}
            durationInFrames={timed.frames + (last ? 0 : FADE_FRAMES)}
          >
            <SceneView timed={timed} timeline={timeline} capture={capture} format={format} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const SceneView = ({
  timed,
  timeline,
  capture,
  format
}: {
  timed: TimedScene;
  timeline: Timeline;
  capture: Capture;
  format: FormatId;
}) => {
  const local = useCurrentFrame();
  const frame = Math.min(local, timed.frames - 1);
  const glides = timed.scene.kind === "capture" && timed.scene.enter === "glide";
  const opacity =
    timed.index === 0 || glides
      ? 1
      : interpolate(local, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity }}>
      {timed.scene.kind === "card" ? (
        <Card scene={timed.scene} format={FORMATS[format]} />
      ) : (
        <CaptureView
          timed={timed}
          timeline={timeline}
          capture={capture}
          format={FORMATS[format]}
          frame={frame}
        />
      )}
    </AbsoluteFill>
  );
};
