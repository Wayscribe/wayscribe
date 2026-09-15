import { expect, test, type Page } from "@playwright/test";

const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const API_KEY = process.env["FLIGHT_API_KEY"] ?? "";

// Versioned like journey.spec.ts, and stamped per run as well. The Recent page
// lists journeys by recent activity, so these events have to be stamped now,
// and an ingested event is immutable: re-posting yesterday's ids with today's
// timestamps would conflict. The service name carries the stamp too, so the
// page can be narrowed to this run's two journeys on a database that holds
// earlier runs, the demo's failures, or anything else.
// Bump SEED_VERSION whenever the seeded shape below changes.
const SEED_VERSION = "v1";
const RUN = `${SEED_VERSION}_${Date.now().toString(36)}`;
const SERVICE = `e2e-recent-${RUN}`;
const FAILED = { journeyId: `jrn_e2e_recent_failed_${RUN}`, entityId: `E2E-RECENT-FAILED-${RUN}` };
const COMPLETED = {
  journeyId: `jrn_e2e_recent_completed_${RUN}`,
  entityId: `E2E-RECENT-COMPLETED-${RUN}`
};

async function ingest(
  journey: { journeyId: string; entityId: string },
  operation: string,
  minutesAgo: number
): Promise<void> {
  const id = `evt_${journey.journeyId}`;
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId: journey.journeyId,
        environment: "development",
        service: SERVICE,
        entity: { type: "customer", id: journey.entityId },
        operation,
        name: `${operation}-step`,
        timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString()
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Seeding ${id} failed with ${String(response.status)}`);
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL("/");
}

test.beforeAll(async () => {
  // The completed journey is newer, so a list that ignored status would show it first.
  await ingest(FAILED, "failed", 10);
  await ingest(COMPLETED, "completed", 5);
});

test("starts from recent failures, widens to any status, and follows a row", async ({ page }) => {
  await signIn(page);

  await page.getByRole("link", { name: "No identifier? See recent failures" }).click();
  await expect(page).toHaveURL(/\/recent$/);
  await expect(page.locator(".recent-summary")).toHaveText(
    "Failed journeys in the last 24 hours, all environments"
  );

  // Narrowed to this run's service, so other failures on the database cannot
  // crowd these rows off the page.
  await page.fill("input[name=service]", SERVICE);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".recent-summary")).toHaveText(
    `Failed journeys in the last 24 hours, all environments, from ${SERVICE}`
  );
  const rows = page.locator(".results li");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(FAILED.entityId);
  await expect(rows.first()).toContainText("development");
  await expect(page.locator(".results")).not.toContainText(COMPLETED.entityId);

  await page.selectOption("select[name=status]", { label: "any" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/[?&]status=(&|$)/);
  await expect(page.locator(".recent-summary")).toHaveText(
    `Journeys in the last 24 hours, all environments, from ${SERVICE}`
  );
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(COMPLETED.entityId);
  await expect(rows.nth(1)).toContainText(FAILED.entityId);

  await page.getByRole("link", { name: `customer: ${FAILED.entityId}` }).click();
  await expect(page).toHaveURL(`/journeys/${FAILED.journeyId}`);
  await expect(page.locator("h1")).toHaveText(`customer: ${FAILED.entityId}`);
});
