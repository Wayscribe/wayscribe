import { expect, test, type Page, type Route } from "@playwright/test";
import { API_KEY, API_URL, signIn } from "./session";

/**
 * Search and the Journeys list work with JavaScript off, and answer with real
 * status codes; with JavaScript on, they say when they are loading.
 *
 * The pages are rendered in full before they are sent. A loading.tsx or a
 * Suspense boundary around their data would stream them instead: the content
 * then arrives in a hidden container that only a script reveals, so with
 * JavaScript off the page says "Loading" forever, and the status is committed
 * as 200 before a redirect or a not-found is decided. Loading feedback comes
 * from client components instead (PendingForm, LinkPending).
 *
 * Stamped per run rather than versioned, because the list only shows recent
 * activity, so the event must be new each time.
 */
const RUN = Date.now().toString(36);
const SERVICE = `e2e-nojs-${RUN}`;
const JOURNEY_ID = `jrn_e2e_nojs_${RUN}`;
const ENTITY_ID = `E2E-NOJS-${RUN}`;
const LABEL = `No-JS journey ${RUN}`;

async function seed(): Promise<void> {
  const id = `evt_nojs_${RUN}`;
  const response = await fetch(`${API_URL}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId: JOURNEY_ID,
        environment: "development",
        service: SERVICE,
        entity: { type: "customer", id: ENTITY_ID },
        operation: "failed",
        name: "sync-customer",
        timestamp: new Date().toISOString(),
        durationMs: 10,
        journeyLabel: LABEL
      }
    })
  });
  expect(response.ok, `seeding ${id} answered ${String(response.status)}`).toBe(true);
}

test.beforeAll(seed);

/** Whether this API's search rows say which environment they came from. */
async function searchRowsCarryEnvironment(): Promise<boolean> {
  const response = await fetch(`${API_URL}/v1/search?q=${encodeURIComponent(ENTITY_ID)}`, {
    headers: { authorization: `Bearer ${API_KEY}` }
  });
  const body = (await response.json()) as { data: { items: Record<string, unknown>[] } };
  return body.data.items.some((item) => "environment" in item);
}

test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("the Journeys filters submit and list the journey", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.goto("/journeys");
    await page.getByLabel("Service").fill(SERVICE);
    await page.getByLabel("Any step over (ms)").fill("0");
    await page.getByRole("button", { name: "Show" }).click();

    await expect(page).toHaveURL(new RegExp(`[?&]service=${SERVICE}(&|$)`));
    await expect(page).toHaveURL(/[?&]minStepDurationMs=0(&|$)/);
    await expect(page.getByRole("link", { name: LABEL })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("Loading journeys…")).toHaveCount(0);
  });

  test("search submits and finds the journey", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.getByRole("textbox", { name: "Search" }).fill(ENTITY_ID);
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page).toHaveURL(`/?q=${ENTITY_ID}`);
    await expect(page.getByRole("link", { name: `customer: ${ENTITY_ID}` })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.getByText("Searching…")).toHaveCount(0);
  });

  // F-036: search narrows by time and environment in the same plain form.
  test("search narrows by environment and time, and each row says its environment", async ({
    page
  }) => {
    await signIn(page, JOURNEY_ID);
    const search = page.getByRole("textbox", { name: "Search" });

    await search.fill(ENTITY_ID);
    await page.getByLabel("Time").selectOption("1h");
    await page.getByLabel("Environment").selectOption("development");
    await page.getByRole("button", { name: "Search" }).click();

    // The empty custom range is dropped from the address, with a real redirect.
    await expect(page).toHaveURL(`/?q=${ENTITY_ID}&window=1h&environment=development`);
    const row = page.getByRole("listitem").filter({ hasText: `customer: ${ENTITY_ID}` });
    await expect(row).toHaveCount(1);
    await expect(
      page.getByText("Journeys in development whose last activity is in the last hour.")
    ).toBeVisible();
    // Search rows carry their environment from the API release that added
    // it; against an API from before it, the row shows none rather than a
    // guess, and there is nothing to assert.
    if (await searchRowsCarryEnvironment()) {
      await expect(row.locator(".environment")).toHaveText("development");
    }

    // An environment the journey is not in finds nothing: the filter reached
    // the API rather than being dropped on the way.
    await page.goto(`/?q=${ENTITY_ID}&environment=production`);
    await expect(page.getByText(`Nothing matched ${ENTITY_ID} here.`)).toBeVisible();
    await expect(page.getByLabel("Environment")).toHaveValue("production");
  });

  test("a missing journey still answers 404", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    const response = await page.goto(`/journeys/jrn_nojs_missing_${RUN}`);
    expect(response?.status()).toBe(404);
    // The status only. When a page calls notFound(), Next 15 abandons the
    // server render and sends its own empty error document
    // (`<html id="__next_error__">`, built in next's app-render.js
    // getErrorRSCPayload); the not-found body is only in the RSC payload, which
    // a script renders. Neither this app's layout nor not-found.tsx is in that
    // HTML, so nothing here can put the text there. It is not `connection()` in
    // not-found.tsx: without it the document is the same.
  });

  test("a path nothing matches answers 404 with the not-found page", async ({ page }) => {
    // Rendered as a page of its own, not as a caught notFound(), so the body is
    // in the HTML. No sign-in: this path is outside the authenticated group.
    const response = await page.goto(`/no-such-page-${RUN}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    await expect(page.getByText("Nothing is recorded here.")).toBeVisible();
  });
});

