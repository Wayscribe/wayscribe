import { interpolate } from "remotion";
import type { Box } from "../geometry";
import { KEPT, LOST } from "../theme";

/** Outlines the subject once the camera has arrived, and dims the rest of the page a little. */
export const Highlight = ({
  box,
  tone,
  frame,
  at
}: {
  box: Box;
  tone: "lost" | "kept";
  frame: number;
  at: number;
}) => {
  const p = interpolate(frame, [at, at + 9], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const pad = 8;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x - pad,
        top: box.y - pad,
        width: box.width + 2 * pad,
        height: box.height + 2 * pad,
        border: `5px solid ${tone === "lost" ? LOST : KEPT}`,
        borderRadius: 12,
        opacity: p,
        transform: `scale(${String(1.06 - 0.06 * p)})`,
        boxShadow: `0 0 0 9999px rgba(15, 23, 42, ${String(0.18 * p)})`
      }}
    />
  );
};
