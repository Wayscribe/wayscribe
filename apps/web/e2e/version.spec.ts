import { expect, test } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

const JOURNEY_ID = `jrn_e2e_version_${Date.now().toString(36)}`;

// signIn picks the project holding a journey when there is more than one, so
// the suite's key writes one here.
test.beforeAll(async () => {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id: `evt_${JOURNEY_ID}`,
        journeyId: JOURNEY_ID,
        environment: "development",
        service: "e2e-version",
        entity: { type: "customer", id: JOURNEY_ID },
        operation: "received",
        name: "receive",
        timestamp: new Date().toISOString()
      }
    })
  });
  expect(response.ok, `seeding answered ${String(response.status)}`).toBe(true);
});

/**
 * F-045: every signed-in page says what the web app and the API are running,
 * and the API's half is what its /ready says.
 */
test("the version line names the web app's version and the API's", async ({ page }) => {
  const ready = (await (await fetch(`${API_URL}/ready`)).json()) as {
    version: string;
    source: string;
  };

  await signIn(page, JOURNEY_ID);
  for (const path of ["/", "/journeys"]) {
    await page.goto(path);
    const footer = page.getByRole("contentinfo");
    await expect(footer).toContainText(/^Web \S+/);
    await expect(footer).toContainText(`API ${ready.version}`);
    await expect(footer).not.toContainText("unknown");
  }
});
