/**
 * Records the demo video: one customer record, the step where its phone number
 * was lost, and a replay of that step against a corrected handler.
 *
 * Two stages. The capture drives the real web app against the demo stack and
 * keeps what the screen showed, frame by frame, with marks that say when each
 * moment of the story begins and where on screen its subject is. The render
 * (video/, a Remotion project) turns that into the finished cuts: captions,
 * zoom, a drawn cursor and music.
 *
 *   docker compose -f infrastructure/compose.yaml \
 *     -f infrastructure/compose.demo.yaml up --build -d
 *   pnpm --dir video install
 *   pnpm demo:video                  # capture, then render
 *   pnpm demo:video --capture-only   # capture, with review stills
 *   pnpm demo:video --render-only    # render the last capture again
 *
 * The capture seeds what it needs through the demo's own webhook and signs in
 * in a browser context that is not captured, so the sign-in page never
 * appears. docs/DEMO_RECORDING.md lists the environment it reads. Nothing it
 * writes is committed; OUT_DIR defaults to a directory outside the repository.
 */
/* global window -- the functions passed to page.evaluate run in the browser */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  clickPoint,
  frameAt,
  manifestProblems,
  reviewFilter,
  toBox,
  unionBox
} from "./demo-capture-lib.mjs";
import { planReplayDestination } from "./demo-replay-destination.mjs";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3000";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const SOURCE_URL = process.env["DEMO_SOURCE_URL"] ?? "http://localhost:3100";
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "replace-for-local-development-0000";
const ENTITY_ID = process.env["ENTITY_ID"] ?? "0018Z00002ABC";
const PROJECT = process.env["PROJECT_NAME"] ?? "Demo";
const REPLAY_URL = process.env["DEMO_REPLAY_URL"] ?? "http://demo-integration:3200";
const FFMPEG = process.env["FFMPEG"] ?? "ffmpeg";
// Resolved once, here: the render runs from video/ (pnpm --dir), so a relative OUT_DIR
// would point at video/<dir> there while the capture wrote to <dir> under the cwd.
const OUT = resolve(process.env["OUT_DIR"] ?? join(tmpdir(), "wayscribe-demo-video"));
const CAPTURE = join(OUT, "capture");
const CAPTURE_ONLY = process.argv.includes("--capture-only");
const RENDER_ONLY = process.argv.includes("--render-only");
const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..", "video");

