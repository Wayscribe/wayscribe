import { expect, test, type Locator, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

// Versioned like journey.spec.ts, and stamped per run as well. The Journeys
// page lists journeys by recent activity, so these events have to be stamped
// now, and an ingested event is immutable: re-posting yesterday's ids with
// today's timestamps would conflict. The service name carries the stamp too,
// so the page can be narrowed to this run's journeys on a database that holds
// earlier runs, the demo's failures, or anything else.
// Bump SEED_VERSION whenever the seeded shape below changes.
const SEED_VERSION = "v2";
const RUN = `${SEED_VERSION}_${Date.now().toString(36)}`;
const SERVICE = `e2e-journeys-${RUN}`;
/** One instant every seeded timestamp and every typed range is relative to. */
const BASE = Date.now();

interface Seeded {
  journeyId: string;
  entityId: string;
  operation: string;
  minutesAgo: number;
  label?: string;
  aliases?: Record<string, string>;
  displayable?: string[];
}

const LABEL = `Acme renewal ${RUN}`;
const LABELLED: Seeded = {
  journeyId: `jrn_e2e_journeys_labelled_${RUN}`,
  entityId: `E2E-JOURNEYS-LABELLED-${RUN}`,
  operation: "failed",
  minutesAgo: 10,
  label: LABEL
};
const ALIASED: Seeded = {
  journeyId: `jrn_e2e_journeys_aliased_${RUN}`,
  entityId: `E2E-JOURNEYS-ALIASED-${RUN}`,
  operation: "completed",
  minutesAgo: 5,
  // The API returns displayable aliases in alias-type order: company, then url.
  aliases: { url: `https://jobs.example.test/${RUN}`, company: `Globex ${RUN}` },
  displayable: ["url", "company"]
};
const PLAIN: Seeded = {
  journeyId: `jrn_e2e_journeys_plain_${RUN}`,
  entityId: `E2E-JOURNEYS-PLAIN-${RUN}`,
  operation: "received",
  minutesAgo: 7,
  // Not displayable, so it is masked and can be neither shown nor matched.
  aliases: { email: `hidden-${RUN}@example.test` }
};

async function ingest(journey: Seeded): Promise<void> {
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
        operation: journey.operation,
        name: `${journey.operation}-step`,
        timestamp: new Date(BASE - journey.minutesAgo * 60_000).toISOString(),
        ...(journey.label === undefined ? {} : { journeyLabel: journey.label }),
        ...(journey.aliases === undefined ? {} : { aliases: journey.aliases }),
        ...(journey.displayable === undefined ? {} : { displayableAliases: journey.displayable })
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Seeding ${id} failed with ${String(response.status)}`);
  }
}

test.beforeAll(async () => {
  for (const journey of [LABELLED, ALIASED, PLAIN]) await ingest(journey);
});

const table = (page: Page): Locator => page.getByRole("table");
const rows = (page: Page): Locator => table(page).locator("tbody tr");
const shownAs = (page: Page, row: number): Locator => rows(page).nth(row).locator("td.col-shown");

/** `2026-09-16T10:07`, as a datetime-local input takes it, in UTC. */
const minuteInput = (millisecondsAgo: number): string =>
  new Date(Math.floor((BASE - millisecondsAgo) / 60_000) * 60_000).toISOString().slice(0, 16);

test("lists a labelled journey and the fallback rows, newest first", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Journeys" })
    .click();
  await expect(page).toHaveURL(/\/journeys$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Journeys");
  await expect(page.getByText("All times UTC.")).toBeVisible();

  await page.goto(`/journeys?service=${SERVICE}`);
  // The caption names the table and says what it holds.
  await expect(
    page.getByRole("table", {
      name: `Journeys in the last 24 hours, all environments, from ${SERVICE}`
    })
  ).toBeVisible();
  // By accessible name: each header also holds a short label for phones,
  // hidden from assistive technology.
  const names = [
    "Last activity",
    "Status",
    "Environment",
    "Entity type",
    "Shown as",
    "Last step",
    "Events"
  ];
  await expect(page.getByRole("columnheader")).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(page.getByRole("columnheader").nth(index)).toHaveAccessibleName(name);
  }

  await expect(rows(page)).toHaveCount(3);
  // Newest first: aliased (5 min), plain (7 min), labelled (10 min).
  await expect(shownAs(page, 0)).toHaveText(`Globex ${RUN} · https://jobs.example.test/${RUN}`);
  await expect(shownAs(page, 1)).toHaveText(`customer: ${PLAIN.entityId}`);
  await expect(shownAs(page, 2)).toHaveText(LABEL);
  await expect(rows(page).nth(1)).not.toContainText(`hidden-${RUN}`);
  await expect(rows(page).nth(2).getByRole("cell")).toHaveText([
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    "failed",
    "development",
    "customer",
    LABEL,
    "failed-step",
    "1"
  ]);

  // With an environment chosen, every row shares it, so the column goes.
  await page.goto(`/journeys?service=${SERVICE}&environment=development`);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("columnheader", { name: "Environment" })).toHaveCount(0);
  await expect(rows(page).first().getByRole("cell")).toHaveCount(6);

  await page.getByRole("link", { name: LABEL }).click();
  await expect(page).toHaveURL(
    `/journeys/${LABELLED.journeyId}?from=journeys&list=${encodeURIComponent(
      `service=${SERVICE}&environment=development`
    )}`
  );
  // Named by its label, with the entity beneath.
  await expect(page.locator("h1")).toHaveText(LABEL);
  await expect(page.locator(".journey-entity")).toHaveText(`customer: ${LABELLED.entityId}`);

  // Back to the same list, filters and all.
  await page.getByRole("link", { name: "← Journeys" }).click();
  await expect(page).toHaveURL(`/journeys?service=${SERVICE}&environment=development`);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByLabel("Environment", { exact: true })).toHaveValue("development");
});

