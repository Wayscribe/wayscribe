/**
 * Renders the brand images from their sources in `assets/brand/`.
 *
 *   pnpm brand
 *
 * The sources are SVG and are the thing to edit; these PNGs exist only because
 * GitLab's project avatar and every social preview want a raster. Rasterizing
 * here, with the Chromium the browser suite already installs, keeps the two in
 * step: nobody has to remember to re-export an icon by hand after changing the
 * mark.
 *
 * The text in `og.svg` is set in the system interface stack, so the words come
 * out in the interface font of whichever machine runs this. That is the same
 * stack the site and the product interface use, and it is why no font file is
 * committed and why the site still loads nothing from a font host.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = new URL("../", import.meta.url);
const at = (path) => fileURLToPath(new URL(path, root));

const OUTPUTS = [
  // The GitLab project avatar. 512 is what the upload form wants; 1024 is the
  // one to hand anything that asks for a larger icon.
  { source: "assets/brand/mark.svg", output: "assets/brand/mark-512.png", width: 512, height: 512 },
  {
    source: "assets/brand/mark.svg",
    output: "assets/brand/mark-1024.png",
    width: 1024,
    height: 1024
  },
  // The social preview. 1200x630 is what og:image wants.
  { source: "assets/brand/og.svg", output: "site/public/og.png", width: 1200, height: 630 }
];

const browser = await chromium.launch();

try {
  for (const { source, output, width, height } of OUTPUTS) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:transparent}` +
        `svg{display:block;width:${String(width)}px;height:${String(height)}px}</style>` +
        readFileSync(at(source), "utf8")
    );
    // The fonts, before the shutter: a screenshot taken mid-resolution sets the
    // headline in a fallback. Written as a string because it runs in the page,
    // where `document` exists, and this file's lint configuration is Node's.
    await page.evaluate("document.fonts.ready");
    await page.screenshot({ path: at(output), omitBackground: true });
    await page.close();
    console.log(`  ${output}  ${String(width)}x${String(height)}`);
  }
} finally {
  await browser.close();
}

console.log("\nDone. Regenerate any time with: pnpm brand");
