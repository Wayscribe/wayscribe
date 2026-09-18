import { expect, test } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * F-044: the event detail shows the metadata the API returns, as text.
 *
 * Stamped per run, so the event is new each time and its content can change
 * without an id conflict.
 */
const RUN = Date.now().toString(36);
const JOURNEY_ID = `jrn_e2e_metadata_${RUN}`;
const MARKUP = '<img src="x" onerror="window.__metadataInjected=1">';

interface InjectedWindow extends Window {
  __metadataInjected?: number;
}

test.beforeAll(async () => {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id: `evt_metadata_${RUN}`,
        journeyId: JOURNEY_ID,
        environment: "development",
        service: "hubspot-sync",
        entity: { type: "lead", id: `E2E-METADATA-${RUN}` },
        operation: "delivered",
        name: "push-hubspot",
        timestamp: new Date().toISOString(),
        metadata: { httpStatus: 429, retryDelayMs: 1200, note: MARKUP },
        deployment: { version: "2.4.1", gitCommit: "abc1234" },
        runtime: { language: "node", hostname: "worker-3" }
      }
    })
  });
  expect(response.ok, `seeding answered ${String(response.status)}`).toBe(true);
});

test("the event detail lists the step's metadata, and markup in it stays text", async ({
  page
}) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);

  await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
  const custom = page.getByRole("group", { name: "Custom" });
  await expect(custom.getByRole("term")).toHaveText(["httpStatus", "note", "retryDelayMs"]);
  await expect(custom.getByRole("definition")).toHaveText(["429", MARKUP, "1200"]);
  await expect(page.getByRole("group", { name: "Deployment" })).toContainText("2.4.1");
  await expect(page.getByRole("group", { name: "Runtime" })).toContainText("worker-3");

  await expect(custom.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as InjectedWindow).__metadataInjected)).toBeUndefined();
});
