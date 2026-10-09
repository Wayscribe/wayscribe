import { expect, test } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

// The demo triggers journeys under the bare Salesforce account id, so a seed
// that used it could not assert "exactly one result" on a database the demo had
// ever run against. The prefix makes this suite's customer its own.
//
// Journey, event, entity, and alias identifiers all carry SEED_VERSION because
// an ingested event is immutable: its content hash is taken over the event as
// received, so re-posting an event id with different content is a 409 conflict
// rather than an update, and an existing journey row keeps the entity id its
// first event wrote. The entity id and alias are versioned too, so the journeys
// earlier versions left behind never match this suite's exactly-one searches.
// Bump SEED_VERSION whenever the seeded data below changes.
const SEED_VERSION = "v4";
const ENTITY_ID = `E2E-0018Z00002ABC-${SEED_VERSION.toUpperCase()}`;
const ALIAS_VALUE = `SF-ALIAS-99001-${SEED_VERSION.toUpperCase()}`;
const JOURNEY_ID = `jrn_e2e_demo_${SEED_VERSION}`;

/** Survives client-side rendering and `history.replaceState`; a document navigation discards it. */
interface SentinelWindow extends Window {
  __sameDocument?: number;
}

const STEPS: [string, string, string, string, string, Record<string, unknown>][] = [
  [
    `evt_${SEED_VERSION}_1`,
    "received",
    "receive-salesforce-webhook",
    "webhook-api",
    "10:31:02",
    {}
  ],
  [
    `evt_${SEED_VERSION}_2`,
    "transformed",
    "transform-salesforce-account",
    "webhook-api",
    "10:31:04",
    {
      input: {
        Id: ENTITY_ID,
        Name: "Jorge Polanco",
        Phone: "+1 919 555 1234",
        Status__c: "Active"
      },
      output: { externalId: ENTITY_ID, name: "Jorge Polanco", phone: null, status: "active" }
    }
  ],
  [`evt_${SEED_VERSION}_3`, "persisted", "persist-customer", "webhook-api", "10:31:05", {}],
  [`evt_${SEED_VERSION}_4`, "published", "publish-customer-updated", "webhook-api", "10:31:06", {}],
  [`evt_${SEED_VERSION}_5`, "consumed", "consume-customer-updated", "sync-worker", "10:31:07", {}],
  [
    `evt_${SEED_VERSION}_6`,
    "delivered",
    "deliver-customer-to-target",
    "sync-worker",
    "10:31:09",
    { error: { message: "A phone number is required.", code: "phone_required" } }
  ],
  [
    `evt_${SEED_VERSION}_7`,
    "retried",
    "retry-customer-delivery",
    "sync-worker",
    "10:31:39",
    { error: { message: "A phone number is required.", code: "phone_required" } }
  ],
  [`evt_${SEED_VERSION}_8`, "failed", "move-message-to-dead-letter", "sync-worker", "10:34:38", {}]
];

/**
 * Seed the reference journey by ingesting it.
 *
 * The demo services that would produce this data by running a genuinely broken
 * integration do not exist until Phase 5, so this test constructs it. That is
 * why this suite proves the interface renders what the API returns, and not that
 * the product scenario works end to end.
 */
async function seed(): Promise<void> {
  for (const [id, operation, name, service, time, extra] of STEPS) {
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
          entity: { type: "customer", id: ENTITY_ID },
          operation,
          name,
          timestamp: `2026-08-06T${time}.000Z`,
          aliases: { salesforceAccountId: ALIAS_VALUE },
          ...extra
        }
      })
    });
    // The suite may run more than once against one database: an identical re-post
    // is accepted as a duplicate, and a changed one conflicts.
    if (response.status === 409) {
      throw new Error(
        `Seeding ${id} conflicted: an event with this id already exists with different content. Bump SEED_VERSION.`
      );
    }
    if (!response.ok) {
      throw new Error(`Seeding ${id} failed with ${String(response.status)}`);
    }
  }
}

test.beforeAll(seed);

test("redirects an unauthenticated visit to login", async ({ page }) => {
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page).toHaveURL(/\/login/);
});

test("rejects a wrong token and stays on login", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#token", "definitely-not-the-admin-token-000");
  await page.click("button[type=submit]");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("body")).toContainText("Invalid token");
});

test("finds the customer by entity id", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await expect(page.locator(".results li")).toHaveCount(1);
  await expect(page.locator(".results")).toContainText(ENTITY_ID);
});

