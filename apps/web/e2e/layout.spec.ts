import { expect, test, type Page } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * Long names do not widen the page.
 *
 * A step name may be 256 characters, a service name 128 and an entity id 512
 * (packages/protocol event schema). A review found that a 68-character step
 * name made timeline rows 505 px wide on a 400 px screen, a 256-character one
 * made the page 2,725 px wide, and a long service name widened the page to
 * 3,250 px even at 1280 px, through the filter chips and the event heading.
 */

// Versioned for the reason journey.spec.ts gives: an event is immutable.
const VERSION = "v2";
const JOURNEY_ID = `jrn_e2e_layout_${VERSION}`;
const STEP = `step-${"n".repeat(250)}`;
const SERVICE = `svc-${"s".repeat(124)}`;
const ENTITY = `layout-${"e".repeat(300)}-${VERSION}`;
// The longest version and commit the protocol takes (F-043): the row cuts
// them, and the event's Deployment group wraps them.
const DEPLOYMENT = { version: `v-${"9".repeat(126)}`, gitCommit: "c".repeat(128) };

async function seed(): Promise<void> {
  const events = [
    { id: `evt_layout_${VERSION}_1`, name: STEP, service: SERVICE, time: "08:00:00" },
    { id: `evt_layout_${VERSION}_2`, name: "short-step", service: "job-sweep", time: "08:00:01" }
  ];
  for (const { id, name, service, time } of events) {
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
          entity: { type: "job_posting", id: ENTITY },
          operation: "delivered",
          name,
          timestamp: `2026-09-16T${time}.000Z`,
          input: { a: 1 },
          output: { a: 2 },
          deployment: DEPLOYMENT
        }
      })
    });
    expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
  }
}

test.beforeAll(seed);

/** How far the page scrolls sideways, in pixels. Zero is the goal. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
}

for (const width of [400, 1280]) {
  test(`a journey with long names does not scroll sideways at ${String(width)} px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, JOURNEY_ID);
    await page.goto(`/journeys/${JOURNEY_ID}?event=evt_layout_${VERSION}_1`);
    await expect(page.getByRole("heading", { level: 2, name: STEP })).toBeVisible();
    await expect(page.locator(".timeline li .step").first()).toHaveText(STEP);

    expect(await horizontalOverflow(page)).toBe(0);

    // The row keeps to its column and cuts the name, rather than wrapping it.
    const row = page.locator(".timeline li").first();
    const rowBox = await row.boundingBox();
    const list = await page.locator(".timeline").boundingBox();
    expect(rowBox?.width).toBeLessThanOrEqual(list?.width ?? 0);
    const cut = await page
      .locator(".timeline li .step")
      .first()
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(cut).toBe(true);

    // The build is cut on the row too, and whole in its title.
    const build = row.locator(".build");
    await expect(build).toHaveAttribute(
      "title",
      `Recorded by version ${DEPLOYMENT.version}, commit ${DEPLOYMENT.gitCommit}`
    );
    const buildBox = await build.boundingBox();
    expect((buildBox?.x ?? 0) + (buildBox?.width ?? 0)).toBeLessThanOrEqual(
      (rowBox?.x ?? 0) + (rowBox?.width ?? 0)
    );
    expect(await build.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(page.getByRole("group", { name: "Deployment" })).toContainText(
      DEPLOYMENT.gitCommit
    );
  });
}

/**
 * The Journeys table: a 200-character label (the most a label may hold) and
 * alias values of 300 and 500 characters are cut in their column. Stamped per
 * run rather than versioned, because the list only shows recent activity.
 */
const LIST_RUN = Date.now().toString(36);
const LIST_SERVICE = `e2e-layout-list-${LIST_RUN}`;
const LONG_LABEL = `label-${LIST_RUN}-`.padEnd(200, "l");
const LONG_ALIASES = {
  company: `company-${"c".repeat(292)}`,
  url: `https://jobs.example.test/${"p".repeat(474)}`
};

async function seedList(): Promise<void> {
  const journeys = [
    // The aliased journey is newer, so it lists first.
    { suffix: "labelled", label: LONG_LABEL, secondsAgo: 2 },
    { suffix: "aliased", label: undefined, secondsAgo: 1 }
  ];
  for (const { suffix, label, secondsAgo } of journeys) {
    const id = `evt_layout_list_${suffix}_${LIST_RUN}`;
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id,
          journeyId: `jrn_e2e_layout_list_${suffix}_${LIST_RUN}`,
          environment: "development",
          service: LIST_SERVICE,
          entity: { type: `entity-${"t".repeat(120)}`, id: `layout-list-${suffix}-${LIST_RUN}` },
          operation: "failed",
          name: STEP,
          timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
          aliases: LONG_ALIASES,
          displayableAliases: ["company", "url"],
          ...(label === undefined ? {} : { journeyLabel: label })
        }
      })
    });
    expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
  }
}