// Laid out at 1920x1080 CSS pixels and captured at twice that, so the render
// can zoom 2x onto a table row and still have a device pixel for every output
// pixel. The capture spike in docs/superpowers/plans/2026-10-04-demo-video-v2.md
// measured the alternatives. The scale comes from a Chromium launch flag: a
// context deviceScaleFactor does not enlarge screencast frames.
const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = 2;
const FRAME = { format: "png" };
const EXTENSION = "png";
// The render glides its drawn cursor to each click over this long
// (LEAD_MS in video/src/cursor.ts), so the capture waits that long before clicking.
const CLICK_LEAD_MS = 800;
// Long enough for the screencast to deliver a frame of a state that just settled.
const SETTLE_MS = 400;

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
  const planned = planReplayDestination(data.items ?? [], REPLAY_DESTINATION.url);
  if (planned.destinationId !== undefined) return planned.destinationId;
  const created = await api("/v1/replay-destinations", {
    method: "POST",
    body: JSON.stringify({
      name: planned.name,
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
// The capture: frames from the browser's own screencast, marks and clicks.

let startedAt = 0;
const now = () => Date.now() - startedAt;
const frames = [];
const marks = [];
const clicks = [];

/**
 * Starts the screencast; returns a function that stops it once every frame is
 * on disk, and throws the first frame that could not be written.
 */
async function startScreencast(page) {
  const session = await page.context().newCDPSession(page);
  const writes = [];
  let accepting = true;
  let writeError;
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    if (!accepting) return;
    const at =
      metadata.timestamp === undefined ? now() : Math.round(metadata.timestamp * 1000 - startedAt);
    const file = `frames/${String(frames.length).padStart(6, "0")}.${EXTENSION}`;
    frames.push({ at, file });
    // Caught here, so a failed write cannot end the process before stop() reports it.
    writes.push(
      writeFile(join(CAPTURE, file), Buffer.from(data, "base64")).catch((error) => {
        writeError ??= error;
      })
    );
    session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", {
    ...FRAME,
    maxWidth: VIEWPORT.width * SCALE,
    maxHeight: VIEWPORT.height * SCALE,
    everyNthFrame: 1
  });
  return async () => {
    try {
      await session.send("Page.stopScreencast");
    } finally {
      // No frame is taken after this, so the frames and writes awaited below are final.
      accepting = false;
      await session.detach().catch(() => undefined);
    }
    await Promise.all(writes);
    if (writeError !== undefined) throw writeError;
  };
}

/** The table row or list item a result link sits in, or the link itself. */
const rowOf = (link) => link.locator("xpath=ancestor-or-self::*[self::tr or self::li][1]");

/** Table rows whose first matching cell holds exactly one of `names`. */
const rowsNamed = (page, names) =>
  page.locator("tr", {
    has: page.locator(names.map((name) => `td:text-is('${name}')`).join(", "))
  });

function createActions(page) {
  const box = async (locator, name) => toBox(await locator.boundingBox(), name, VIEWPORT);
  const boxAll = async (locator, name) => {
    const rects = await locator.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
    );
    return unionBox(rects.map((rect, index) => toBox(rect, `${name}[${String(index)}]`, VIEWPORT)));
  };
  /**
   * The box of `locator`, which must show inside `outer`'s box (to 1 px of
   * rounding). toBox clips to the window only, so a row scrolled out of a list
   * that scrolls in a box of its own would otherwise still get a box.
   */
  const boxWithin = async (locator, outer, name, outerName) => {
    const inner = await box(locator, name);
    const limit = await box(outer, outerName);
    const inside =
      inner.x >= limit.x - 1 &&
      inner.y >= limit.y - 1 &&
      inner.x + inner.width <= limit.x + limit.width + 1 &&
      inner.y + inner.height <= limit.y + limit.height + 1;
    if (!inside) {
      throw new Error(`"${name}" is not inside the visible part of "${outerName}".`);
    }
    return inner;
  };
  return {
    box,
    boxAll,
    boxWithin,
    /** Records a moment of the story once it has settled, with the boxes of what it is about. */
    async mark(name, boxes = {}) {
      await sleep(SETTLE_MS);
      const measured = {};
      for (const [key, target] of Object.entries(boxes)) {
        measured[key] =
          typeof target === "function" ? await target() : await box(target, `${name}.${key}`);
      }
      marks.push({ name, at: now(), boxes: measured });
      console.log(`  ${(now() / 1000).toFixed(1)}s  ${name}`);
    },
    /** Points at a target, waits while the render's cursor glides there, records and clicks. */
    async click(locator, { wait = "load" } = {}) {
      await locator.scrollIntoViewIfNeeded();
      const target = await box(locator, "click target");
      const point = clickPoint(target);
      await page.mouse.move(point.x, point.y);
      await sleep(CLICK_LEAD_MS);
      clicks.push({ at: now(), ...point });
      await locator.click({ position: { x: point.x - target.x, y: point.y - target.y } });
      if (wait !== null) await page.waitForLoadState(wait);
    },
    /** Scrolls at once so `locator` sits `offset` px from the top; the render hides the jump. */
    async scrollTo(locator, offset) {
      const top = await locator.evaluate(
        (element, offset) => element.getBoundingClientRect().top + window.scrollY - offset,
        offset
      );
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), top);
    }
  };
}

