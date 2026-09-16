import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

// Its own journey, versioned like the other suites' seeds.
const SEED_VERSION = "v1";
const ENTITY_ID = `E2E-CSP-${SEED_VERSION.toUpperCase()}`;
const JOURNEY_ID = `jrn_e2e_csp_${SEED_VERSION}`;
const EVENT_ID = `evt_csp_${SEED_VERSION}_1`;

async function seed(): Promise<void> {
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id: EVENT_ID,
        journeyId: JOURNEY_ID,
        environment: "development",
        service: "webhook-api",
        entity: { type: "customer", id: ENTITY_ID },
        operation: "transformed",
        name: "transform-customer",
        timestamp: "2026-08-08T10:00:00.000Z",
        input: { Phone: "+1 919 555 1234" },
        output: { phone: null }
      }
    })
  });
  if (response.status === 409) {
    throw new Error(`Seeding ${EVENT_ID} conflicted with different content. Bump SEED_VERSION.`);
  }
  if (!response.ok) throw new Error(`Seeding ${EVENT_ID} failed with ${String(response.status)}`);
}

interface ViolationWindow extends Window {
  __cspViolations?: string[];
}

/**
 * Every violation the page reports, from both places a browser reports one:
 * the `securitypolicyviolation` event, and the console message. Registered
 * before any document script runs, so an inline script the policy blocks is
 * caught even though it never executes.
 */
async function watchViolations(page: Page): Promise<string[]> {
  const fromConsole: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to (execute|load|apply)/i.test(message.text())) {
      fromConsole.push(message.text());
    }
  });
  await page.addInitScript(() => {
    const target = window as ViolationWindow;
    target.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      target.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return fromConsole;
}

async function violationsOn(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as ViolationWindow).__cspViolations ?? []);
}

test.beforeAll(seed);

test("every page is served with the security headers", async ({ page }) => {
  const response = await page.goto("/login");
  const headers = response?.headers() ?? {};

  const policy = headers["content-security-policy"] ?? "";
  for (const directive of [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ]) {
    expect(policy).toContain(directive);
  }
  // Scripts are allowed by nonce, never by 'unsafe-inline'.
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");

  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-powered-by"]).toBeUndefined();

  // A fresh nonce per response: a reused one would be a nonce an attacker can read.
  const again = await page.goto("/login");
  expect(again?.headers()["content-security-policy"]).not.toBe(policy);
});

test("the search, journey, journeys, replay, and delete pages work with no CSP violation", async ({
  page
}) => {
  const fromConsole = await watchViolations(page);

  await signIn(page, JOURNEY_ID);

  // Search: the form submits, results render.
  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await expect(page.locator(".results li")).toHaveCount(1);
  expect(await violationsOn(page), "search").toEqual([]);

  // Journey: hydrated, so selecting an event works without a reload.
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.locator(".timeline li")).toHaveCount(1);
  await page.click("text=transformed");
  await expect(page.locator(".diff")).toContainText("Phone");
  expect(await violationsOn(page), "journey").toEqual([]);

  // Journeys, reached through the old Recent address, which redirects.
  await page.goto("/recent?status=&window=7d");
  await expect(page).toHaveURL("/journeys?status=&window=7d");
  await expect(page.locator("h1")).toHaveText("Journeys");
  expect(await violationsOn(page), "journeys").toEqual([]);

  // Replay: the review screen for the seeded event.
  await page.goto(`/journeys/${JOURNEY_ID}/replay?event=${EVENT_ID}`);
  await expect(page.locator("h1")).toContainText("Replay this input");
  expect(await violationsOn(page), "replay").toEqual([]);

  // Delete: the confirmation page, not the deletion, so the journey stays for
  // the next run.
  await page.goto(`/journeys/${JOURNEY_ID}/delete`);
  await expect(page.getByRole("button", { name: "Delete journey" })).toBeVisible();
  expect(await violationsOn(page), "delete").toEqual([]);

  // A page rendered for a path nothing matches is under the same policy.
  const missing = await page.goto("/no-such-page");
  expect(missing?.status()).toBe(404);
  expect(await violationsOn(page), "not found").toEqual([]);

  expect(fromConsole).toEqual([]);
});
