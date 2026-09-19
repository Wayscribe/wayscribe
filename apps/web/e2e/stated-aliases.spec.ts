import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * F-042: an `identified` event read on its own did not say what it identified.
 * The event detail lists the aliases the event stated, masked as the journey
 * read masks them, and says so when an identified event stated none.
 *
 * Stamped per run, so the events are new each time.
 */
const RUN = Date.now().toString(36);
const JOURNEY_ID = `jrn_e2e_stated_aliases_${RUN}`;
const EVENT = (index: number): string => `evt_stated_aliases_${RUN}_${String(index)}`;
const CONTACT = `<b>c-${RUN}</b>`;

test.beforeAll(async () => {
  const events = [
    {
      name: "identify-crm",
      operation: "identified",
      aliases: { email: `ada-${RUN}@example.com`, hubspotContactId: CONTACT },
      displayableAliases: ["hubspotContactId"]
    },
    { name: "identify-nothing", operation: "identified" },
    { name: "transform", operation: "transformed" }
  ];
  for (const [index, fields] of events.entries()) {
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id: EVENT(index),
          journeyId: JOURNEY_ID,
          environment: "development",
          service: "hubspot-sync",
          entity: { type: "lead", id: `E2E-STATED-ALIASES-${RUN}` },
          timestamp: new Date(Date.now() + index * 1000).toISOString(),
          ...fields
        }
      })
    });
    expect(response.ok, `seeding ${EVENT(index)} answered ${String(response.status)}`).toBe(true);
  }
});

async function expectStated(page: Page): Promise<void> {
  const stated = page.getByRole("group", { name: "Aliases stated" });
  await expect(stated.getByRole("term")).toHaveText(["email", "hubspotContactId"]);
  // The email was not marked displayable, so the API masked it.
  await expect(stated.getByRole("definition").nth(0)).toContainText("(masked)");
  await expect(stated.getByRole("definition").nth(0)).not.toContainText(`ada-${RUN}@example.com`);
  // Shown in full, and as the characters it is, not as markup.
  await expect(stated.getByRole("definition").nth(1)).toHaveText(CONTACT);
  await expect(stated.locator("b")).toHaveCount(0);
}

test("an identified event's detail lists the aliases it stated", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}?event=${EVENT(0)}`);
  await expectStated(page);

  await page.getByRole("link", { name: /identify-nothing/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "identify-nothing" })).toBeVisible();
  await expect(page.getByText("This event stated no aliases.")).toBeVisible();

  await page.getByRole("link", { name: /transform/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "transform" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aliases stated" })).toHaveCount(0);

  // Chosen again on the timeline, it reads the same as on first load.
  await page.getByRole("link", { name: /identify-crm/ }).click();
  await expectStated(page);
});

test("is in the server-rendered page, with JavaScript off", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, JOURNEY_ID);
  await page.goto(`/journeys/${JOURNEY_ID}?event=${EVENT(0)}`);
  await expectStated(page);
  await context.close();
});
