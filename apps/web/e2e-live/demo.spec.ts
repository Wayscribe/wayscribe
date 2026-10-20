import { expect, test, type Page } from "@playwright/test";

/**
 * The public demo, checked from outside (ADR-073). Run by `pnpm test:live`
 * and the `live-demo` CI job against https://demo.wayscribe.dev, never by
 * `pnpm test:e2e`. Read-only: every request is a page load a visitor makes.
 *
 * The 3 px journeys link on phones was live until 0.2.4 because nothing
 * looked at the deployed demo in a browser; deploy/demo/smoke-check.sh reads
 * HTML and cannot see layout.
 */

// apps/demo/src/history.ts: PINNED_JOURNEY_ID and PINNED_TRANSFORM_EVENT_ID.
const PINNED_JOURNEY = "/journeys/jrn_demo_pinned_5550100";
const PINNED_TRANSFORM = `${PINNED_JOURNEY}?event=evt_demo_pinned_5550100_transform`;
const PAGES = ["/", "/journeys", PINNED_TRANSFORM] as const;

/** How far the page scrolls sideways, in pixels. Zero is the goal. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

async function open(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} answered`).toBe(200);
  await expect(page.getByText("Public demo. Read-only, sample data.")).toBeVisible();
}

for (const width of [375, 1440]) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const path of PAGES) {
      test(`${path} does not scroll sideways`, async ({ page }) => {
        await open(page, path);
        expect(await horizontalOverflow(page)).toBe(0);
      });
    }

    test("the pinned journey shows the lost phone and its likely cause", async ({ page }) => {
      await open(page, PINNED_TRANSFORM);
      await expect(page.locator(".diff tbody tr.lost", { hasText: "Phone → phone" })).toContainText(
        "value lost"
      );
      await expect(page.locator(".journey-likely-cause")).toContainText("Likely cause: phone");
    });
  });
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 900 } });

  test("every journey link is a full-width tap target", async ({ page }) => {
    await open(page, "/journeys");
    const links = page.locator("tbody td.col-shown a");
    expect(await links.count()).toBeGreaterThan(0);
    const small = await links.evaluateAll((all) =>
      all
        .map((link) => link.getBoundingClientRect())
        .filter((box) => box.height < 44 || box.width < 200)
        .map((box) => `${String(Math.round(box.width))}x${String(Math.round(box.height))}`)
    );
    expect(small).toEqual([]);
  });
});

test("the footer names the release the pipeline expects", async ({ page }) => {
  const expected = process.env["EXPECTED_VERSION"] ?? "";
  expect(expected, "set EXPECTED_VERSION to the release tag, such as v0.2.6").toMatch(
    /^v\d+\.\d+\.\d+$/
  );
  await open(page, "/journeys");
  const summary = page.locator("footer.site-footer summary");
  await expect(summary).toHaveText(`Wayscribe ${expected}`);
  // The title holds both sides, so a partial upgrade (one container newer
  // than the other) fails too.
  const title = (await summary.getAttribute("title")) ?? "";
  expect(title).toContain(`Web ${expected}, `);
  expect(title).toContain(`API ${expected}, `);
});
