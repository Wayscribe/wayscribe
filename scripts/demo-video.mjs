/**
 * Records the demo video: one customer record, the step where its phone number
 * was lost, and a replay of that step against a corrected handler.
 *
 * Like `pnpm screenshots`, it runs against the demo stack and seeds what it
 * needs through the demo's own webhook, so the video can be remade in one
 * command whenever the web app changes:
 *
 *   docker compose -f infrastructure/compose.yaml \
 *     -f infrastructure/compose.demo.yaml up --build -d
 *   pnpm demo:video
 *   pnpm demo:video --narrate
 *
 * With --narrate it first renders scripts/demo-narration.json with Kokoro (set
 * up as scripts/demo-narrate.mjs describes), holds every caption on screen for
 * at least its line plus a breath, so the recording is paced to the voice, and
 * then writes wayscribe-demo-narrated.mp4 beside the silent video.
 *
 * Writes wayscribe-demo.mp4 (the whole walk-through, H.264) and
 * wayscribe-diff.gif (the diff moment, for the README) to OUT_DIR, plus a still
 * at every caption so the result can be checked without playing it. The videos
 * are not committed; OUT_DIR defaults to a directory outside the repository.
 *
 * Requires ADMIN_TOKEN, a stack on WEB_URL and API_URL, the demo profile on
 * DEMO_SOURCE_URL, and ffmpeg (FFMPEG). DEMO_REPLAY_URL can point replay at a
 * host-visible demo integration service; its default remains the Compose DNS
 * name. Signs in the way the end-to-end suite does, in a browser context that
 * is not recorded, so the sign-in page never appears in the video.
 *
 * Every caption has to stay true to what is on screen. If the demo changes what
 * it shows, change the caption rather than the other way round.
 */
/* global document, window -- the functions passed to page.evaluate run in the browser */
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { mixNarration, renderNarration } from "./demo-narrate.mjs";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3000";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const SOURCE_URL = process.env["DEMO_SOURCE_URL"] ?? "http://localhost:3100";
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "replace-for-local-development-0000";
const ENTITY_ID = process.env["ENTITY_ID"] ?? "0018Z00002ABC";
const PROJECT = process.env["PROJECT_NAME"] ?? "Demo";
const REPLAY_URL = process.env["DEMO_REPLAY_URL"] ?? "http://demo-integration:3200";
const FFMPEG = process.env["FFMPEG"] ?? "ffmpeg";
const OUT = process.env["OUT_DIR"] ?? join(tmpdir(), "wayscribe-demo-video");
const NARRATE = process.argv.includes("--narrate");

// 720p is what a README reader or a social feed plays. Playwright's recorder
// captures CSS pixels, so a higher device scale factor adds nothing to it.
const VIEWPORT = { width: 1280, height: 720 };

/**
 * The reference account twice: once as the broken transformation needs it
 * (carrying `Phone__c`), which reaches the target, and once as Salesforce
 * really sends it, which dead-letters. The failed one is triggered last so it
 * is the newest, and the one the search lists first.
 */
const WANTED = [
  { status: "completed", account: { Phone__c: "+1 919 555 1234" } },
  { status: "failed", account: {} }
];

const REPLAY_DESTINATION = {
  name: "demo-integration (corrected)",
  url: REPLAY_URL
};

const LAST_STEP = { failed: "move-message-to-dead-letter", completed: "finish" };
// RECENT_MS in apps/web/src/lib/timeline.ts: inside it the timeline shows a
// Live toggle, which is not what a reader looking at an old failure sees.
const RECENT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function resolveProject() {
  const { data } = await api("/v1/projects");
  const demo = (data.items ?? []).find((project) => project.slug === "demo");
  if (demo === undefined) throw new Error('No project with slug "demo". Is the demo profile up?');
  projectId = demo.id;
}

const settled = (journey, status) =>
  journey.status === status && journey.lastStep === LAST_STEP[status];

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
  const deadline = Date.now() + 90_000;
  for (;;) {
    const journey = (await api(`/v1/journeys/${journeyId}`)).data;
    if (settled(journey, status)) return journeyId;
    if (Date.now() > deadline) {
      throw new Error(`${journeyId} is ${String(journey.status)}, not ${status}.`);
    }
    await sleep(1_000);
  }
}

