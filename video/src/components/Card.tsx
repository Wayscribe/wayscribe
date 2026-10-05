import { AbsoluteFill } from "remotion";
import type { CardScene, Format } from "../scenes";
import { FONT, INK, MUTED, PAPER } from "../theme";

export const Card = ({ scene, format }: { scene: CardScene; format: Format }) => {
  const square = format.id === "square";
  const [title, line, ...rest] = scene.lines;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        color: PAPER,
        fontFamily: FONT,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: square ? 72 : 160
      }}
    >
      {scene.layout === "statement"
        ? scene.lines.map((text) => (
            <div
              key={text}
              style={{ fontSize: square ? 60 : 72, fontWeight: 600, lineHeight: 1.3 }}
            >
              {text}
            </div>
          ))
        : [
            <div key="title" style={{ fontSize: square ? 96 : 120, fontWeight: 700 }}>
              {title}
            </div>,
            <div
              key="line"
              style={{
                marginTop: 32,
                fontSize: square ? 40 : 48,
                fontWeight: 600,
                lineHeight: 1.3,
                maxWidth: 1400
              }}
            >
              {line}
            </div>,
            ...rest.map((text) => (
              <div key={text} style={{ marginTop: 24, fontSize: square ? 34 : 40, color: MUTED }}>
                {text}
              </div>
            ))
          ]}
    </AbsoluteFill>
  );
};