async function captureStory(page, journeys, replayDestinationId, failedStep) {
  const act = createActions(page);
  // The timeline's step list. Other links carry ?event= too (the recorded
  // attempts above it, "Replay this input" beside it), so steps are found inside it.
  const steps = page.locator("ol[aria-label='Events']");
  const stepLink = (name) => steps.locator("a[href*='?event=']", { hasText: name }).first();

  // Search for the account.
  await page.goto(`${WEB_URL}/`);
  await page.waitForLoadState("networkidle");
  const query = page.locator("input[name=q]");
  const searchButton = page.locator("button[type=submit]", { hasText: "Search" });
  // The input is much wider than the search and the button sits beside it, so
  // the "row" box (both) is what the render frames to keep the click in shot.
  await act.mark("home", {
    query,
    row: async () =>
      unionBox([await act.box(query, "input"), await act.box(searchButton, "search button")])
  });
  await act.click(query, { wait: null });
  await query.pressSequentially(ENTITY_ID, { delay: 90 });
  await act.click(searchButton, { wait: "networkidle" });
  if (page.url().includes("/projects")) {
    await act.click(page.locator("button", { hasText: PROJECT }).first(), { wait: "networkidle" });
  }
  await page.waitForSelector("a[href^='/journeys/']");
  // Frame whole rows, but click the link itself: a click elsewhere in a row may not navigate.
  const failedLink = page.locator(`a[href^='/journeys/${journeys.failed}']`).first();
  const failedRow = rowOf(failedLink);
  const completedRow = rowOf(page.locator(`a[href^='/journeys/${journeys.completed}']`).first());
  await act.mark("results", {
    failed: failedRow,
    completed: completedRow,
    results: async () =>
      unionBox([
        await act.box(failedRow, "failed row"),
        await act.box(completedRow, "completed row")
      ])
  });

  // The failed journey's timeline.
  await act.click(failedLink, { wait: "networkidle" });
  await page.waitForSelector("text=All times UTC");
  await act.scrollTo(steps, 24);
  // The list scrolls in a box of its own, shorter than the steps, and the failed
  // step is the last of them: bring it into view (the transform step stays at the top).
  await stepLink(failedStep).evaluate((element) =>
    element.scrollIntoView({ block: "nearest", behavior: "instant" })
  );
  await act.mark("timeline", {
    steps,
    failure: () => act.boxWithin(stepLink(failedStep), steps, "timeline.failure", "timeline.steps"),
    transform: () =>
      act.boxWithin(stepLink("transform-salesforce"), steps, "timeline.transform", "timeline.steps")
  });

  // The transform step: what it received and what it produced.
  await act.click(stepLink("transform-salesforce"), { wait: "networkidle" });
  await page.waitForSelector("text=What changed");
  await act.scrollTo(page.getByText("What changed").first(), 24);
  const phoneRows = rowsNamed(page, ["Phone", "phone"]);
  await act.mark("diff", {
    diff: phoneRows.first().locator("xpath=ancestor::table[1]"),
    phone: () => act.boxAll(phoneRows, "phone rows")
  });

  // The completed journey's transform step. The render cuts straight to it,
  // so getting there is not recorded as a click.
  await page.goto(`${WEB_URL}/journeys/${journeys.completed}`);
  await page.waitForSelector("text=All times UTC");
  await stepLink("transform-salesforce").click();
  await page.waitForSelector("text=What changed");
  await act.scrollTo(page.getByText("What changed").first(), 24);
  const goodRows = rowsNamed(page, ["Phone__c", "phone"]);
  await act.mark("good-diff", {
    diff: goodRows.first().locator("xpath=ancestor::table[1]"),
    phone: () => act.boxAll(goodRows, "phone rows")
  });

  // Replay the failed step's recorded input against the corrected handler.
  await page.goto(`${WEB_URL}/journeys/${journeys.failed}`);
  await page.waitForSelector("text=All times UTC");
  await stepLink("transform-salesforce").click();
  await page.waitForSelector("text=What changed");
  const replayLink = page.locator("a", { hasText: "Replay this input" });
  await act.scrollTo(replayLink, 300);
  await act.mark("replay-link", { replay: replayLink });
  await act.click(replayLink, { wait: "networkidle" });
  await page.waitForSelector("text=What will be sent");
  await page.selectOption("#destinationId", replayDestinationId);
  const destination = page.locator("#destinationId");
  const send = page.locator("button", { hasText: "Send replay" });
  await act.mark("replay-form", {
    destination,
    form: async () =>
      unionBox([await act.box(destination, "destination"), await act.box(send, "send")])
  });
  await act.click(send, { wait: "networkidle" });
  await page.waitForSelector("text=Original versus replay");
  const response = page.locator("h2", { hasText: "Response" });
  await act.scrollTo(response, 60);
  await act.mark("replay-response", {
    response: async () =>
      unionBox([
        await act.box(response, "response heading"),
        await act.box(response.locator("xpath=following-sibling::*[1]"), "response body")
      ])
  });
  await act.scrollTo(page.locator("h2", { hasText: "Original versus replay" }), 24);
  const replayPhone = rowsNamed(page, ["phone"]).last();
  await act.mark("comparison", {
    comparison: replayPhone.locator("xpath=ancestor::table[1]"),
    phone: replayPhone
  });
  await act.mark("end");
}

