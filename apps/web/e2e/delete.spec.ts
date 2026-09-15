import { expect, test } from "@playwright/test";

const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const API_KEY = process.env["FLIGHT_API_KEY"] ?? "";

// Its own journey, so deleting it cannot disturb journey.spec.ts. Versioned
// like that suite's seed: an ingested event is immutable, so changing what is
// posted under an existing id conflicts. After a passing run the journey is
// gone and the same ids can be posted again.
const SEED_VERSION = "v1";
const ENTITY_ID = `E2E-DELETE-ME-${SEED_VERSION.toUpperCase()}`;
const JOURNEY_ID = `jrn_e2e_delete_${SEED_VERSION}`;

async function seed(): Promise<void> {
  for (const [index, operation] of ["received", "failed"].entries()) {
    const id = `evt_delete_${SEED_VERSION}_${String(index + 1)}`;
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id,
          journeyId: JOURNEY_ID,
          environment: "development",
          service: "webhook-api",
          entity: { type: "customer", id: ENTITY_ID },
          operation,
          name: `${operation}-customer`,
          timestamp: `2026-08-07T10:00:0${String(index)}.000Z`
        }
      })
    });
    if (response.status === 409) {
      throw new Error(`Seeding ${id} conflicted with different content. Bump SEED_VERSION.`);
    }
    if (!response.ok) throw new Error(`Seeding ${id} failed with ${String(response.status)}`);
  }
}

test.beforeAll(seed);

test("deletes a journey through the confirmation page, and search no longer finds it", async ({
  page
}) => {
  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL("/");

  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await expect(page.locator(".results li")).toHaveCount(1);

  await page.goto(`/journeys/${JOURNEY_ID}`);
  await page.getByRole("link", { name: "Delete this journey" }).click();

  await expect(page).toHaveURL(`/journeys/${JOURNEY_ID}/delete`);
  const facts = page.locator(".facts");
  await expect(facts).toContainText(`customer: ${ENTITY_ID}`);
  await expect(facts).toContainText("development");
  await expect(facts).toContainText("2");
  await expect(page.locator("body")).toContainText("This cannot be undone.");

  await page.getByRole("button", { name: "Delete journey" }).click();

  await expect(page).toHaveURL("/?deleted=customer");
  await expect(page.getByRole("status")).toContainText("Deleted the customer journey.");

  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await expect(page.locator("body")).toContainText("Nothing matched");

  const response = await page.goto(`/journeys/${JOURNEY_ID}`);
  expect(response?.status()).toBe(404);
});
