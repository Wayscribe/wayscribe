import { expect, test } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * ADR-072: a dead-letter names the step that lost the field the target
 * refused, in its detail and under the journey's status line, and the step's
 * name opens that step. Stamped per run: an event is immutable.
 */
const RUN = Date.now().toString(36);
const JOURNEY_ID = `jrn_e2e_likely_cause_${RUN}`;
const IDS = {
  received: `evt_e2e_lc_${RUN}_0`,
  transform: `evt_e2e_lc_${RUN}_1`,
  persist: `evt_e2e_lc_${RUN}_2`,
  deliver: `evt_e2e_lc_${RUN}_3`,
  deadLetter: `evt_e2e_lc_${RUN}_4`
};

const ACCOUNT = {
  Id: `0018ZE2E${RUN}`,
  Name: "Acme Field Services",
  Phone: "+1 919 555 1234",
  Status__c: "Active",
  BillingAddress: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
/** The demo's defect: `Phone` read as `Phone__c`, so `phone` arrives null. */
const CUSTOMER = {
  externalId: ACCOUNT.Id,
  name: "Acme Field Services",
  phone: null,
  status: "active",
  address: { street: "100 Main St", city: "Raleigh", state: "NC", postalCode: "27601" }
};
const REJECTED = {
  status: 422,
  body: {
    error: { code: "phone_required", message: "A phone number is required.", fields: ["phone"] }
  }
};

const LINE =
  "Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by deliver-customer-to-target";

async function post(id: string, at: number, fields: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId: JOURNEY_ID,
        environment: "development",
        entity: { type: "customer", id: ACCOUNT.Id },
        timestamp: new Date(at).toISOString(),
        ...fields
      }
    })
  });
  expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
}

test.beforeAll(async () => {
  // A minute ago: finished, and too old to follow live.
  const base = Date.now() - 60_000;
  await post(IDS.received, base, {
    service: "demo-integration",
    operation: "received",
    name: "receive-salesforce-webhook",
    input: ACCOUNT
  });
  await post(IDS.transform, base + 12, {
    service: "demo-integration",
    operation: "transformed",
    name: "transform-salesforce-account",
    input: ACCOUNT,
    output: CUSTOMER,
    durationMs: 1
  });
  await post(IDS.persist, base + 35, {
    service: "demo-integration",
    operation: "persisted",
    name: "persist-customer",
    input: CUSTOMER,
    output: 4711,
    durationMs: 18
  });
  await post(IDS.deliver, base + 290, {
    service: "demo-worker",
    operation: "delivered",
    name: "deliver-customer-to-target",
    input: CUSTOMER,
    output: REJECTED,
    durationMs: 19,
    error: {
      message: "deliver-customer-to-target reported a failed result.",
      code: "result_failed",
      fields: ["phone"]
    }
  });
  await post(IDS.deadLetter, base + 9_400, {
    service: "demo-worker",
    operation: "failed",
    name: "move-message-to-dead-letter",
    error: {
      message: "The target refused the customer; the message moved to the dead-letter queue."
    }
  });
});

const deadLetterPage = `/journeys/${JOURNEY_ID}?event=${IDS.deadLetter}`;

test("the dead-letter's detail and the journey header name the likely cause", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(deadLetterPage);
  await expect(page.locator(".detail h2")).toHaveText("move-message-to-dead-letter");
  await expect(page.locator(".detail .likely-cause")).toHaveText(LINE);
  await expect(page.locator(".journey-likely-cause .likely-cause")).toHaveText(LINE);
});

test("the step's name opens the step that lost the field", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(deadLetterPage);
  await page
    .locator(".detail .likely-cause")
    .getByRole("link", { name: "transform-salesforce-account" })
    .click();
  await expect(page).toHaveURL(new RegExp(`[?&]event=${IDS.transform}(&|$)`));
  await expect(page.locator(".detail h2")).toHaveText("transform-salesforce-account");
});

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the server's HTML carries both lines", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.goto(deadLetterPage);
    await expect(page.locator(".detail .likely-cause")).toHaveText(LINE);
    await expect(page.locator(".journey-likely-cause .likely-cause")).toHaveText(LINE);
  });
});

for (const width of [375, 1440]) {
  test(`the likely cause lines do not scroll sideways at ${String(width)} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, JOURNEY_ID);
    await page.goto(deadLetterPage);
    const lines = page.locator(".likely-cause");
    await expect(lines).toHaveCount(2);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const line of await lines.all()) {
      const box = await line.boundingBox();
      expect(box, "a likely cause line has no box").not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(width);
    }
  });
}
