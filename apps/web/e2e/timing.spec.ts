import { expect, test, type Locator, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

const RUN = Date.now().toString(36);
const SERVICE = `e2e-timing-${RUN}`;
const JOURNEY_ID = `jrn_e2e_timing_${RUN}`;
const ACTIVE_ID = `jrn_e2e_timing_active_${RUN}`;
const PAGED_ID = `jrn_e2e_timing_paged_${RUN}`;
const BASE = Date.now() - 30_000;

interface TimingSeed {
  suffix: string;
  operation: string;
  name: string;
  offsetMs: number;
  durationMs: number | null;
  host: string;
  metadata?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const EVENTS: TimingSeed[] = [
  {
    suffix: "publish",
    operation: "published",
    name: "publish-order",
    offsetMs: 0,
    durationMs: 100,
    host: "api-a"
  },
  {
    suffix: "consume",
    operation: "consumed",
    name: "consume-order",
    offsetMs: 1000,
    durationMs: 200,
    host: "worker-b",
    metadata: {
      queue: "orders",
      queueWaitMs: 800,
      queueWaitBasis: "initial-enqueue",
      attempt: 1,
      deliveryCount: 1
    }
  },
  {
    suffix: "attempt-1",
    operation: "failed",
    name: "call-target",
    offsetMs: 2000,
    durationMs: 100,
    host: "worker-b",
    metadata: {
      attempt: 1,
      retryGroup: `delivery-${RUN}`,
      targetHost: "api.example.test",
      httpStatusCode: 429,
      retryAfterMs: 5000
    },
    error: { message: "rate limited" }
  },
  {
    suffix: "attempt-2",
    operation: "retried",
    name: "call-target",
    offsetMs: 4100,
    durationMs: 0,
    host: "worker-b",
    metadata: {
      queue: "orders",
      queueWaitMs: 400,
      queueWaitBasis: "retry-ready",
      attempt: 2,
      retryGroup: `delivery-${RUN}`
    }
  },
  {
    suffix: "unlinked",
    operation: "failed",
    name: "dead-letter",
    offsetMs: 5000,
    durationMs: 0,
    host: "worker-b",
    metadata: { attempt: 3 }
  }
];

async function postEvent(event: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: "0.1", event })
  });
  expect(response.ok, `seeding ${String(event["id"])} answered ${String(response.status)}`).toBe(
    true
  );
}

test.beforeAll(async () => {
  for (const event of EVENTS) {
    await postEvent({
      id: `evt_e2e_timing_${event.suffix}_${RUN}`,
      journeyId: JOURNEY_ID,
      environment: "development",
      service: SERVICE,
      entity: { type: "order", id: `ORDER-${RUN}` },
      operation: event.operation,
      name: event.name,
      timestamp: new Date(BASE + event.offsetMs).toISOString(),
      durationMs: event.durationMs,
      runtime: { hostname: event.host },
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      ...(event.error === undefined ? {} : { error: event.error })
    });
  }
  await postEvent({
    id: `evt_e2e_timing_active_${RUN}`,
    journeyId: ACTIVE_ID,
    environment: "development",
    service: SERVICE,
    entity: { type: "order", id: `ACTIVE-${RUN}` },
    operation: "received",
    name: "waiting-order",
    timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    durationMs: 0
  });
  for (let index = 1; index <= 101; index += 1) {
    await postEvent({
      id: `evt_e2e_timing_paged_${String(index).padStart(3, "0")}_${RUN}`,
      journeyId: PAGED_ID,
      environment: "development",
      service: SERVICE,
      entity: { type: "order", id: `PAGED-${RUN}` },
      operation: "received",
      name: "paged-retry",
      timestamp: new Date(BASE + index).toISOString(),
      durationMs: 0,
      ...(index === 1 || index === 101
        ? {
            metadata: {
              attempt: index === 1 ? 1 : 2,
              retryGroup: `paged-${RUN}`
            }
          }
        : {})
    });
  }
});

