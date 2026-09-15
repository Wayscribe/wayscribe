/**
 * Regenerates the screenshots in README.md.
 *
 * These are the only part of the README a reader takes in without reading, and
 * a stale one is worse than none — it shows a product that no longer exists.
 * Generating them from the running demo means they can be refreshed in one
 * command rather than recaptured by hand and quietly drifting.
 *
 *   docker compose -f infrastructure/compose.yaml \
 *     -f infrastructure/compose.demo.yaml up --build -d
 *   pnpm demo:trigger                         # something to look at
 *   pnpm screenshots
 *
 * Requires ADMIN_TOKEN and a stack on WEB_URL. Uses the same sign-in the
 * end-to-end suite uses.
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3000";
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "replace-for-local-development-0000";
const ENTITY_ID = process.env["ENTITY_ID"] ?? "0018Z00002ABC";
const PROJECT = process.env["PROJECT_NAME"] ?? "Demo";
const OUT = fileURLToPath(new URL("../docs/images/", import.meta.url));

// Wide enough that the timeline and the detail pane sit side by side, which is
// the layout worth showing; tall enough that the diff is not cut off.
const VIEWPORT = { width: 1280, height: 900 };

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

async function search() {
  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");
}

async function shot(name) {
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`  docs/images/${name}.png`);
}

try {
  await page.goto(`${WEB_URL}/login`);
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  await search();

  // With more than one project the first search asks which one. Choosing hands
  // the query back, so there is nothing to retype.
  if (page.url().includes("/projects")) {
    await page.locator("button", { hasText: PROJECT }).first().click();
    await page.waitForLoadState("networkidle");
  }

  await page.waitForSelector("a[href^='/journeys/']");
  await shot("search");

  await page.click("a[href^='/journeys/']");
  await page.waitForSelector("text=All times UTC");
  await shot("timeline");

  // The transformation is the step the whole product exists to show.
  await page
    .click("a[href*='?event=']:near(:text('transformed'))", { timeout: 5_000 })
    .catch(async () => {
      const transformed = page.locator("li:has-text('transformed') a").first();
      await transformed.click();
    });
  await page.waitForSelector("text=What changed");
  await shot("diff");

  console.log("\nDone. Regenerate any time with: pnpm screenshots");
} finally {
  await browser.close();
}
