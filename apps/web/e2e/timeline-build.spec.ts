import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * F-043: each timeline row names the build that recorded it, so whether a
 * journey came from one build reads down the list, and a row whose event
 * carried no version or commit names none.
 *
 * Stamped per run, so the events are new each time.
 */
const RUN = Date.now().toString(36);
const JOURNEY_ID = `jrn_e2e_timeline_build_${RUN}`;
const COMMIT = "3cd2c2034c6d3607a2b8d047ab7758f96d7b5604";
const NEWER = "27f4d64e0c0bd6a5e8a4b2b9f0f1c2d3e4f5a6b7";

test.beforeAll(async () => {
  const steps = [
    { name: "receive", deployment: { version: "1.4.2", gitCommit: COMMIT } },
    { name: "transform", deployment: { version: "1.4.2", gitCommit: COMMIT } },
    { name: "deliver", deployment: { version: "1.5.0", gitCommit: NEWER } },
    { name: "notify" }
  ];
  for (const [index, step] of steps.entries()) {
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id: `evt_timeline_build_${RUN}_${String(index)}`,
          journeyId: JOURNEY_ID,
          environment: "development",
          service: "hubspot-sync",
          entity: { type: "lead", id: `E2E-TIMELINE-BUILD-${RUN}` },
          operation: "transformed",
          timestamp: new Date(Date.now() + index * 1000).toISOString(),
          ...step
        }
      })
    });
    expect(response.ok, `seeding ${step.name} answered ${String(response.status)}`).toBe(true);
  }
});

async function expectBuilds(page: Page): Promise<void> {
  const rows = page.locator(".timeline li");
  await expect(rows).toHaveCount(4);
  const builds = page.locator(".timeline li .build");
  await expect(builds).toHaveText([
    `1.4.2 · ${COMMIT.slice(0, 12)}`,
    `1.4.2 · ${COMMIT.slice(0, 12)}`,
    `1.5.0 · ${NEWER.slice(0, 12)}`
  ]);
  await expect(builds.nth(2)).toHaveAttribute(
    "title",
    `Recorded by version 1.5.0, commit ${NEWER}`
  );
  await expect(rows.nth(3).locator(".build")).toHaveCount(0);
}

test("each timeline row names the build that recorded it", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expectBuilds(page);
});

test("is in the server-rendered page, with JavaScript off", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expectBuilds(page);
  await context.close();
});