const rowFor = (page: Page, journeyId: string): Locator =>
  page.locator(`tbody tr:has(a[href*="${journeyId}"])`);

test("presents recorded spans, gaps, queue evidence, and explicit retries", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys?service=${SERVICE}&minDurationMs=4999`);
  await expect(rowFor(page, JOURNEY_ID).locator(".col-span")).toHaveText("5 s");
  await expect(rowFor(page, ACTIVE_ID)).toHaveCount(0);

  await page.getByLabel("Recorded span over (ms)").fill("5000");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(0);

  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.getByText(/^Recorded span: 5 s/)).toBeVisible();
  await expect(page.getByText("Publish → consume gap: 900 ms")).toBeVisible();
  await expect(page.getByText(/different recorded hosts/).first()).toBeVisible();

  const retryGroup = page.getByRole("group", {
    name: `Recorded attempts for call-target, retry identity delivery-${RUN}`
  });
  await expect(retryGroup).toContainText(`retry identity delivery-${RUN}`);
  await expect(retryGroup.getByRole("link", { name: "Attempt 1" })).toBeVisible();
  await expect(retryGroup.getByText("failed", { exact: true })).toBeVisible();
  await expect(retryGroup.getByRole("link", { name: "Attempt 2" })).toBeVisible();
  await expect(retryGroup.getByText("observed retry delay 2 s")).toBeVisible();
  await expect(page.getByRole("group", { name: "Unlinked recorded attempts" })).toContainText(
    "cannot be safely linked"
  );

  await page.getByRole("option").filter({ hasText: "consume-order" }).getByRole("link").click();
  const context = page.getByRole("group", { name: "Operational context" });
  await expect(context).toContainText("800 ms (initial enqueue to attempt start)");
  await expect(context).toContainText("Recorded hostworker-b");

  await retryGroup.getByRole("link", { name: "Attempt 1" }).click();
  await expect(page.getByRole("group", { name: "Operational context" })).toContainText(
    "Requested Retry-After5 s"
  );
});

test("freezes an active inactivity cutoff through a detail return link", async ({ page }) => {
  await signIn(page, ACTIVE_ID);
  await page.goto(`/journeys?service=${SERVICE}`);
  await page.getByLabel("Active and inactive for (ms)").fill("300000");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("active");
  await expect(rowFor(page, ACTIVE_ID)).toBeVisible();

  await rowFor(page, ACTIVE_ID).getByRole("link").click();
  const back = page.getByRole("link", { name: "← Journeys" });
  await expect(back).toHaveAttribute("href", /inactiveForMs=300000/);
  await expect(back).toHaveAttribute("href", /inactiveBefore=/);
  await back.click();
  await expect(rowFor(page, ACTIVE_ID)).toBeVisible();
});

test("keeps timing evidence usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 });
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.getByText("Publish → consume gap: 900 ms")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBe(0);
});

test("removes the loaded-page retry limitation after pagination completes", async ({ page }) => {
  await signIn(page, PAGED_ID);
  await page.goto(`/journeys/${PAGED_ID}`);
  await expect(page.locator(".timeline li")).toHaveCount(100);
  await expect(
    page.getByText("Only loaded events are included; later attempts may exist.")
  ).toBeVisible();

  await page.getByRole("button", { name: "Show 1 more events" }).click();
  await expect(page.locator(".timeline li")).toHaveCount(101);
  await expect(
    page.getByText("Only loaded events are included; later attempts may exist.")
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /more events/ })).toHaveCount(0);
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("keeps timing presentation and event links available", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.goto(`/journeys/${JOURNEY_ID}`);
    await expect(page.getByText(/^Recorded span: 5 s/)).toBeVisible();
    await expect(page.getByText("Publish → consume gap: 900 ms")).toBeVisible();

    await page.getByRole("option").filter({ hasText: "consume-order" }).getByRole("link").click();
    await expect(page.getByRole("heading", { level: 2, name: "consume-order" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Operational context" })).toContainText(
      "800 ms (initial enqueue to attempt start)"
    );
  });
});