test("a journey opened any other way leads back to Search, and a crafted way back stays on the list", async ({
  page
}) => {
  await signIn(page, LABELLED.journeyId);
  // Without a label, the entity is the heading, as before.
  await page.goto(`/journeys/${PLAIN.journeyId}`);
  await expect(page.locator("h1")).toHaveText(`customer: ${PLAIN.entityId}`);
  await expect(page.getByRole("link", { name: "← Search" })).toHaveAttribute("href", "/");

  await page.goto(
    `/journeys/${LABELLED.journeyId}?from=journeys&list=${encodeURIComponent("//evil.test&next=https://evil.test&service=x")}`
  );
  await expect(page.locator("h1")).toHaveText(LABEL);
  await expect(page.getByRole("link", { name: "← Journeys" })).toHaveAttribute(
    "href",
    "/journeys?service=x"
  );
});

test("narrows the list by partial text in labels and displayable aliases", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);
  await page.goto(`/journeys?service=${SERVICE}`);
  await expect(rows(page)).toHaveCount(3);

  // Part of the label, in another case.
  await page.getByLabel("Contains", { exact: true }).fill(`NEWAL ${RUN.toUpperCase()}`);
  await page.getByRole("button", { name: "Show" }).click();
  // Only the filters that were set stay in the address.
  await expect(page).toHaveURL(
    `/journeys?q=${encodeURIComponent(`NEWAL ${RUN.toUpperCase()}`).replaceAll("%20", "+")}&window=24h&service=${SERVICE}`
  );
  await expect(rows(page)).toHaveCount(1);
  await expect(shownAs(page, 0)).toHaveText(LABEL);
  await expect(page.getByLabel("Contains", { exact: true })).toHaveValue(
    `NEWAL ${RUN.toUpperCase()}`
  );

  // Part of a displayable alias value.
  await page.getByLabel("Contains", { exact: true }).fill(`jobs.example.test/${RUN}`);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(shownAs(page, 0)).toContainText(`Globex ${RUN}`);

  // A masked alias and an entity id are never matched, and the empty state
  // says what was filtered and what Contains can match.
  for (const text of [`hidden-${RUN}`, PLAIN.entityId]) {
    await page.getByLabel("Contains", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Show" }).click();
    await expect(table(page)).toHaveCount(0);
    await expect(page.locator(".empty-state")).toContainText(
      `No journeys match: contains "${text}", service ${SERVICE}, the last 24 hours.`
    );
    await expect(page.locator(".empty-state")).toContainText(
      "Contains finds partial text in journey labels and displayable alias values only."
    );
  }
});

test("the Failures shortcut keeps the other filters", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);
  await page.goto(`/journeys?service=${SERVICE}`);
  await expect(rows(page)).toHaveCount(3);

  await page
    .getByRole("navigation", { name: "Status shortcuts" })
    .getByRole("link", { name: "Failures" })
    .click();
  await expect(page).toHaveURL(/[?&]status=failed(&|$)/);
  await expect(page.getByRole("link", { name: "Failures" })).toHaveAttribute(
    "aria-current",
    "true"
  );
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("failed");
  await expect(page.getByLabel("Service", { exact: true })).toHaveValue(SERVICE);
  await expect(page.getByRole("caption")).toHaveText(
    `Failed journeys in the last 24 hours, all environments, from ${SERVICE}`
  );
  await expect(rows(page)).toHaveCount(1);
  await expect(shownAs(page, 0)).toHaveText(LABEL);

  await page.getByRole("link", { name: "All", exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
});

test("an old Recent link opens Journeys with its filters", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);

  await page.goto(`/recent?status=failed&window=7d&service=${SERVICE}`);
  await expect(page).toHaveURL(`/journeys?status=failed&window=7d&service=${SERVICE}`);
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("failed");
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue("7d");
  await expect(rows(page)).toHaveCount(1);

  // Recent listed failures when no status was named, and still does.
  await page.goto(`/recent?service=${SERVICE}`);
  await expect(page).toHaveURL(`/journeys?service=${SERVICE}&status=failed`);
  await expect(rows(page)).toHaveCount(1);

  // "Any status", which the Journeys page shows by default, and an empty value
  // is dropped from the address.
  await page.goto(`/recent?status=&service=${SERVICE}`);
  await expect(page).toHaveURL(`/journeys?service=${SERVICE}`);
  await expect(rows(page)).toHaveCount(3);

  // The search page's way in still reads as it did.
  await page.goto("/");
  await page.getByRole("link", { name: "No identifier? See recent failures" }).click();
  await expect(page).toHaveURL("/journeys?status=failed");
  await expect(page.getByLabel("Status", { exact: true })).toHaveValue("failed");
});

