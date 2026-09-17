/**
 * Regenerates the screenshots in README.md and on the website.
 *
 * These are the only part of the README a reader takes in without reading, and
 * a stale one is worse than none: it shows a product that no longer exists.
 * Generating them from the running demo means they can be refreshed in one
 * command rather than recaptured by hand and quietly drifting.
 *
 *   docker compose -f infrastructure/compose.yaml \
 *     -f infrastructure/compose.demo.yaml up --build -d
 *   pnpm screenshots
 *
 * It seeds the journeys it needs itself, through the demo's own webhook, and
 * triggers only what is missing, so running it twice does not fill the search
 * page with copies of the same journey. That is what it used to do: the search
 * shot showed one journey three times, because `pnpm demo:trigger` had been run
 * three times and the demo had only ever had one account to send.
 *
 * Requires ADMIN_TOKEN, a stack on WEB_URL and API_URL, and the demo profile on
 * SOURCE_URL. Uses the same sign-in the end-to-end suite uses.
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3000";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const SOURCE_URL = process.env["DEMO_SOURCE_URL"] ?? "http://localhost:3100";
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "replace-for-local-development-0000";
const ENTITY_ID = process.env["ENTITY_ID"] ?? "0018Z00002ABC";
const PROJECT = process.env["PROJECT_NAME"] ?? "Demo";
// The demo worker's service, so the Journeys shot lists the demo's journeys
// and not whatever else the database holds, such as the browser suite's.
const JOURNEYS_SERVICE = process.env["JOURNEYS_SERVICE"] ?? "demo-worker";
const OUT = fileURLToPath(new URL("../docs/images/", import.meta.url));

// Wide enough that the timeline and the detail pane sit side by side, which is
// the layout worth showing; tall enough that the diff is not cut off.
const VIEWPORT = { width: 1280, height: 900 };

/**
 * What the shots should find in the database.
 *
 * The reference account twice, once as it is documented and once carrying the
 * field the broken transformation reads, and two other accounts, so a search
 * lists journeys a reader can tell apart and the Journeys page lists more than
 * one customer. `Phone__c` present is the only difference between a journey
 * that reaches the target and one that dead-letters.
 */
const WANTED = [
  { id: ENTITY_ID, status: "completed", account: { Phone__c: "+1 919 555 1234" } },
  {
    id: "0018Z00002QRS",
    status: "completed",
    account: { Name: "Northwind Traders", Phone: "+1 919 555 0142", Phone__c: "+1 919 555 0142" }
  },
  {
    id: "0018Z00002XYZ",
    status: "failed",
    account: { Name: "Acme Robotics", Phone: "+1 415 555 0177", Status__c: "Prospect" }
  },
  // Last, so the journey the other shots open is the newest one the search
  // lists: the reader is looking at the failure, not at the run that worked.
  { id: ENTITY_ID, status: "failed", account: {} }
];

/** The demo's replay destination, as DEMO_SCENARIO.md section 10 describes it. */
const REPLAY_DESTINATION = {
  name: "demo-integration (corrected)",
  url: "http://demo-integration:3200"
};
const REPLAY_PATH = "/replay/customer";

let projectId = "";

async function api(path, init = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(projectId === "" ? {} : { "x-wayscribe-project-id": projectId }),
      ...init.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, data: body.data ?? {} };
}

/**
 * The demo project, so every call below reads the same one.
 *
 * An admin token reads one named project, and the "only project" fallback makes
 * this depend on whether anything else was ever seeded into the stack.
 */
async function resolveProject() {
  const { data } = await api("/v1/projects");
  const demo = (data.items ?? []).find((project) => project.slug === "demo");
  if (demo === undefined) throw new Error('No project with slug "demo". Is the demo profile up?');
  projectId = demo.id;
}

const journeysFor = async (id) =>
  (await api(`/v1/search?q=${encodeURIComponent(id)}`)).data.items ?? [];

/**
 * A journey is done when its last step has been recorded, which is not the same
 * as its status settling. A delivery that the target refuses marks the journey
 * failed on the first attempt, with three more steps still to come; screenshot
 * it then and the search page shows a journey with seven events that the
 * timeline shows with ten.
 */
const LAST_STEP = { failed: "move-message-to-dead-letter", completed: "finish" };

const settled = (journey, status) =>
  journey.status === status && journey.lastStep === LAST_STEP[status];

/**
 * How long the journey page keeps offering Live updates after the last event,
 * from `RECENT_MS` in apps/web/src/lib/timeline.ts. Repeated here rather than
 * imported because this script is plain Node and that is TypeScript.
 */
const RECENT_MS = 30_000;

/**
 * Wait for a journey to stop being recent.
 *
 * Inside that window the timeline offers a checked Live toggle and polls. That
 * is correct behaviour and the wrong picture: whether the chip is in the shot
 * would depend on how fast the machine seeded, and the reader these shots are
 * for is looking at a failure that happened earlier, not watching one arrive.
 */