/** Returns the ids of the completed and the failed journey, seeding what is missing. */
async function seedJourneys() {
  const found = (await api(`/v1/search?q=${encodeURIComponent(ENTITY_ID)}`)).data.items ?? [];
  const ids = {};
  for (const { status, account } of WANTED) {
    const existing = found.find((journey) => settled(journey, status));
    if (existing === undefined) console.log(`  seeding ${ENTITY_ID} ${status}`);
    ids[status] = existing?.journeyId ?? (await trigger({ Id: ENTITY_ID, ...account }, status));
  }
  return ids;
}

async function ensureReplayDestination() {
  const { data } = await api("/v1/replay-destinations");
  const existing = (data.items ?? []).find(
    (item) =>
      item.name === REPLAY_DESTINATION.name &&
      item.baseUrl === REPLAY_DESTINATION.url &&
      item.enabled
  );
  if (existing !== undefined) return existing.id;
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
  return created.data.id;
}

async function waitOutLiveWindow(journeyIds) {
  let latest = 0;
  for (const id of journeyIds) {
    const journey = (await api(`/v1/journeys/${id}`)).data;
    latest = Math.max(latest, Date.parse(journey.lastEventAt));
  }
  const remaining = RECENT_MS + 1_000 - (Date.now() - latest);
  if (remaining > 0) {
    console.log(`  waiting ${String(Math.ceil(remaining / 1000))}s for the Live window to close`);
    await sleep(remaining);
  }
}

// ---------------------------------------------------------------------------
// Cards, captions and a visible cursor.
//
// Everything injected into the app's pages is built with createElement and
// element.style, never an inline style attribute or a <style> tag, because the
// web app's content security policy allows styles only by nonce.

const CARD_HTML = (lines, small) => `<!doctype html><html><body style="margin:0;height:100vh;
display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0f172a;
color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
text-align:center">${lines
  .map(
    (line) =>
      `<div style="font-size:44px;font-weight:600;line-height:1.3;max-width:1000px">${line}</div>`
  )
  .join(
    ""
  )}${small === undefined ? "" : `<div style="margin-top:28px;font-size:26px;color:#94a3b8">${small}</div>`}</body></html>`;

async function ensureOverlay(page, cursor) {
  await page.evaluate(({ x, y }) => {
    if (document.getElementById("demo-cursor") !== null) return;
    const dot = document.createElement("div");
    dot.id = "demo-cursor";
    Object.assign(dot.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "22px",
      height: "22px",
      marginLeft: "-11px",
      marginTop: "-11px",
      borderRadius: "50%",
      background: "rgba(37, 99, 235, 0.35)",
      border: "2px solid rgba(37, 99, 235, 0.9)",
      boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
      transform: `translate(${String(x)}px, ${String(y)}px)`,
      transition: "transform 0s",
      zIndex: "2147483647",
      pointerEvents: "none"
    });
    document.body.appendChild(dot);

    const caption = document.createElement("div");
    caption.id = "demo-caption";
    Object.assign(caption.style, {
      position: "fixed",
      left: "50%",
      bottom: "22px",
      transform: "translateX(-50%)",
      maxWidth: "1200px",
      whiteSpace: "nowrap",
      padding: "11px 22px",
      borderRadius: "10px",
      background: "rgba(15, 23, 42, 0.92)",
      color: "#f8fafc",
      font: "500 22px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
      textAlign: "center",
      boxShadow: "0 4px 18px rgba(0,0,0,0.25)",
      zIndex: "2147483646",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 250ms ease"
    });
    document.body.appendChild(caption);
  }, cursor);
}

/** Marks, in milliseconds from the start of recording, for the stills and the GIF. */
const marks = [];
let recordingStartedAt = 0;
const now = () => Date.now() - recordingStartedAt;

/** Seconds each caption has to stay up for its narration, by name; empty when silent. */
let holdFor = {};

function addMark(name, text) {
  marks.push({ name, text, at: now() });
}

/**
 * Waits until the latest caption's narration has finished, less `reserveMs`:
 * called before anything that changes the scene, so the voice never describes
 * a screen that has already gone. A no-op without --narrate.
 */
async function hold(reserveMs = 0) {
  const last = marks.at(-1);
  const seconds = last === undefined ? undefined : holdFor[last.name];
  if (seconds === undefined) return;
  const remaining = last.at + seconds * 1000 - reserveMs - now();
  if (remaining > 0) await sleep(remaining);
}

