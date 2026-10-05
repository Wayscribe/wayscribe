// Renders a still at the middle of every scene in both formats, for review
// while building: pnpm --dir video exec tsx scripts/preview-stills.ts --capture <dir> --out <dir>
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { SCENES } from "../src/scenes";
import { buildTimeline } from "../src/timeline";
import { prepareBundle, readCapture } from "./bundle";

const { values } = parseArgs({ options: { capture: { type: "string" }, out: { type: "string" } } });
if (values.capture === undefined || values.out === undefined)
  throw new Error("Pass --capture and --out.");
const capture = await readCapture(values.capture);
const timeline = buildTimeline(SCENES, capture);
const serveUrl = await prepareBundle(values.capture, values.out);
// One browser for every still, so each does not start and stop its own.
const puppeteerInstance = await openBrowser("chrome");
try {
  for (const [id, format] of [
    ["DemoWide", "wide"],
    ["DemoSquare", "square"]
  ] as const) {
    const inputProps = { capture, format };
    const composition = await selectComposition({
      serveUrl,
      id,
      inputProps,
      puppeteerInstance
    });
    const dir = join(values.out, "preview", format);
    await mkdir(dir, { recursive: true });
    for (const timed of timeline.scenes) {
      const frame = timed.startFrame + Math.floor(timed.frames / 2);
      const output = join(dir, `${String(timed.index + 1).padStart(2, "0")}-${timed.scene.id}.png`);
      await renderStill({
        composition,
        serveUrl,
        output,
        frame,
        inputProps,
        imageFormat: "png",
        puppeteerInstance
      });
      console.log(`  ${output}`);
    }
  }
} finally {
  await puppeteerInstance.close({ silent: true });
}