test("finds the customer by alias value without supplying its type", async ({ page }) => {
  // ADR-028: the alias value differs from the entity id, so this can only match
  // through the alias path.
  await signIn(page, JOURNEY_ID);
  await page.fill("input[name=q]", ALIAS_VALUE);
  await page.click("button[type=submit]");
  await expect(page.locator(".results li")).toHaveCount(1);
  await expect(page.locator(".results")).toContainText(ENTITY_ID);
});

test("renders the whole journey in order and shows where phone became null", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);

  await expect(page.locator(".timeline li")).toHaveCount(8);
  await expect(page.locator(".timeline li").first()).toContainText("received");
  await expect(page.locator(".timeline li").last()).toContainText("failed");
  // Each row leads with its step's name, so a run of one operation still reads
  // as distinct steps.
  await expect(page.locator(".timeline li .step")).toHaveText(STEPS.map(([, , name]) => name));

  await page.click("text=transformed");

  // Per ADR-030 the transformation renames every field, so the defect reads as a
  // pair: Phone leaves carrying a value, phone arrives null.
  const before = page.locator(".diff tbody tr", { hasText: "Phone" }).first();
  await expect(before).toContainText("+1 919 555 1234");

  const after = page
    .locator(".diff tbody tr")
    .filter({ hasText: /^phone/ })
    .first();
  await expect(after).toContainText("null");
});

test("leads with the status line and keeps the definitions behind About this view", async ({
  page
}) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);

  const status = page.locator("p[aria-live=polite]");
  await expect(status).toHaveText(/^failed at [a-z-]+ · 8 events · .+ · span 3m 36s · times UTC$/);
  await expect(status).toHaveClass(/\bfailed\b/);
  // Straight after the heading: nothing stands between them.
  expect(
    await page.evaluate(() => {
      const heading = document.querySelector("main h1");
      const line = document.querySelector("p[aria-live=polite]");
      if (heading === null || line === null) return false;
      const between = document.createRange();
      between.setStartAfter(heading);
      between.setEndBefore(line);
      return between.toString().trim();
    })
  ).toBe("");
  // The aliases on one line, without the definition sentence.
  await expect(page.locator(".aliases")).toContainText("Also known as salesforceAccountId");
  await expect(page.locator(".aliases")).not.toContainText("An alias is");

  // Hidden, not gone.
  await expect(page.getByText(/^A journey is the complete recorded history/)).toBeHidden();
  await page.getByText("About this view").click();
  await expect(page.getByText(/^A journey is the complete recorded history/)).toBeVisible();
  await expect(page.getByText(/^An alias is another identifier/)).toBeVisible();
  await expect(page.getByText(/^Recorded span: 3m 36s/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Clock comparison" })).toHaveAttribute(
    "href",
    /GLOSSARY\.md#clock-comparison$/
  );
});

test("says a clock condition every step shares once, above the timeline", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.locator(".timeline li")).toHaveCount(8);

  // Seeded with no recorded host and received long after their 2026-08-06
  // timestamps: both conditions hold for every step.
  const notice = page.getByRole("note");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("recorded host evidence is missing");
  await expect(notice).toContainText("Every event was received more than two minutes");
  await expect(page.locator(".timeline .clock-caveat")).toHaveCount(0);
  await expect(page.locator(".timeline .clock-badge")).toHaveCount(0);
  // The gaps stay on their rows.
  await expect(page.locator(".timeline .timeline-gap")).toHaveCount(7);
});