test("the Journeys page drops empty filters with a real 307", async ({ page }) => {
  await signIn(page, JOURNEY_ID);
  const response = await page.request.get("/journeys?status=&service=", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toBe("/journeys");
});

/**
 * With JavaScript, the same pages say they are loading. The next response is
 * held back so the feedback has time to be seen.
 */
test.describe("with JavaScript", () => {
  const HOLD_MS = 1500;
  const hold = async (route: Route): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    await route.continue();
  };
  /** Before hydration an element is only HTML and gives no feedback, correctly. */
  const hydrated = async (page: Page, selector: string): Promise<void> => {
    await expect
      .poll(() =>
        page.evaluate((css) => {
          const element = document.querySelector(css);
          return (
            element !== null && Object.keys(element).some((key) => key.startsWith("__reactProps"))
          );
        }, selector)
      )
      .toBe(true);
  };

  test("a sent search says so and marks its button busy", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.route((url) => url.pathname === "/" && url.searchParams.has("q"), hold);
    await page.getByRole("textbox", { name: "Search" }).fill(ENTITY_ID);
    await hydrated(page, "form.search-form");

    // Clicked and read in one step: Playwright's own actions and assertions
    // wait for the held navigation to finish, by which time the old page, and
    // its feedback, are gone. The held response keeps the old page up here.
    const sent = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>("form.search-form button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        status: document.querySelector("[role=status].pending-status")?.textContent,
        busy: document.querySelector("form.search-form button")?.getAttribute("aria-busy")
      };
    });
    expect(sent).toEqual({ status: "Searching…", busy: "true" });

    await expect(page).toHaveURL(`/?q=${ENTITY_ID}`);
    await expect(page.getByRole("link", { name: `customer: ${ENTITY_ID}` })).toBeVisible();
  });

  test("a followed nav link shows a marker until the page arrives", async ({ page }) => {
    await signIn(page, JOURNEY_ID);
    await page.route((url) => url.pathname === "/journeys", hold);
    await hydrated(page, '.site-nav a[href="/journeys"]');
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("link", { name: "Journeys" }).click();

    await expect(nav.locator(".link-pending")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Journeys" })).toBeVisible();
    await expect(nav.locator(".link-pending")).toHaveCount(0);
  });
});
