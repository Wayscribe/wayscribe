import { interpolate } from "remotion";
import type { Format } from "../scenes";
import { FONT, INK, PAPER } from "../theme";

/** One idea per screen, large, on a solid backing, in the band the camera keeps clear. */
export const Caption = ({
  text,
  format,
  frame
}: {
  text: string;
  format: Format;
  frame: number;
}) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: format.captionBottom,
      display: "flex",
      justifyContent: "center",
      opacity: interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" })
    }}
  >
    <div
      style={{
        maxWidth: format.captionMaxWidth,
        padding: "20px 36px",
        borderRadius: 16,
        backgroundColor: INK,
        color: PAPER,
        fontFamily: FONT,
        fontWeight: 600,
        fontSize: format.captionPx,
        lineHeight: 1.25,
        textAlign: "center",
        // Evens the lines out, so a short tail ("lost it.") is not left under a full line.
        textWrap: "balance",
        boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)"
      }}
    >
      {text}
    </div>
  </div>
);
