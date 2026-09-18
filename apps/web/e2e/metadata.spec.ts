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

/**
 * A key the instrumented code chose can be any string, `__proto__` included.
 * The page shows an event two ways: rendered on the server on first load, and
 * fetched by the timeline when another step is chosen. A review found the
 * first way dropped this key and the second kept it, so the same event showed
 * different metadata depending on how it was reached.
 */
const PROTO_JOURNEY_ID = `jrn_e2e_metadata_proto_${RUN}`;

test.describe("a metadata key named __proto__", () => {
  test.beforeAll(async () => {
    for (const [index, metadata] of [
      '{"__proto__":"kept","queue":"jobs"}',
      '{"other":"step"}'
    ].entries()) {
      // Written as text: an object literal would read `__proto__` as its
      // prototype rather than as a key.
      const body = `{"protocolVersion":"0.1","event":{"id":"evt_metadata_proto_${RUN}_${String(index)}","journeyId":"${PROTO_JOURNEY_ID}","environment":"development","service":"job-sweep","entity":{"type":"lead","id":"E2E-PROTO-${RUN}"},"operation":"delivered","name":"step-${String(index)}","timestamp":"${new Date(Date.now() + index * 1000).toISOString()}","metadata":${metadata}}}`;
      const response = await fetch(`${API_URL}/v1/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        body
      });
      expect(response.ok, `seeding answered ${String(response.status)}`).toBe(true);
    }
  });

  test("is shown on first load and after choosing the step again", async ({ page }) => {
    await signIn(page, PROTO_JOURNEY_ID);
    const custom = page.getByRole("group", { name: "Custom" });

    await page.goto(`/journeys/${PROTO_JOURNEY_ID}?event=evt_metadata_proto_${RUN}_0`);
    await expect(custom.getByRole("term")).toHaveText(["__proto__", "queue"]);

    await page.getByRole("link", { name: /step-1/ }).click();
    await expect(custom.getByRole("term")).toHaveText(["other"]);
    await page.getByRole("link", { name: /step-0/ }).click();
    await expect(custom.getByRole("term")).toHaveText(["__proto__", "queue"]);
  });
});