test.describe("the Journeys table", () => {
  test.beforeAll(seedList);

  for (const width of [400, 1280]) {
    test(`long labels and alias values do not scroll sideways at ${String(width)} px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, JOURNEY_ID);
      await page.goto(`/journeys?service=${LIST_SERVICE}`);
      const shown = page.locator("tbody td.col-shown a");
      await expect(shown).toHaveCount(2);
      await expect(shown.nth(1)).toHaveText(LONG_LABEL);
      // Joined alias values are cut to 200 characters before the stylesheet cuts them again.
      await expect(shown.nth(0)).toHaveText(`${LONG_ALIASES.company.slice(0, 199)}…`);

      // No environment is chosen, so the list spans environments and the
      // Environment column is present; a phone drops it with the other two.
      // A CSS locator: a hidden header leaves the accessibility tree, so a role
      // query could not tell "hidden" from "not rendered".
      const environment = page.locator("thead th.col-environment");
      await expect(environment).toHaveCount(1);
      if (width === 400) {
        await expect(environment).toBeHidden();
        // Phones see the short labels; assistive technology keeps the full ones.
        for (const [column, short, full] of [
          ["col-activity", "When", "Last activity"],
          ["col-events", "#", "Events"]
        ] as const) {
          const header = page.locator(`thead th.${column}`);
          await expect(header.locator(".header-short")).toBeVisible();
          await expect(header.locator(".header-short")).toHaveText(short);
          await expect(header).toHaveAccessibleName(full);
        }
      } else {
        await expect(environment).toBeVisible();
        await expect(page.locator("tbody td.col-environment").first()).toHaveText("development");
      }

      expect(await horizontalOverflow(page)).toBe(0);
      const cutHeaders = await page.locator("thead th").evaluateAll((headers) =>
        headers
          .filter((header) => header.getClientRects().length > 0)
          .filter((header) => header.scrollWidth > header.clientWidth)
          .map((header) => header.textContent)
      );
      expect(cutHeaders).toEqual([]);

      // The table keeps to the page, and each long value is cut rather than wrapped.
      const tableBox = await page.locator("table").boundingBox();
      const mainBox = await page.locator("main").boundingBox();
      expect(tableBox?.width).toBeLessThanOrEqual(mainBox?.width ?? 0);
      for (const index of [0, 1]) {
        const cell = shown.nth(index);
        expect(await cell.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true
        );
        const box = await cell.boundingBox();
        // One line: no taller than two lines of the table's text.
        expect(box?.height).toBeLessThan(40);
      }
    });
  }

  // The same failed journeys found by search, whose status reads
  // `failed at <step>` (ADR-063). A review measured a 256-character step name
  // making Search 1,747 px wide on a 400 px screen.
  for (const width of [400, 1280]) {
    test(`a search row with a long failed step does not scroll sideways at ${String(width)} px`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, JOURNEY_ID);
      const entityId = `layout-list-labelled-${LIST_RUN}`;
      await page.goto(`/?q=${entityId}`);
      const status = page.getByRole("listitem").filter({ hasText: entityId }).locator(".status");
      await expect(status).toHaveText(`failed at ${STEP}`);

      expect(await horizontalOverflow(page)).toBe(0);
    });
  }
});

/**
 * A metadata key may be 128 characters (packages/protocol). A review found a
 * key column sized to its longest key squeezed every value to about 35 px, and
 * one event's metadata list grew to 17,646 px tall.
 */
const METADATA_JOURNEY_ID = `jrn_e2e_layout_metadata_${VERSION}`;
const LONG_KEY = `key-${"k".repeat(124)}`;

test.describe("metadata with a long key", () => {
  test.beforeAll(async () => {
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id: `evt_layout_metadata_${VERSION}`,
          journeyId: METADATA_JOURNEY_ID,
          environment: "development",
          service: "job-sweep",
          entity: { type: "job_posting", id: `layout-metadata-${VERSION}` },
          operation: "delivered",
          name: "push-hubspot",
          timestamp: "2026-09-16T08:00:00.000Z",
          metadata: {
            [LONG_KEY]: "a value that is a sentence long, so it needs room to be read",
            httpStatus: 429
          }
        }
      })
    });
    expect(response.ok, `seeding answered ${String(response.status)}`).toBe(true);
  });

  for (const width of [400, 1280]) {
    test(`keeps the value column usably wide at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, METADATA_JOURNEY_ID);
      await page.goto(`/journeys/${METADATA_JOURNEY_ID}`);
      const list = page.getByRole("group", { name: "Custom" }).locator("dl");
      await expect(list.getByRole("term")).toHaveText(["httpStatus", LONG_KEY]);

      expect(await horizontalOverflow(page)).toBe(0);
      const listBox = await list.boundingBox();
      // At least half the list for every value, however long a key is: the
      // grid sizes the column once for all rows.
      for (const value of await list.getByRole("definition").all()) {
        const valueBox = await value.boundingBox();
        expect(valueBox?.width ?? 0).toBeGreaterThanOrEqual((listBox?.width ?? 0) * 0.5);
      }
      // Two entries, a long key wrapped over a few lines: nowhere near a page.
      expect(listBox?.height ?? Infinity).toBeLessThan(400);
    });
  }
});