test("shows the new step while its detail loads, never the old payloads, and follows Back", async ({
  page
}) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}?event=evt_${SEED_VERSION}_2`);
  await expect(page.locator(".detail h2")).toHaveText("transform-salesforce-account");
  await expect(page.locator(".detail")).toContainText("+1 919 555 1234");
  await page.waitForFunction(() => {
    const list = document.querySelector(".timeline");
    return list !== null && Object.keys(list).some((key) => key.startsWith("__reactFiber$"));
  });

  // Hold the next detail response until the loading state has been checked.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/events/*", async (route) => {
    await held;
    await route.continue();
  });

  await page.getByRole("option").filter({ hasText: "persist-customer" }).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`event=evt_${SEED_VERSION}_3$`));
  const panel = page.locator(".detail");
  await expect(panel.locator("h2")).toHaveText("persist-customer");
  await expect(panel).toHaveAttribute("aria-busy", "true");
  await expect(panel.getByRole("status")).toHaveText("Loading…");
  await expect(panel).not.toContainText("+1 919 555 1234");

  release();
  await expect(panel).not.toHaveAttribute("aria-busy");
  await expect(panel.getByRole("heading", { name: "Payloads" })).toBeVisible();
  await page.unroute("**/api/events/*");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`event=evt_${SEED_VERSION}_2$`));
  await expect(page.getByRole("option", { selected: true })).toContainText(
    "transform-salesforce-account"
  );
  await expect(panel.locator("h2")).toHaveText("transform-salesforce-account");
  await expect(panel).toContainText("+1 919 555 1234");

  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`event=evt_${SEED_VERSION}_3$`));
  await expect(panel.locator("h2")).toHaveText("persist-customer");
  await expect(page.getByRole("option", { selected: true })).toContainText("persist-customer");
});

test("masks the alias display value", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  // Read from the API's displayValue for ALIAS_VALUE; re-read it when SEED_VERSION changes.
  await expect(page.locator("body")).toContainText("SF-A…-V4");
  await expect(page.locator("body")).not.toContainText(ALIAS_VALUE);
});

test("shows an alias marked displayable in full, and marks the others as masked", async ({
  page
}) => {
  // Its own journey, so the reference journey's seed does not change. Ids are
  // versioned for the reason SEED_VERSION gives.
  const version = "v1";
  const journeyId = `jrn_e2e_displayable_${version}`;
  const postingId = `greenhouse:e2e-${version}`;
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id: `evt_e2e_displayable_${version}`,
        journeyId,
        environment: "development",
        service: "job-sweep",
        entity: { type: "job_posting", id: postingId },
        operation: "identified",
        name: "identify",
        timestamp: "2026-09-16T08:00:00.000Z",
        aliases: { postingId, recruiterEmail: "recruiter@example.com" },
        displayableAliases: ["postingId"]
      }
    })
  });
  expect(response.ok, `seeding answered ${String(response.status)}`).toBe(true);

  await signIn(page, journeyId);
  await page.goto(`/journeys/${journeyId}`);
  await expect(page.getByTestId("alias-postingId")).toHaveText(`postingId ${postingId}`);
  await expect(page.getByTestId("alias-recruiterEmail")).toHaveText(
    "recruiterEmail recr…com (masked)"
  );
  await expect(page.locator("body")).not.toContainText("recruiter@example.com");
});

test("renders an empty state rather than nothing for an unmatched search", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.fill("input[name=q]", "no-such-identifier-anywhere");
  await page.click("button[type=submit]");
  await expect(page.locator("body")).toContainText("Nothing matched");
});

test("returns a not-found page for an unknown journey", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  const response = await page.goto("/journeys/jrn_does_not_exist");
  expect(response?.status()).toBe(404);
});

test("walks the timeline with the keyboard and narrows it to failures without reloading", async ({
  page
}) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.locator(".detail h2")).toHaveText("receive-salesforce-webhook");
  // The heading above is in the server's HTML, so it does not prove React has
  // attached the list's key handler; arrow keys pressed before that scroll the
  // page instead of moving the selection.
  await page.waitForFunction(() => {
    const list = document.querySelector(".timeline");
    return list !== null && Object.keys(list).some((key) => key.startsWith("__reactFiber$"));
  });
  await page.evaluate(() => {
    (window as SentinelWindow).__sameDocument = 1;
  });

  await page.locator(".timeline").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  await expect(page.locator(".detail h2")).toHaveText("persist-customer");
  await expect(page).toHaveURL(new RegExp(`event=evt_${SEED_VERSION}_3$`));
  await expect(page.getByRole("option", { selected: true })).toContainText("persisted");

  await page.getByRole("button", { name: "Failures only" }).click();

  // Events 6 and 7 carry an error; event 8 is explicitly failed without one.
  await expect(page.locator(".timeline li")).toHaveCount(3);
  await expect(page.locator(".detail h2")).toHaveText("deliver-customer-to-target");
  await expect(page.getByRole("option", { selected: true })).toContainText("delivered");
  await expect(page.getByText("3 of 8 events shown")).toBeVisible();

  // Still set only if every step above happened in the first document.
  expect(await page.evaluate(() => (window as SentinelWindow).__sameDocument)).toBe(1);
});
