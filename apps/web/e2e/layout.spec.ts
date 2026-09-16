import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * Long names do not widen the page.
 *
 * A step name may be 256 characters, a service name 128 and an entity id 512
 * (packages/protocol event schema). A review found that a 68-character step
 * name made timeline rows 505 px wide on a 400 px screen, a 256-character one
 * made the page 2,725 px wide, and a long service name widened the page to
 * 3,250 px even at 1280 px, through the filter chips and the event heading.
 */

// Versioned for the reason journey.spec.ts gives: an event is immutable.
const VERSION = "v1";
const JOURNEY_ID = `jrn_e2e_layout_${VERSION}`;
const STEP = `step-${"n".repeat(250)}`;
const SERVICE = `svc-${"s".repeat(124)}`;
const ENTITY = `layout-${"e".repeat(300)}-${VERSION}`;

async function seed(): Promise<void> {
  const events = [
    { id: `evt_layout_${VERSION}_1`, name: STEP, service: SERVICE, time: "08:00:00" },
    { id: `evt_layout_${VERSION}_2`, name: "short-step", service: "job-sweep", time: "08:00:01" }
  ];
  for (const { id, name, service, time } of events) {
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id,
          journeyId: JOURNEY_ID,
          environment: "development",
          service,
          entity: { type: "job_posting", id: ENTITY },
          operation: "delivered",
          name,
          timestamp: `2026-09-16T${time}.000Z`,
          input: { a: 1 },
          output: { a: 2 }
        }
      })
    });
    expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
  }
}

test.beforeAll(seed);

/** How far the page scrolls sideways, in pixels. Zero is the goal. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

for (const width of [400, 1280]) {
  test(`a journey with long names does not scroll sideways at ${String(width)} px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, JOURNEY_ID);
    await page.goto(`/journeys/${JOURNEY_ID}?event=evt_layout_${VERSION}_1`);
    await expect(page.getByRole("heading", { level: 2, name: STEP })).toBeVisible();
    await expect(page.locator(".timeline li .step").first()).toHaveText(STEP);

    expect(await horizontalOverflow(page)).toBe(0);

    // The row keeps to its column and cuts the name, rather than wrapping it.
    const row = page.locator(".timeline li").first();
    const rowBox = await row.boundingBox();
    const list = await page.locator(".timeline").boundingBox();
    expect(rowBox?.width).toBeLessThanOrEqual(list?.width ?? 0);
    const cut = await page
      .locator(".timeline li .step")
      .first()
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(cut).toBe(true);
  });
}