test("a custom range lists only its window, read as UTC", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);
  await page.goto(`/journeys?service=${SERVICE}`);
  await expect(page.getByRole("group", { name: "Custom range, UTC" })).toBeVisible();

  // From 9 minutes ago (rounded down to the minute, so between 9 and 10) to 6
  // minutes ago: the plain journey only.
  await page.getByLabel("Time", { exact: true }).selectOption("custom");
  await page.getByLabel("From", { exact: true }).fill(minuteInput(9 * 60_000));
  await page.getByLabel("To", { exact: true }).fill(minuteInput(6 * 60_000 - 60_000));
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/[?&]window=custom/);
  await expect(page.locator(".filter-notes")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(shownAs(page, 0)).toHaveText(`customer: ${PLAIN.entityId}`);
  await expect(page.getByRole("caption")).toContainText(
    `Journeys from ${minuteInput(9 * 60_000).replace("T", " ")} to `
  );

  // An end before the start is never sent; the page says so and shows a day.
  await page.getByLabel("From", { exact: true }).fill(minuteInput(5 * 60_000));
  await page.getByLabel("To", { exact: true }).fill(minuteInput(20 * 60_000));
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.locator(".filter-notes")).toHaveText(
    "The custom range was not used (the end must be after the start), so this shows the last 24 hours."
  );
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue("24h");
  await expect(rows(page)).toHaveCount(3);
  // What was typed stays, to be corrected.
  await expect(page.getByLabel("To", { exact: true })).toHaveValue(minuteInput(20 * 60_000));
});

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

test.describe("a page link the API refuses", () => {
  const past = new Date(Date.now() - 60 * 60_000).toISOString();

  for (const [label, cursor] of [
    ["a garbled cursor", "garbage"],
    // Decodes, and then names a timestamp PostgreSQL cannot cast.
    ["a crafted cursor", base64url({ lastEventAt: "March 7", id: "jrn_x" })]
  ] as const) {
    test(`says so for ${label} and offers the newest`, async ({ page }) => {
      await signIn(page, LABELLED.journeyId);
      const query = new URLSearchParams({
        q: "",
        status: "failed",
        window: "24h",
        entityType: "",
        environment: "",
        service: SERVICE,
        since: past,
        until: "",
        cursor
      });
      await page.goto(`/journeys?${query.toString()}`);

      await expect(page.locator(".error")).toHaveText(
        "This page link is no longer valid. Back to the newest"
      );
      await expect(page.locator("body")).not.toContainText("Cannot reach");

      await page.getByRole("link", { name: "Back to the newest" }).click();
      await expect(page.getByRole("caption")).toHaveText(
        `Failed journeys in the last 24 hours, all environments, from ${SERVICE}`
      );
      await expect(rows(page)).toHaveCount(1);
    });
  }

  // Titles are fixed strings: Playwright matches a test by title between its
  // runner and worker processes, so a timestamp in one cannot be found again.
  for (const [label, since] of [
    ["an hour ahead", () => new Date(Date.now() + 60 * 60_000).toISOString()],
    ["in year 10000", () => "+010000-01-01T00:00:00.000Z"]
  ] as const) {
    test(`recomputes a carried since ${label} rather than erroring`, async ({ page }) => {
      await signIn(page, LABELLED.journeyId);
      // The cursor is real in shape; the since is what the page must not trust.
      const cursor = base64url({ lastEventAt: new Date().toISOString(), id: "jrn_~" });
      const query = new URLSearchParams({
        status: "",
        window: "24h",
        service: SERVICE,
        since: since(),
        cursor
      });
      await page.goto(`/journeys?${query.toString()}`);

      await expect(page.locator(".error")).toHaveCount(0);
      await expect(rows(page)).toHaveCount(3);
    });
  }
});

test("says so when a filter is repeated, and lists without it", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);
  await page.goto(`/journeys?status=failed&status=active&service=${SERVICE}`);
  await expect(page.locator(".filter-notes")).toHaveText(
    "status was given more than once, so it was left out."
  );
  // Filtered: the filter form also has a status line, empty until it is sent.
  await expect(
    page.getByRole("status").filter({ hasText: "status was given more than once" })
  ).toHaveCount(1);
  await expect(rows(page)).toHaveCount(3);
});

test("names the filters when nothing matches", async ({ page }) => {
  await signIn(page, LABELLED.journeyId);
  await page.goto(`/journeys?status=active&window=7d&entityType=invoice&service=${SERVICE}`);
  await expect(page.locator(".empty-state p").first()).toHaveText(
    `No journeys match: status active, entity type invoice, service ${SERVICE}, the last 7 days.`
  );
});
