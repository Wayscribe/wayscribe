import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * ADR-063, F-047: a failed journey names the step that failed it, which a
 * later successful step no longer hides, in the Journeys table, on the
 * journey page and in search. What an API without `failedStep` shows is the
 * unit tests' (JourneyRow, JourneyListItem, the events proxy). Stamped per
 * run: the list shows recent activity.
 */
const RUN = Date.now().toString(36);
const SERVICE = `e2e-failed-step-${RUN}`;
const BASE = Date.now();

/** F-047's journey: the push failed, and the retry's first two steps followed it. */
const RETRIED = {
  journeyId: `jrn_e2e_failed_step_${RUN}`,
  entityId: `E2E-FAILED-STEP-${RUN}`,
  steps: [
    ["take-job", "received"],
    ["map-hubspot", "transformed"],
    ["push-hubspot", "failed"],
    ["take-job", "received"],
    ["map-hubspot", "transformed"]
  ]
} as const;
/** A journey that never failed: its row shows its last step, as before. */
const COMPLETED = {
  journeyId: `jrn_e2e_failed_step_done_${RUN}`,
  entityId: `E2E-FAILED-STEP-DONE-${RUN}`,
  steps: [
    ["take-job", "received"],
    ["push-hubspot", "completed"]
  ]
} as const;

async function post(
  journey: { journeyId: string; entityId: string },
  index: number,
  name: string,
  operation: string,
  at: number
): Promise<void> {
  const id = `evt_${journey.journeyId}_${String(index)}`;
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
        entity: { type: "lead", id: journey.entityId },
        operation,
        name,
        timestamp: new Date(at).toISOString()
      }
    })
  });
  expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
}

test.beforeAll(async () => {
  // A minute ago, a second apart: finished, and too old to follow live.
  for (const journey of [RETRIED, COMPLETED]) {
    for (const [index, [name, operation]] of journey.steps.entries()) {
      await post(journey, index, name, operation, BASE - 60_000 + index * 1000);
    }
  }
});

async function checkRows(page: Page): Promise<void> {
  await page.goto(`/journeys?service=${SERVICE}`);
  await expect(page.getByRole("columnheader").nth(5)).toHaveAccessibleName("Step");

  const retried = page.locator("tbody tr", { hasText: `lead: ${RETRIED.entityId}` });
  const step = retried.locator("td.col-step");
  await expect(step).toHaveText("push-hubspot");
  await expect(step).toHaveAttribute("class", "col-step failed");
  await expect(step).toHaveAttribute("title", "Failed at push-hubspot; last step map-hubspot");

  const completed = page
    .locator("tbody tr", { hasText: `lead: ${COMPLETED.entityId}` })
    .locator("td.col-step");
  await expect(completed).toHaveText("push-hubspot");
  await expect(completed).toHaveAttribute("class", "col-step");
  await expect(completed).toHaveAttribute("title", "push-hubspot");
}

async function checkSummary(page: Page): Promise<void> {
  await page.goto(`/journeys/${RETRIED.journeyId}`);
  const expected = "failed at push-hubspot";
  await expect(page.locator("p[aria-live=polite]")).toHaveText(
    `${expected} · 5 events · ${SERVICE}`
  );
}

async function checkSearch(page: Page): Promise<void> {
  await page.goto(`/?q=${RETRIED.entityId}`);
  const status = page
    .getByRole("listitem")
    .filter({ hasText: `lead: ${RETRIED.entityId}` })
    .locator(".status");
  await expect(status).toHaveAttribute("class", "status failed");
  await expect(status).toHaveText("failed at push-hubspot");
}

test("the Journeys table names the step that failed a journey", async ({ page }) => {
  await signIn(page, RETRIED.journeyId);
  await checkRows(page);
});

test("the journey page's summary line says which step it failed at", async ({ page }) => {
  await signIn(page, RETRIED.journeyId);
  await checkSummary(page);
});

test("a search result says which step it failed at", async ({ page }) => {
  await signIn(page, RETRIED.journeyId);
  await checkSearch(page);
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the table, the summary line and search say the same", async ({ page }) => {
    await signIn(page, RETRIED.journeyId);
    await checkRows(page);
    await checkSummary(page);
    await checkSearch(page);
  });
});

/**
 * Live mode: the failure arrives while the page is open, and the summary line
 * names its step on the same poll that brings the status, through the web's
 * events proxy.
 */
test("a followed journey's summary line learns the failed step with its status", async ({
  page
}) => {
  const live = { journeyId: `jrn_e2e_failed_step_live_${RUN}`, entityId: `E2E-FS-LIVE-${RUN}` };
  const now = Date.now();
  await post(live, 0, "take-job", "received", now);
  await signIn(page, live.journeyId);
  await page.goto(`/journeys/${live.journeyId}`);
  const line = page.locator("p[aria-live=polite]");
  await expect(page.getByRole("checkbox", { name: "Live" })).toBeChecked();
  await expect(line).toHaveText(`active · 1 event · ${SERVICE}`);

  // Every poll the page makes from here on, to read what the proxy sent.
  const polled: unknown[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === `/api/journeys/${live.journeyId}/events`) {
      polled.push(response.json());
    }
  });

  await post(live, 1, "push-hubspot", "failed", now + 1000);
  await post(live, 2, "take-job", "received", now + 2000);

  const expected = "failed at push-hubspot";
  // One text, so the status and the count came from the same render.
  await expect(line).toHaveText(`${expected} · 3 events · ${SERVICE}`, { timeout: 15_000 });

  const bodies = (await Promise.all(polled)) as Record<string, unknown>[];
  const last = bodies.at(-1);
  expect(last?.["journeyStatus"]).toBe("failed");
  expect(last?.["journeyFailedStep"]).toBe("push-hubspot");
});