/** A still per mark with its boxes outlined, to check the geometry before rendering. */
function writeReviewStills(manifest) {
  const dir = join(CAPTURE, "review");
  for (const [index, mark] of manifest.marks.entries()) {
    const frame = frameAt(manifest.frames, mark.at);
    execFileSync(FFMPEG, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(CAPTURE, frame.file),
      "-vf",
      reviewFilter(mark.boxes, manifest.scale),
      "-frames:v",
      "1",
      join(dir, `${String(index + 1).padStart(2, "0")}-${mark.name}.png`)
    ]);
  }
}

async function capture() {
  await resolveProject();
  const journeys = await seedJourneys();
  const failedStep = (await api(`/v1/journeys/${journeys.failed}`)).data.failedStep;
  if (typeof failedStep !== "string") throw new Error(`${journeys.failed} reports no failed step.`);
  const replayDestinationId = await ensureReplayDestination();
  await waitOutLiveWindow([journeys.completed, journeys.failed]);
  await rm(CAPTURE, { recursive: true, force: true });
  await mkdir(join(CAPTURE, "frames"), { recursive: true });
  await mkdir(join(CAPTURE, "review"), { recursive: true });

  const browser = await chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`] });
  try {
    // Sign in where nothing is captured, then hand the session over.
    const signIn = await browser.newContext({ viewport: VIEWPORT });
    const login = await signIn.newPage();
    await login.goto(`${WEB_URL}/login`);
    await login.fill("#token", ADMIN_TOKEN);
    await login.click("button[type=submit]");
    await login.waitForLoadState("networkidle");
    const storageState = await signIn.storageState();
    await signIn.close();

    const context = await browser.newContext({ viewport: VIEWPORT, storageState });
    const page = await context.newPage();
    startedAt = Date.now();
    const stop = await startScreencast(page);
    try {
      await captureStory(page, journeys, replayDestinationId, failedStep);
    } catch (error) {
      // Keep the error that ended the story: a crashed page makes stopping fail too.
      await stop().catch((stopError) => {
        console.error(`  stopping the screencast also failed: ${String(stopError)}`);
      });
      throw error;
    }
    await stop();
    await context.close();
  } finally {
    await browser.close();
  }

  const manifest = { version: 1, viewport: VIEWPORT, scale: SCALE, frames, marks, clicks };
  const problems = manifestProblems(manifest);
  if (problems.length > 0)
    throw new Error(`The capture is not usable:\n  ${problems.join("\n  ")}`);
  await writeFile(join(CAPTURE, "marks.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeReviewStills(manifest);
  console.log(`\n  ${String(frames.length)} frames, ${(now() / 1000).toFixed(1)}s: ${CAPTURE}`);
}

function render() {
  if (!existsSync(join(VIDEO, "node_modules"))) {
    throw new Error("The video project is not installed. Run: pnpm --dir video install");
  }
  execFileSync(
    "pnpm",
    ["--dir", VIDEO, "exec", "tsx", "scripts/render.ts", "--capture", CAPTURE, "--out", OUT],
    {
      stdio: "inherit"
    }
  );
}

if (!RENDER_ONLY) await capture();
if (!CAPTURE_ONLY) render();