async function waitUntilSettledLongEnough(journeyId) {
  const journey = (await api(`/v1/journeys/${journeyId}`)).data;
  const remaining = RECENT_MS + 1_000 - (Date.now() - Date.parse(journey.lastEventAt));
  if (remaining <= 0) return;
  console.log(`  waiting ${String(Math.ceil(remaining / 1000))}s for the Live window to close`);
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

/** Fires one webhook and waits for the journey to reach its last step. */
async function trigger(account, status) {
  const response = await fetch(`${SOURCE_URL}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(account)
  });
  if (!response.ok) {
    throw new Error(`The demo source at ${SOURCE_URL} answered ${String(response.status)}.`);
  }
  const { journeyId } = await response.json();

  // A delivery that fails retries on the queue's visibility timeout, so a
  // dead-lettering journey takes roughly ten seconds. Poll rather than sleep.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const journey = (await api(`/v1/journeys/${journeyId}`)).data;
    if (settled(journey, status)) return journeyId;
    if (Date.now() > deadline) {
      throw new Error(
        `${journeyId} is ${String(journey.status)} at ${String(journey.lastStep)}, not ${status}.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Returns the reference journey the timeline, diff and replay shots open. */
async function seedJourneys() {
  let reference = "";
  for (const { id, status, account } of WANTED) {
    const existing = (await journeysFor(id)).find((journey) => settled(journey, status));
    let journeyId = existing?.journeyId;
    if (journeyId === undefined) {
      console.log(`  seeding ${id} ${status}`);
      journeyId = await trigger({ Id: id, ...account }, status);
    } else {
      console.log(`  have ${id} ${status}`);
    }
    if (id === ENTITY_ID && status === "failed") reference = journeyId;
  }
  if (reference === "") throw new Error(`No failed journey for ${ENTITY_ID}.`);
  return reference;
}

/** The replay destination, created once and found on every run after that. */
async function ensureReplayDestination() {
  const { data } = await api("/v1/replay-destinations");
  const found = (data.items ?? []).find((item) => item.name === REPLAY_DESTINATION.name);
  if (found !== undefined) return;
  const created = await api("/v1/replay-destinations", {
    method: "POST",
    body: JSON.stringify({
      name: REPLAY_DESTINATION.name,
      baseUrl: REPLAY_DESTINATION.url,
      environmentType: "development"
    })
  });
  if (created.status !== 201) {
    throw new Error(`Creating the replay destination answered ${String(created.status)}.`);
  }
}

await mkdir(OUT, { recursive: true });

await resolveProject();
const REFERENCE_JOURNEY = await seedJourneys();
await ensureReplayDestination();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });

async function search() {
  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");
}

async function shot(name, options = {}) {
  await page.screenshot({ path: `${OUT}${name}.png`, ...options });
  console.log(`  docs/images/${name}.png`);
}

try {
  await page.goto(`${WEB_URL}/login`);
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  await search();

  // With more than one project the first search asks which one. Choosing hands
  // the query back, so there is nothing to retype.
  if (page.url().includes("/projects")) {
    await page.locator("button", { hasText: PROJECT }).first().click();
    await page.waitForLoadState("networkidle");
  }

  await page.waitForSelector("a[href^='/journeys/']");
  await shot("search");

  await page.goto(`${WEB_URL}/journeys?service=${encodeURIComponent(JOURNEYS_SERVICE)}`);
  await page.waitForSelector("table tbody tr");
  await shot("journeys");

  // The reference journey by id rather than the first search hit: which journey
  // a search lists first depends on which was written last, and these three
  // shots are all about the one that dead-lettered.
  await waitUntilSettledLongEnough(REFERENCE_JOURNEY);
  await page.goto(`${WEB_URL}/journeys/${REFERENCE_JOURNEY}`);
  await page.waitForSelector("text=All times UTC");
  await shot("timeline");

  // The transformation is the step the whole product exists to show.
  await page
    .click("a[href*='?event=']:near(:text('transformed'))", { timeout: 5_000 })
    .catch(async () => {
      const transformed = page.locator("li:has-text('transformed') a").first();
      await transformed.click();
    });
  await page.waitForSelector("text=What changed");
  await shot("diff");

  // Replay: the other half of the product. Send that same step's recorded input
  // to the demo's corrected handler and compare the result with the original.
  await page.click("a:has-text('Replay this input')");
  await page.waitForSelector("text=What will be sent");
  // The option's text is "<name>: <base url> (<type>)", so it is matched on the
  // name rather than reconstructed; the rest of the line is the screen's copy
  // and not this script's business.
  const destination = await page.$eval(
    "#destinationId",
    (select, name) => [...select.options].find((option) => option.text.includes(name))?.value,
    REPLAY_DESTINATION.name
  );
  await page.selectOption("#destinationId", destination);
  await page.fill("#path", REPLAY_PATH);
  await page.click("button:has-text('Send replay')");
  await page.waitForSelector("text=Original versus replay");
  // The only full-page shot, at the same width and scale as the others. This
  // page runs about two hundred pixels past the viewport, and the two halves
  // are both the point: what is about to be sent, and the comparison it comes
  // back with. Cropping to the viewport would lose one or the other.
  await shot("replay", { fullPage: true });

  console.log("\nDone. Regenerate any time with: pnpm screenshots");
} finally {
  await browser.close();
}
