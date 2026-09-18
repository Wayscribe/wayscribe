import { expect, test, type Locator } from "@playwright/test";
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

/**
 * The same, for payloads: a key named `__proto__` at any depth of the input,
 * the output or a changed value. A review measured every such key missing on
 * first load and present after a click.
 */
const PAYLOAD_JOURNEY_ID = `jrn_e2e_payload_proto_${RUN}`;

test.describe("a payload key named __proto__", () => {
  test.beforeAll(async () => {
    const events = [
      {
        name: "transform-0",
        operation: "transformed",
        payloads:
          ',"input":{"customer":{"__proto__":{"tier":"gold"},"name":"Ada"}}' +
          ',"output":{"customer":{"__proto__":{"tier":"gold"},"name":"Ada","extra":{"__proto__":"p","k":1}}}'
      },
      { name: "step-1", operation: "delivered", payloads: "" }
    ];
    for (const [index, { name, operation, payloads }] of events.entries()) {
      // Written as text, for the reason the metadata case above gives.
      const body = `{"protocolVersion":"0.1","event":{"id":"evt_payload_proto_${RUN}_${String(index)}","journeyId":"${PAYLOAD_JOURNEY_ID}","environment":"development","service":"job-sweep","entity":{"type":"lead","id":"E2E-PAYLOAD-PROTO-${RUN}"},"operation":"${operation}","name":"${name}","timestamp":"${new Date(Date.now() + index * 1000).toISOString()}"${payloads}}}`;
      const response = await fetch(`${API_URL}/v1/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
        body
      });
      expect(response.ok, `seeding answered ${String(response.status)}`).toBe(true);
    }
  });

  test("is shown in the payloads and the diff on first load and after choosing the step again", async ({
    page
  }) => {
    await signIn(page, PAYLOAD_JOURNEY_ID);
    const payload = (label: string): Locator =>
      page
        .locator(".split > div", { has: page.locator(".label", { hasText: label }) })
        .locator("pre");

    const expectKeys = async (): Promise<void> => {
      await expect(payload("Input")).toContainText('"__proto__": {');
      await expect(payload("Input")).toContainText('"tier": "gold"');
      await expect(payload("Output")).toContainText('"__proto__": "p"');
      // The stored diff's key order is the database's, so only the key is checked.
      await expect(page.locator("table.diff td.added")).toContainText('"__proto__":"p"');
    };

    const detail = page.locator("section", {
      has: page.getByRole("heading", { level: 2, name: "transform-0" })
    });

    await page.goto(`/journeys/${PAYLOAD_JOURNEY_ID}?event=evt_payload_proto_${RUN}_0`);
    await expectKeys();
    const firstLoad = await detail.innerText();

    await page.getByRole("link", { name: /step-1/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "step-1" })).toBeVisible();
    await page.getByRole("link", { name: /transform-0/ }).click();
    await expectKeys();
    // Both ways read the event through getEvent, so the text is the same.
    // Text, not markup: server-rendered HTML carries React's text separators.
    expect(await detail.innerText()).toBe(firstLoad);
  });
  test("is in the server-rendered page, with JavaScript off", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await signIn(page, PAYLOAD_JOURNEY_ID);
    await page.goto(`/journeys/${PAYLOAD_JOURNEY_ID}?event=evt_payload_proto_${RUN}_0`);
    const main = page.locator("main");
    await expect(main).toContainText('"tier": "gold"');
    await expect(main).toContainText('"__proto__": "p"');
    await expect(page.locator("table.diff td.added")).toContainText('"__proto__":"p"');
    await context.close();
  });
});