// The time a click spends gliding and pulsing before it lands; a hold with
// this reserve lets the click land as the line ends.
const CLICK_LEAD_MS = 1_000;

function createDirector(page) {
  const cursor = { x: 640, y: 360 };
  let captionText = "";

  const overlay = async () => {
    await ensureOverlay(page, cursor);
    if (captionText !== "") await setCaptionText(captionText);
  };

  const setCaptionText = (text) =>
    page.evaluate((value) => {
      const element = document.getElementById("demo-caption");
      if (element === null) return;
      element.textContent = value;
      element.style.opacity = value === "" ? "0" : "1";
    }, text);

  return {
    overlay,
    async caption(text, name) {
      await hold();
      captionText = text;
      await overlay();
      await setCaptionText(text);
      addMark(name, text);
      console.log(`  ${(now() / 1000).toFixed(1)}s  ${text}`);
    },
    async clearCaption() {
      captionText = "";
      await setCaptionText("");
    },
    /** Glides the visible cursor to the centre of a locator, over `ms`. */
    async moveTo(locator, ms = 900) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (box === null) throw new Error("Nothing to point at.");
      const x = Math.round(box.x + Math.min(box.width / 2, 120));
      const y = Math.round(box.y + box.height / 2);
      await overlay();
      await page.evaluate(
        ({ x, y, ms }) => {
          const dot = document.getElementById("demo-cursor");
          if (dot === null) return;
          dot.style.transition = `transform ${String(ms)}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          dot.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
        },
        { x, y, ms }
      );
      await page.mouse.move(x, y, { steps: 12 });
      await sleep(ms + 100);
      cursor.x = x;
      cursor.y = y;
    },
    /** Moves to a locator, pulses the cursor so the click is visible, and clicks. */
    async click(locator, { ms = 900, wait = "load" } = {}) {
      await this.moveTo(locator, ms);
      await page.evaluate(() => {
        const dot = document.getElementById("demo-cursor");
        if (dot === null) return;
        dot.animate(
          [
            { boxShadow: "0 0 0 0 rgba(37, 99, 235, 0.6)" },
            { boxShadow: "0 0 0 18px rgba(37, 99, 235, 0)" }
          ],
          { duration: 450 }
        );
      });
      await sleep(350);
      await locator.click();
      if (wait !== null) await page.waitForLoadState(wait);
      await overlay();
    },
    /** Scrolls the page smoothly so `locator` sits `offset` pixels from the top. */
    async scrollTo(locator, offset = 90) {
      const top = await locator.evaluate(
        (element, offset) => element.getBoundingClientRect().top + window.scrollY - offset,
        offset
      );
      await page.evaluate((top) => window.scrollTo({ top, behavior: "smooth" }), top);
      await sleep(900);
    },
    /** Outlines elements to draw the eye, with element.style so the CSP allows it. */
    async outline(locator, color = "#dc2626") {
      await locator.evaluateAll((elements, color) => {
        for (const element of elements) {
          element.style.outline = `3px solid ${color}`;
          element.style.outlineOffset = "-3px";
        }
      }, color);
    }
  };
}

// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
// Render first: a broken voice setup should fail before the stack is touched.
if (NARRATE) holdFor = await renderNarration(OUT);
const RAW = join(OUT, "raw");
await rm(RAW, { recursive: true, force: true });
await mkdir(RAW, { recursive: true });

await resolveProject();
const journeys = await seedJourneys();
const replayDestinationId = await ensureReplayDestination();
await waitOutLiveWindow([journeys.completed, journeys.failed]);

const browser = await chromium.launch();
try {
  // Sign in where nothing is recorded, then hand the session to the recording.
  const signIn = await browser.newContext({ viewport: VIEWPORT });
  const login = await signIn.newPage();
  await login.goto(`${WEB_URL}/login`);
  await login.fill("#token", ADMIN_TOKEN);
  await login.click("button[type=submit]");
  await login.waitForLoadState("networkidle");
  const storageState = await signIn.storageState();
  await signIn.close();

  const context = await browser.newContext({
    viewport: VIEWPORT,
    storageState,
    recordVideo: { dir: RAW, size: VIEWPORT }
  });
  const page = await context.newPage();
  recordingStartedAt = Date.now();
  const director = createDirector(page);

  // 1. Title card.
  await page.setContent(
    CARD_HTML(["A customer's phone number vanished", "between Salesforce and the CRM.", "Where?"])
  );
  addMark("title", "Title card");
  await sleep(4_500);
  await hold();

  // 2. Search for the account.
  await page.goto(`${WEB_URL}/`);
  await page.waitForLoadState("networkidle");
  await director.caption("Search for the account by its Salesforce ID", "search");
  const query = page.locator("input[name=q]");
  await director.click(query, { wait: null });
  await query.pressSequentially(ENTITY_ID, { delay: 90 });
  await sleep(400);
  await director.click(page.locator("button[type=submit]", { hasText: "Search" }), {
    wait: "networkidle"
  });
  if (page.url().includes("/projects")) {
    await director.click(page.locator("button", { hasText: PROJECT }).first(), {
      wait: "networkidle"
    });
  }
  await page.waitForSelector("a[href^='/journeys/']");
  await director.caption("Two journeys for this account: one completed, one failed", "results");
  await sleep(4_500);

  // 3. The failed journey's timeline.
  const failedLink = page.locator(`a[href^='/journeys/${journeys.failed}']`).first();
  await hold(CLICK_LEAD_MS);
  await director.click(failedLink, { wait: "networkidle" });
  await page.waitForSelector("text=All times UTC");
  await director.overlay();
  await director.scrollTo(page.locator("a[href*='?event=']").first(), 14);
  await director.caption(
    "The timeline begins with the webhook and follows work from the integration service into the worker",
    "timeline"
  );
  await sleep(6_500);

  // 4. The transform step and its diff: the moment the video exists for.
  const transform = page.locator("a[href*='?event=']", { hasText: "transform-salesforce" }).first();
  await director.caption(
    "It failed at delivery, but where was the phone lost? Open the transform step.",
    "open-transform"
  );
  await sleep(1_200);
  await hold(CLICK_LEAD_MS);
  await director.click(transform, { wait: "networkidle" });
  await page.waitForSelector("text=What changed");
  await director.overlay();
  await director.scrollTo(page.locator("a[href*='?event=']").first(), 14);
  await director.caption("The payload before and after this step, field by field", "diff");
  await sleep(3_000);
  const phoneRows = page.locator("tr", {
    has: page.locator("td:text-is('Phone'), td:text-is('phone')")
  });
  await director.moveTo(phoneRows.first(), 900);
  await director.outline(phoneRows);
  await director.caption(
    "Phone goes in with a value, phone comes out null. This step lost it.",
    "diff-phone"
  );
  await sleep(8_000);
  await hold();

  // 5. The run that worked, for comparison.
  await page.goto(`${WEB_URL}/journeys/${journeys.completed}`);
  await page.waitForSelector("text=All times UTC");
  await director.overlay();
  await director.scrollTo(page.locator("a[href*='?event=']").first(), 14);
  const goodTransform = page
    .locator("a[href*='?event=']", { hasText: "transform-salesforce" })
    .first();
  await director.caption("For comparison, the journey that completed", "good");
  await sleep(1_500);
  await hold(CLICK_LEAD_MS);
  await director.click(goodTransform, { wait: "networkidle" });
  await page.waitForSelector("text=What changed");
  await director.overlay();
  await director.scrollTo(page.locator("a[href*='?event=']").first(), 14);
  const goodPhone = page.locator("tr", { has: page.locator("td:text-is('phone')") });
  await director.moveTo(goodPhone.first(), 900);
  await director.outline(goodPhone, "#16a34a");
  await director.caption(
    "Its payload also carried Phone__c, the field the transform reads, so phone kept its value",
    "good-phone"
  );
  await sleep(6_000);
  await hold();

  // 6. Replay the failed step's input against the corrected handler.
  await page.goto(`${WEB_URL}/journeys/${journeys.failed}`);
  await page.waitForSelector("text=All times UTC");
  await director.overlay();
  await director.scrollTo(page.locator("a[href*='?event=']").first(), 14);
  await director.click(
    page.locator("a[href*='?event=']", { hasText: "transform-salesforce" }).first(),
    { wait: "networkidle", ms: 700 }
  );
  await page.waitForSelector("text=What changed");
  await director.overlay();
  const replayLink = page.locator("a", { hasText: "Replay this input" });
  await director.caption(
    "Back on the failed journey, replay that step's recorded input",
    "replay-link"
  );
  await hold(CLICK_LEAD_MS);
  await director.click(replayLink, { wait: "networkidle" });
  await page.waitForSelector("text=What will be sent");
  await director.overlay();
  await director.caption(
    "Sent to a development destination running the corrected transform, not the original system",
    "replay-form"
  );
  await page.selectOption("#destinationId", replayDestinationId);
  await director.moveTo(page.locator("#destinationId"), 800);
  await sleep(1_800);
  await director.moveTo(page.locator("pre").first(), 700);
  await sleep(1_500);
  await hold(CLICK_LEAD_MS);
  await director.click(page.locator("button", { hasText: "Send replay" }), { wait: "networkidle" });
  await page.waitForSelector("text=Original versus replay");
  await director.overlay();
  await director.scrollTo(page.locator("h2", { hasText: "Response" }), 60);
  await director.caption("The corrected transform answers 200", "replay-response");
  await sleep(3_000);
  await hold();
  await director.scrollTo(page.locator("h2", { hasText: "Original versus replay" }), 200);
  const replayPhone = page.locator("tr", { has: page.locator("td:text-is('phone')") });
  await director.moveTo(replayPhone.last(), 800);
  await director.outline(replayPhone.last(), "#16a34a");
  await director.caption(
    "Original versus replay: phone was null, and now it keeps the number",
    "replay-diff"
  );
  await sleep(6_000);
  await hold();

  // 7. End card. Off the app's origin first: its CSP would refuse the card's
  // inline styles, and the card would render as unstyled text.
  await page.goto("about:blank");
  await page.setContent(
    CARD_HTML(["Wayscribe"], "Self-hosted · open source (Apache-2.0) · wayscribe.dev")
  );
  addMark("end", "End card");
  await sleep(5_000);
  await hold();
  addMark("stop", "");

  await context.close();
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------
// Encode.

const [webm] = (await readdir(RAW)).filter((name) => name.endsWith(".webm"));
if (webm === undefined) throw new Error("Playwright wrote no video.");
const source = join(RAW, webm);
const at = (name) => marks.find((mark) => mark.name === name).at / 1000;
const start = at("title");
const end = at("stop");
const mp4 = join(OUT, "wayscribe-demo.mp4");
const gif = join(OUT, "wayscribe-diff.gif");

const ffmpeg = (args) =>
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);

ffmpeg([
  "-ss",
  start.toFixed(2),
  "-to",
  end.toFixed(2),
  "-i",
  source,
  "-vf",
  "fps=30,format=yuv420p",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "18",
  "-tune",
  "stillimage",
  "-movflags",
  "+faststart",
  "-an",
  mp4
]);

// The GIF is the diff moment alone: the transform step opening, the phone rows
// outlined, and the caption that says what they show.
const gifStart = at("diff") - start + 0.3;
const gifEnd = at("good") - start - 0.3;
ffmpeg([
  "-ss",
  gifStart.toFixed(2),
  "-to",
  gifEnd.toFixed(2),
  "-i",
  mp4,
  "-vf",
  "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  gif
]);

// A still just after each caption appears, so the result can be reviewed
// without playing it.
const STILLS = join(OUT, "stills");
await rm(STILLS, { recursive: true, force: true });
await mkdir(STILLS, { recursive: true });
const captions = [];
for (const [index, mark] of marks.entries()) {
  if (mark.name === "stop") continue;
  const t = mark.at / 1000 - start;
  const next = marks[index + 1];
  const still = Math.min(t + 1.5, next === undefined ? t + 1.5 : next.at / 1000 - start - 0.2);
  const name = `${String(index + 1).padStart(2, "0")}-${mark.name}.png`;
  ffmpeg(["-ss", Math.max(0, still).toFixed(2), "-i", mp4, "-frames:v", "1", join(STILLS, name)]);
  captions.push({ at: Number(t.toFixed(2)), name: mark.name, text: mark.text, still: name });
}
await writeFile(join(OUT, "captions.json"), `${JSON.stringify(captions, null, 2)}\n`);
await rename(source, join(OUT, "raw.webm"));
await rm(RAW, { recursive: true, force: true });

console.log(`\n  ${mp4}\n  ${gif}\n  ${STILLS}/`);
console.log(`  ${(end - start).toFixed(1)}s. Regenerate any time with: pnpm demo:video`);

if (NARRATE) await mixNarration(OUT);
