import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * What every page carries around its content: the skip link, and on a
 * signed-in page the glossary link in the nav.
 *
 * Signing in needs a journey to find the right project by (session.ts), so this
 * spec seeds one of its own. Versioned for the reason journey.spec.ts gives: an
 * event is immutable.
 */
const VERSION = "v1";
const JOURNEY_ID = `jrn_e2e_shell_${VERSION}`;

async function seed(): Promise<void> {
  const id = `evt_shell_${VERSION}_1`;
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
        entity: { type: "customer", id: `E2E-SHELL-${VERSION.toUpperCase()}` },
        operation: "received",
        name: "received-customer",
        timestamp: "2026-09-17T09:00:00.000Z"
      }
    })
  });
  expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
}

test.beforeAll(seed);

/** The first Tab lands on the skip link, which shows itself and moves on to main. */
async function expectSkipLink(page: Page): Promise<void> {
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toHaveAttribute("href", "#main");
  await expect(page.locator("main#main")).toHaveCount(1);
  // Present for assistive technology, but off the screen until focused.
  await expect(skip).not.toBeInViewport();

  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();

  // Following it starts the next Tab inside main, past the nav.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("main") !== null)).toBe(true);
}

test("the first Tab on the login page lands on the skip link", async ({ page }) => {
  await page.goto("/login");
  await expectSkipLink(page);
});

test("the first Tab on a signed-in page lands on the skip link, ahead of the nav", async ({
  page
}) => {
  await signIn(page, JOURNEY_ID);
  await page.goto("/journeys");
  await expectSkipLink(page);
});

test("the nav links the glossary where the repository hosts it", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  const glossary = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Glossary" });
  await expect(glossary).toBeVisible();
  await expect(glossary).toHaveAttribute(
    "href",
    "https://gitlab.com/jojithedev/wayscribe/-/blob/main/docs/GLOSSARY.md"
  );
});
