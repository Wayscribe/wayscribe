import { loadFont } from "@remotion/fonts";
import { Composition, staticFile } from "remotion";
import type { Capture } from "./capture";
import { Demo, type DemoProps } from "./Demo";
import sample from "./fixtures/capture.json";
import { FORMATS, FPS, SCENES } from "./scenes";
import { FONT } from "./theme";
import { buildTimeline } from "./timeline";

// Inter (SIL OFL 1.1, @fontsource/inter), copied into the render's public
// directory by scripts/bundle.ts. Nothing is fetched from a font host.
for (const weight of ["400", "600", "700"]) {
  void loadFont({
    family: FONT,
    url: staticFile(`fonts/inter-latin-${weight}-normal.woff2`),
    weight
  });
}

const calculateMetadata = ({ props }: { props: DemoProps }) => ({
  durationInFrames: buildTimeline(SCENES, props.capture, FPS).totalFrames
});

export const Root = () => (
  <>
    <Composition
      id="DemoWide"
      component={Demo}
      width={FORMATS.wide.width}
      height={FORMATS.wide.height}
      fps={FPS}
      durationInFrames={1}
      defaultProps={{ capture: sample as Capture, format: "wide" }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="DemoSquare"
      component={Demo}
      width={FORMATS.square.width}
      height={FORMATS.square.height}
      fps={FPS}
      durationInFrames={1}
      defaultProps={{ capture: sample as Capture, format: "square" }}
      calculateMetadata={calculateMetadata}
    />
  </>
);
