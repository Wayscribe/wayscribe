# Demo Video v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the narrated 91-second demo with a muted-first, captioned, about-60-second walkthrough in two cuts (16:9 and 1:1), built from a fresh Playwright capture of the real UI and an edit layer in Remotion, with quiet music from our own synth.

**Architecture:** `scripts/demo-video.mjs` captures the real web app against the demo stack as a sequence of high-resolution frames plus `marks.json` (when each story moment starts and where its subject is on screen). `video/` is a standalone Remotion project, outside the pnpm workspace, that reads that capture and renders both cuts: captions, zoom and pan, a drawn cursor, highlights, cross-fades, and a calm music track rendered by a synth copied from Shorts Studio. ffmpeg muxes the music, controls file size, and produces the posters, GIF, stills and checks.

**Tech Stack:** Node 24, Playwright 1.63 (Chromium, CDP screencast), Remotion 4.0.532 with React 19.3, TypeScript 5.9, Vitest, ffmpeg 8, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-10-04-demo-video-design.md` (approved by Jorge 2026-10-04 with no changes).

---

## Working rules (from Jorge; apply to every task)

- Work in the worktree `~/workspace/wayscribe/.claude/worktrees/demo-video-v2`, branch `demo-video-v2` (based on origin/main 815d886 plus the spec commit). Verify with `git rev-parse --abbrev-ref HEAD` before touching anything.
- No em dashes (or en dashes) in captions, the transcript, code comments or docs. Use colons, commas or parentheses.
- Never print credential files (`~/.npmrc`, `~/.pypirc`, `~/.zshenv`, any `.env`).
- Run the FULL root unit suite (`pnpm test`) before every push. `tests/site.test.ts` asserts landing-page text and several tests walk the whole tree.
- Push intermediate commits with `git push -o ci.skip origin demo-video-v2` (CI minutes are limited). One real pipeline runs before the merge (Task 15), and every CI wait has a deadline.
- Docker in agent shells can hang on the credential helper. Before any `docker` command, use the credential-free config described in Task 1, Step 1.
- Nothing replaces `site/public/videos/` or `docs/images/demo-diff.gif` on main until Jorge has watched both cuts and approved (Task 14 gate). The rendered binaries are not committed before that approval.
- Publishing jobs and anything public need Jorge's explicit yes.

## Decisions and deviations from the spec (read before Task 1)

1. **Scene lengths follow the spec's own reading rule.** At least 1 s per 3 words plus 1 s means the hook card (10 words) needs 4.33 s and the end card (25 words) needs 9.33 s, so they run 4.5 s and 10 s instead of 4 s and 8 s. Total 61.5 s, inside the 55 to 65 s check.
2. **`video/` gets its own `pnpm-workspace.yaml`, like `site/`.** pnpm then treats `video/` as a root of its own, so `pnpm --dir video install` works without `--ignore-workspace`, and the file is where pnpm 11's `allowBuilds` lives. Same effect as the spec's command, established pattern.
3. **Font: Inter (SIL OFL 1.1) from `@fontsource/inter`, pinned exactly.** The docs site uses system fonts only (`site/src/styles/theme.css`), so there is no site font to match. The render copies the woff2 files into its public directory; nothing is fetched at render time.
4. **What is copied from Shorts Studio.** The synthesis core (`types`, `rng`, `notes`, `synth`, `mixer`, `wav`) and its tests. Not copied: `composer`, `mood`, `sfx`, `seam`, `render`: they are the chiptune arranger, wired to Shorts Studio's script and timeline types (`../schema/script`, `../timeline/build`), and nothing here would use them. `scaleMidi` and `makeMotif` are copied out of `composer.ts` into a new `calm.ts`. The synth gains two voices: `sine` (lead and pulse) and `tick` (the two sound effects). `triangle` (bass) and `pad` are used as they are.
5. **One capture format for the edit layer: frames plus `marks.json`.** Whichever method the spike picks, the capture is normalized to numbered image files with timestamps, so Tasks 8 to 12 do not depend on the spike's outcome.
6. **Hold first, then act.** A capture scene shows its opening state while its caption is read, then plays the action that leads to the next scene at real speed, sped up (up to 3x) only when the action is longer than the scene.
7. **Music is muxed after the Remotion render** (Shorts Studio's pattern): Remotion renders a silent near-lossless video, then ffmpeg encodes the final H.264 with the AAC music track, raising CRF until the file fits 8 MB.
8. **Scene 7 also gets a highlight** (green, on the completed journey's phone rows). The spec lists highlights for scenes 6 and 10; the contrast scene reads better with one, and it plays no tick.
9. **Posters** are the midpoint of scene 6 (the zoom onto the lost phone), the frame that says most on its own.
10. **One merge, after approval.** All tooling lands with the new video. Narration is retired in Task 3 so no commit leaves orphaned narration scripts.
11. **Real device scale, PNG frames (from Task 1, approved by Jorge 2026-10-04).** A context `deviceScaleFactor` does not enlarge CDP screencast frames, so Task 3 launches Chromium with `--force-device-scale-factor=2` and sets no context scale; frames are 3840x2160 PNG.
12. **Scene 4 caption (from Task 1, approved by Jorge 2026-10-04).** The failed journey's `failedStep` is `move-message-to-dead-letter`, not a delivery step, so scene 4 reads "Delivery failed twice. Was that where the phone was lost?" (10 words, inside the 5 s scene).

## Spike results (filled in by Task 1)

| Item | Result |
|---|---|
| (a) recordVideo 1920x1080: SSIM of the 2x phone crop against the reference | SSIM 0.960 against the emulated-DSF reference (0.957 to 0.962 over three runs), 0.956 against the real-DSF reference; 25 fps; clip 440 to 780 KB. A 1x frame upscaled 2x: visibly soft and blotchy at the 2.2x zoom cap |
| (b) CDP screencast DSF 2, JPEG 92: SSIM, frame size, frames/s while scrolling, mean bytes/frame | Context `deviceScaleFactor: 2` does NOT enlarge screencast frames: 1920x1080, SSIM 0.968 (1x crop upscaled 2x), 14.9 fps, 231 KB/frame. Real DSF (launch flag `--force-device-scale-factor=2`, no context deviceScaleFactor): 3840x2160, SSIM 0.987 against a same-mode reference, 13.3 fps, 628 KB/frame |
| (b) CDP screencast DSF 2, PNG: SSIM, frame size, frames/s while scrolling, mean bytes/frame | Context DSF 2: 1920x1080, SSIM 0.985 (1x crop upscaled 2x), 14.8 fps, 299 KB/frame. Real DSF (launch flag): 3840x2160, SSIM 1.000 against the same-mode reference (a lossless capture of the same surface), 13.3 fps, 741 KB/frame |
| (c) timed screenshots DSF 2: median ms per screenshot | Median per run: 124, 101 and 103 ms (emulated DSF), 100 ms (CDP screenshot, real DSF), so about 10 screenshots/s at best |
| Chosen method and frame format | CDP screencast, PNG, with Chromium launched with `--force-device-scale-factor=2` and no context deviceScaleFactor: frames 3840x2160 at scale 2, as Tasks 3 and 10 assume, but those tasks must use the launch flag instead of `deviceScaleFactor: 2`. PNG over JPEG by 0.013 SSIM (rule: more than 0.01); JPEG is only 1.18x smaller. Gate A does not trip (recordVideo scores lowest). Under the flag the page reports devicePixelRatio 1 and Playwright's `page.screenshot()` returns 1920x1080, so a full-resolution still needs CDP `Page.captureScreenshot`. At the 2.2x zoom cap: reference, flag PNG and flag JPEG sharp; emulated-DSF PNG softer; recordVideo soft |
| Phone rows box at 1920x1080 (CSS px), diff table box | Phone rows box 861,274,691,180 (emulated DSF) and 861,275,691,179 (real DSF: layout snaps 1 px differently, so boxes are measured in the capture's own mode). The box spans five rows (Phone, Status__c, externalId, name, phone). Gate B does not trip: 691 is under 1016. Diff table box 861.6,175.0,690.4,314.1. The diff page is at its maximum scrollY of 468 (scrollHeight 1548), so "What changed" cannot sit higher than y of about 66 |
| Search result link ancestry (for `rowOf`) | `a < li < ul < main < div` |
| Failed journey's `failedStep` | `move-message-to-dead-letter`, which is NOT a delivery step (delivery steps are `deliver-customer-to-target` and `retry-customer-delivery`); scene 4's "It failed at delivery" does not match the page header "failed at move-message-to-dead-letter" |
| Transform step status shown in the UI (decides scene 6 wording) | Not shown as succeeded: a neutral grey outlined badge reading "transformed" (lowercase, no icon, no colour), detail header "transformed · demo-integration · 0 ms"; no succeeded or ok text anywhere. The badge is the event operation, and the event has hasError=false; failing steps (delivered, retried) get red outlined badges. Keep the caption "The phone goes in with a value and comes out null. This step lost it." |
| Remotion licence for an individual's open-source project | Free. LICENSE.md at tag v4.0.532 lists an individual as eligible, commercial use included; a company licence is needed from 4 employees up (the docs, written for Remotion 5, say 3 people). No attribution, notice or registration is required, and server-side rendering sends no telemetry. Read 2026-10-04: remotion.dev/docs/license (with its pricing, FAQ, telemetry and terms pages) and LICENSE.md at v4.0.532 |
| Comparison image path | Emulated DSF: /var/folders/jt/rbg7dqqn3bb8_8lsvxrfnw2w0000gn/T/wayscribe-demo-video-v2/spike/compare.png. Fair comparison at the 2.2x zoom cap (top to bottom: same-mode reference, flag PNG, flag JPEG, emulated-DSF PNG, recordVideo): .../wayscribe-demo-video-v2/spike-fair/legibility.png |

---

## File structure

**Root repository (modified or created)**

- `scripts/demo-video.mjs`: rewritten. Seeds the demo, signs in outside the capture, drives the story, writes `OUT_DIR/capture/{frames/, marks.json, review/}`, then runs the render. Flags: `--capture-only`, `--render-only`.
- `scripts/demo-capture-lib.mjs` + `scripts/demo-capture-lib.d.mts`: pure helpers (box rounding and clipping, union, click point, manifest validation, review filter, frame lookup).
- `tests/demo-capture.test.ts`: unit tests for the helpers.
- `tests/video-package.test.ts`: `video/` stays out of the root workspace, lint, and images; exact pins; CI job.
- `eslint.config.js`: ignore `video/**`.
- `.dockerignore`, `scripts/verify-image-contents.sh`: keep `video/` out of images.
- `.gitlab-ci.yml`: `video` job (typecheck and tests) on changes under `video/**`.
- `package.json`: drop `demo:narrate`.
- Deleted: `scripts/demo-narrate.mjs`, `scripts/demo-narration.json`, `scripts/demo-tts.py`.
- `docs/DEMO_RECORDING.md`: rewritten for capture then render.
- After approval only: `site/public/videos/*`, `docs/images/demo-diff.gif`, `site/src/content/docs/index.mdx`, `site/README.md`, `tests/site.test.ts`, `CHANGELOG.md`.

**`video/` (new standalone package)**

- `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md`
- `src/index.ts`: `registerRoot`.
- `src/Root.tsx`: two compositions (`DemoWide` 1920x1080, `DemoSquare` 1080x1080), font loading.
- `src/Demo.tsx`: the composition: scenes in sequence with cross-fades.
- `src/components/{CaptureView,Card,Caption,Cursor,Highlight}.tsx`
- `src/theme.ts`: colours and font family.
- `src/geometry.ts`: `Box`, `Point`.
- `src/scenes.ts`: the story: scenes, captions, durations, shots per format, formats.
- `src/captions.ts`: word count, reading time, line estimate.
- `src/capture.ts`: capture types, `frameAt`, `markNamed`, `boxOf`.
- `src/timeline.ts`: scenes to frames, source time mapping, ticks, validation.
- `src/camera.ts`: framing, glides, projection, per-scene camera.
- `src/cursor.ts`: drawn cursor position and click ripple.
- `src/transcript.ts`: transcript text.
- `src/checks.ts`: ffprobe and loudness parsing, output checks.
- `src/fixtures/capture.json`: a capture manifest (synthetic first, replaced by the real one in Task 9).
- `src/audio/{constants,types,rng,notes,synth,mixer,wav}.ts`: copied synth core.
- `src/audio/calm.ts`: the calm arrangement.
- `src/audio/music.ts`: renders the track with fades and ticks.
- `scripts/ffmpeg.ts`: ffmpeg and ffprobe wrappers.
- `scripts/bundle.ts`: assembles the render's public directory and bundles.
- `scripts/preview-stills.ts`: renders a still per scene per format (for review while building).
- `scripts/render.ts`: the full render and its checks.
- `tests/*.test.ts`, `tests/audio/*.test.ts`

---

### Task 1: Capture-quality spike and Remotion licence (GATE)

**Files:**
- Create (temporary, never committed): `scripts/demo-capture-spike.mjs`
- Modify: `docs/superpowers/plans/2026-10-04-demo-video-v2.md` (the "Spike results" table)

- [ ] **Step 1: Bring up the demo stack with a credential-free Docker config**

Check nothing else holds the ports first (`docker ps --format '{{.Names}} {{.Ports}}'`; ports 3000, 3100, 3200, 3300, 8080, 9324 must be free or belong to this project's `infrastructure` compose project).

```bash
SCRATCH="${TMPDIR:-/tmp}/wayscribe-demo-video-v2"
mkdir -p "$SCRATCH/docker-config/cli-plugins"
echo '{}' > "$SCRATCH/docker-config/config.json"
ln -sf /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx "$SCRATCH/docker-config/cli-plugins/docker-buildx"
ln -sf /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose "$SCRATCH/docker-config/cli-plugins/docker-compose"
export DOCKER_CONFIG="$SCRATCH/docker-config"
docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d
```

Expected: all services healthy within a few minutes (`docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml ps`). Do not use a bare empty `DOCKER_CONFIG`: it hides the CLI plugins.

- [ ] **Step 2: Seed the journeys with the current recorder**

```bash
pnpm install --frozen-lockfile
OUT_DIR="$SCRATCH/v1" pnpm demo:video
```

Expected: ends by printing the MP4, GIF and stills paths. This proves the stack and seeds the completed and failed journeys for `0018Z00002ABC`.

- [ ] **Step 3: Write the spike script**

Create `scripts/demo-capture-spike.mjs`:

```js
// Capture-quality spike for docs/superpowers/plans/2026-10-04-demo-video-v2.md.
// Not committed. Run from the repository root with the demo stack up and the
// demo journeys seeded: OUT_DIR=<dir> node scripts/demo-capture-spike.mjs
/* global window -- the functions passed to page.evaluate run in the browser */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3000";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "replace-for-local-development-0000";
const ENTITY_ID = "0018Z00002ABC";
const OUT = process.env["OUT_DIR"];
if (OUT === undefined) throw new Error("Set OUT_DIR.");
const VIEWPORT = { width: 1920, height: 1080 };
const PHONE = "td:text-is('Phone'), td:text-is('phone')";

const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const ssim = (a, b) => {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"], {
    encoding: "utf8"
  });
  const match = /All:([0-9.]+)/.exec(run.stderr);
  return match === null ? `failed: ${run.stderr.slice(-300)}` : Number(match[1]);
};
const crop = (input, box, scale, output, upscale = 1) =>
  ff([
    "-i",
    input,
    "-vf",
    `crop=${box.width * scale}:${box.height * scale}:${box.x * scale}:${box.y * scale}` +
      (upscale === 1 ? "" : `,scale=iw*${upscale}:ih*${upscale}:flags=lanczos`),
    "-frames:v",
    "1",
    output
  ]);

let projectId = "";
async function api(path) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(projectId === "" ? {} : { "x-wayscribe-project-id": projectId })
    }
  });
  return (await response.json()).data ?? {};
}

projectId = ((await api("/v1/projects")).items ?? []).find((p) => p.slug === "demo").id;
const items = (await api(`/v1/search?q=${ENTITY_ID}`)).items ?? [];
const failed = items.find((journey) => journey.status === "failed");
if (failed === undefined) throw new Error("No failed demo journey. Run pnpm demo:video once first.");
const journey = await api(`/v1/journeys/${failed.journeyId}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const login = await browser.newContext({ viewport: VIEWPORT });
const loginPage = await login.newPage();
await loginPage.goto(`${WEB_URL}/login`);
await loginPage.fill("#token", ADMIN_TOKEN);
await loginPage.click("button[type=submit]");
await loginPage.waitForLoadState("networkidle");
const storageState = await login.storageState();
await login.close();

/** Opens the failed journey's transform diff, scrolled as the capture will be; returns geometry. */
async function openDiff(page) {
  await page.goto(`${WEB_URL}/journeys/${failed.journeyId}`);
  await page.waitForSelector("text=All times UTC");
  await page.locator("a[href*='?event=']", { hasText: "transform-salesforce" }).first().click();
  await page.waitForSelector("text=What changed");
  const top = await page
    .getByText("What changed")
    .first()
    .evaluate((e) => e.getBoundingClientRect().top + window.scrollY - 24);
  await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), top);
  await page.waitForTimeout(800);
  const rows = page.locator("tr", { has: page.locator(PHONE) });
  const rects = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const table = await rows
    .first()
    .locator("xpath=ancestor::table[1]")
    .evaluate((e) => e.getBoundingClientRect().toJSON());
  const x = Math.floor(Math.min(...rects.map((r) => r.x)));
  const y = Math.floor(Math.min(...rects.map((r) => r.y)));
  const right = Math.ceil(Math.max(...rects.map((r) => r.x + r.width)));
  const bottom = Math.ceil(Math.max(...rects.map((r) => r.y + r.height)));
  return { top, phone: { x, y, width: right - x, height: bottom - y }, table };
}

/** A smooth scroll away and an instant return: motion to measure, then the reference state again. */
async function motion(page, top) {
  const start = Date.now();
  await page.evaluate((top) => window.scrollTo({ top: top + 600, behavior: "smooth" }), top);
  await page.waitForTimeout(1200);
  const end = Date.now();
  await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), top);
  await page.waitForTimeout(1000);
  return { start, end };
}

const results = { failedStep: journey.failedStep };

// Reference: a lossless screenshot at deviceScaleFactor 2, plus pages to look at.
{
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, storageState });
  const page = await context.newPage();
  const { phone, table } = await openDiff(page);
  Object.assign(results, { phone, table });
  await page.screenshot({ path: join(OUT, "reference.png") });
  const times = [];
  for (let i = 0; i < 9; i++) {
    const t = Date.now();
    await page.screenshot();
    times.push(Date.now() - t);
  }
  results.screenshotMedianMs = times.sort((a, b) => a - b)[4];
  await page.goto(`${WEB_URL}/journeys/${failed.journeyId}`);
  await page.waitForSelector("text=All times UTC");
  await page.screenshot({ path: join(OUT, "timeline-page.png") });
  await page.goto(`${WEB_URL}/`);
  await page.locator("input[name=q]").fill(ENTITY_ID);
  await page.locator("button[type=submit]", { hasText: "Search" }).click();
  await page.waitForLoadState("networkidle");
  if (page.url().includes("/projects")) {
    await page.locator("button", { hasText: "Demo" }).first().click();
    await page.waitForLoadState("networkidle");
  }
  await page.waitForSelector("a[href^='/journeys/']");
  await page.screenshot({ path: join(OUT, "results-page.png") });
  results.resultLinkAncestry = await page
    .locator(`a[href^='/journeys/${failed.journeyId}']`)
    .first()
    .evaluate((a) => {
      const chain = [];
      for (let e = a, i = 0; e !== null && i < 5; e = e.parentElement, i++) chain.push(e.tagName.toLowerCase());
      return chain.join(" < ");
    });
  await context.close();
}
crop(join(OUT, "reference.png"), results.phone, 2, join(OUT, "crop-reference.png"));

// (a) Playwright recordVideo at 1920x1080.
{
  const dir = join(OUT, "a-raw");
  const context = await browser.newContext({ viewport: VIEWPORT, storageState, recordVideo: { dir, size: VIEWPORT } });
  const page = await context.newPage();
  const { top } = await openDiff(page);
  await motion(page, top);
  await context.close();
  const [webm] = (await readdir(dir)).filter((name) => name.endsWith(".webm"));
  ff(["-sseof", "-0.4", "-i", join(dir, webm), "-frames:v", "1", join(OUT, "a-frame.png")]);
  crop(join(OUT, "a-frame.png"), results.phone, 1, join(OUT, "crop-a.png"), 2);
  results.a = {
    ssim: ssim(join(OUT, "crop-a.png"), join(OUT, "crop-reference.png")),
    bytes: (await stat(join(dir, webm))).size
  };
}

// (b) CDP screencast at deviceScaleFactor 2, as JPEG 92 and as PNG.
for (const [name, params] of [
  ["b-jpeg", { format: "jpeg", quality: 92 }],
  ["b-png", { format: "png" }]
]) {
  const dir = join(OUT, name);
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, storageState });
  const page = await context.newPage();
  const { top } = await openDiff(page);
  const session = await context.newCDPSession(page);
  const frames = [];
  const writes = [];
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.${params.format === "png" ? "png" : "jpg"}`);
    frames.push({ at: metadata.timestamp * 1000, file, bytes: Math.round(data.length * 0.75) });
    writes.push(writeFile(file, Buffer.from(data, "base64")));
    void session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", { ...params, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
  await page.waitForTimeout(500);
  const { start, end } = await motion(page, top);
  await session.send("Page.stopScreencast");
  await Promise.all(writes);
  const last = frames.at(-1);
  crop(last.file, results.phone, 2, join(OUT, `crop-${name}.png`));
  results[name] = {
    frameSize: execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", last.file], {
      encoding: "utf8"
    }).trim(),
    frames: frames.length,
    framesPerSecondWhileScrolling: Number(
      (frames.filter((f) => f.at >= start && f.at <= end).length / ((end - start) / 1000)).toFixed(1)
    ),
    meanBytesPerFrame: Math.round(frames.reduce((sum, f) => sum + f.bytes, 0) / frames.length),
    ssim: ssim(join(OUT, `crop-${name}.png`), join(OUT, "crop-reference.png"))
  };
  await context.close();
}
await browser.close();

ff([
  "-i", join(OUT, "crop-reference.png"),
  "-i", join(OUT, "crop-a.png"),
  "-i", join(OUT, "crop-b-jpeg.png"),
  "-i", join(OUT, "crop-b-png.png"),
  "-filter_complex", "vstack=inputs=4",
  join(OUT, "compare.png")
]);
await writeFile(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
console.log(`\nCompare (top to bottom: reference, a, b-jpeg, b-png): ${join(OUT, "compare.png")}`);
```

- [ ] **Step 4: Run the spike**

```bash
OUT_DIR="$SCRATCH/spike" node scripts/demo-capture-spike.mjs
```

Expected: a JSON report and `compare.png`. If the `vstack` fails because crop widths differ, the screencast frame size is not 3840x2160: record `frameSize` and stop (the plan's scale assumption is wrong; report back).

- [ ] **Step 5: Look at the evidence and decide**

Open `compare.png`, `reference.png`, `timeline-page.png` and `results-page.png` (Read tool shows images). Decision rule:

- Choose the method whose 2x phone crop has the highest SSIM against the reference, as long as a screencast variant delivers at least 10 frames per second while scrolling. recordVideo always delivers 25.
- Between JPEG 92 and PNG: choose JPEG unless PNG's SSIM is higher by more than 0.01 (JPEG is several times smaller, and the render copies every frame once).
- **Gate A:** if recordVideo wins, stop and report: Tasks 3 and 10 assume screencast frames at scale 2 and must be revised (recordVideo frames would be extracted with ffmpeg at 30 fps, scale 1, and the 2.2x zoom cap drops to what stays legible).
- **Gate B:** if the phone rows box is wider than 1016 CSS px, stop and report: the square cut cannot frame the phone row at zoom 1 or more from a 1920-wide capture, and needs a second capture at a square viewport (Tasks 3, 8, 11 change).
- Read the transform step's status as the UI shows it (on `reference.png` and `timeline-page.png`). If it is shown as succeeded, scene 6's caption becomes "The phone goes in with a value and comes out null, and the step reported success." Otherwise keep "The phone goes in with a value and comes out null. This step lost it." Record which.
- Check the failed journey's `failedStep` is a delivery step (scene 4 says "It failed at delivery"). If it is not, record the step name; Task 7 changes scene 4's caption to match what the timeline shows, and Jorge sees the change in Task 14.

- [ ] **Step 6: Check Remotion's licence**

Fetch https://www.remotion.dev/docs/license and `LICENSE.md` in github.com/remotion-dev/remotion (tag `v4.0.532`). Record in one or two sentences: whether an individual using Remotion to render a video for their own open-source project is covered by the free licence, who needs a company licence, and any obligation (attribution, notice) that applies. If an individual's open-source use is NOT free, stop and report: this is Jorge's call before any Remotion code is committed.

- [ ] **Step 7: Record results, delete the spike, commit the plan**

Fill every row of the "Spike results" table above, then:

```bash
rm scripts/demo-capture-spike.mjs
git add docs/superpowers/plans/2026-10-04-demo-video-v2.md
git commit -m "docs(plan): demo video v2 capture spike and Remotion licence results"
```

Leave the stack up for Task 3.

---

### Task 2: Capture helpers

**Files:**
- Create: `scripts/demo-capture-lib.mjs`, `scripts/demo-capture-lib.d.mts`
- Test: `tests/demo-capture.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/demo-capture.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  clickPoint,
  frameAt,
  manifestProblems,
  reviewFilter,
  toBox,
  unionBox,
  type Manifest
} from "../scripts/demo-capture-lib.mjs";

const VIEWPORT = { width: 1920, height: 1080 };

describe("demo capture geometry", () => {
  it("measures a box in whole pixels without shrinking it", () => {
    expect(toBox({ x: 10.4, y: 20.6, width: 100.2, height: 30.1 }, "row", VIEWPORT)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 31
    });
  });

  it("clips a box to the viewport, so a table running below the fold is framed by what shows", () => {
    expect(toBox({ x: 100, y: 900, width: 400, height: 500 }, "table", VIEWPORT)).toEqual({
      x: 100,
      y: 900,
      width: 400,
      height: 180
    });
  });

  it("refuses a box that is missing, empty or wholly off screen, naming it", () => {
    expect(() => toBox(null, "query", VIEWPORT)).toThrow(/"query"/);
    expect(() => toBox({ x: 0, y: 0, width: 0, height: 10 }, "query", VIEWPORT)).toThrow(/"query"/);
    expect(() => toBox({ x: 0, y: 1200, width: 10, height: 10 }, "query", VIEWPORT)).toThrow(/"query"/);
  });

  it("joins boxes into the smallest box holding them all", () => {
    expect(
      unionBox([
        { x: 10, y: 10, width: 10, height: 10 },
        { x: 30, y: 5, width: 5, height: 40 }
      ])
    ).toEqual({ x: 10, y: 5, width: 25, height: 40 });
    expect(() => unionBox([])).toThrow();
  });

  it("clicks the middle of a small target and near the left of a wide row", () => {
    expect(clickPoint({ x: 100, y: 100, width: 80, height: 40 })).toEqual({ x: 140, y: 120 });
    expect(clickPoint({ x: 100, y: 100, width: 1200, height: 40 })).toEqual({ x: 220, y: 120 });
  });

  it("finds the frame on screen at a moment: the last one captured at or before it", () => {
    const frames = [
      { at: 0, file: "a" },
      { at: 100, file: "b" },
      { at: 250, file: "c" }
    ];
    expect(frameAt(frames, -5).file).toBe("a");
    expect(frameAt(frames, 100).file).toBe("b");
    expect(frameAt(frames, 249).file).toBe("b");
    expect(frameAt(frames, 9_999).file).toBe("c");
  });

  it("outlines every box of a mark in device pixels for the review stills", () => {
    expect(reviewFilter({ a: { x: 1, y: 2, width: 3, height: 4 } }, 2)).toBe(
      "drawbox=x=2:y=4:w=6:h=8:color=red@0.9:t=8"
    );
    expect(reviewFilter({}, 2)).toBe("null");
  });
});

describe("demo capture manifest", () => {
  const good = (): Manifest => ({
    version: 1,
    viewport: VIEWPORT,
    scale: 2,
    frames: [
      { at: 0, file: "frames/000000.png" },
      { at: 40, file: "frames/000001.png" }
    ],
    marks: [
      { name: "home", at: 10, boxes: { query: { x: 0, y: 0, width: 10, height: 10 } } },
      { name: "results", at: 30, boxes: {} }
    ],
    clicks: [{ at: 20, x: 5, y: 5 }]
  });

  it("accepts a well-formed capture", () => {
    expect(manifestProblems(good())).toEqual([]);
  });

  it("names every problem a render would trip on", () => {
    const bad = good();
    bad.frames = [];
    bad.marks.push({ name: "home", at: 5, boxes: { query: { x: 1900, y: 0, width: 40, height: 10 } } });
    bad.clicks.push({ at: 50, x: 2000, y: 5 });
    expect(manifestProblems(bad)).toEqual([
      "The capture has no frames.",
      'Mark "home" appears twice.',
      'Box "query" of mark "home" leaves the 1920x1080 viewport.',
      'Mark "home" is earlier than "results".',
      "Click at 50 ms is off screen."
    ]);
  });

  it("catches frames out of order", () => {
    const bad = good();
    bad.frames.reverse();
    expect(manifestProblems(bad)).toEqual(["Frame 1 is earlier than frame 0."]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/demo-capture.test.ts`
Expected: FAIL, cannot resolve `../scripts/demo-capture-lib.mjs`.

- [ ] **Step 3: Write the helpers**

Create `scripts/demo-capture-lib.mjs`:

```js
/**
 * Pure helpers for the demo capture in scripts/demo-video.mjs: geometry, the
 * capture manifest (marks.json) and the review stills' filter. Kept apart so
 * they can be tested without a browser or a stack.
 *
 * Boxes are CSS pixels relative to the viewport, as Playwright measures them.
 * The frames are captured at `scale` device pixels per CSS pixel.
 */

/** A measured box in whole CSS pixels, grown rather than shrunk, and clipped to the viewport. */
export function toBox(box, name, viewport) {
  if (box === null || box === undefined) {
    throw new Error(`Nothing measurable for "${name}": is it on the page?`);
  }
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const right = Math.min(viewport.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height));
  if (right <= x || bottom <= y) throw new Error(`Nothing of "${name}" is on screen.`);
  return { x, y, width: right - x, height: bottom - y };
}

/** The smallest box holding every box given. */
export function unionBox(boxes) {
  if (boxes.length === 0) throw new Error("No boxes to join.");
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Where a click on `box` lands: its middle, but no more than 120 px in from the left of a wide row. */
export function clickPoint(box) {
  return {
    x: Math.round(box.x + Math.min(box.width / 2, 120)),
    y: Math.round(box.y + box.height / 2)
  };
}

/** The frame on screen at `at` ms: the last one captured at or before it (the first, before any). */
export function frameAt(frames, at) {
  if (frames.length === 0) throw new Error("The capture has no frames.");
  let low = 0;
  let high = frames.length - 1;
  if (at <= frames[0].at) return frames[0];
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (frames[middle].at <= at) low = middle;
    else high = middle - 1;
  }
  return frames[low];
}

/** Problems with a capture manifest, as sentences; empty when a render can use it. */
export function manifestProblems(manifest) {
  const { viewport, frames, marks, clicks } = manifest;
  const problems = [];
  if (frames.length === 0) problems.push("The capture has no frames.");
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].at < frames[i - 1].at) {
      problems.push(`Frame ${String(i)} is earlier than frame ${String(i - 1)}.`);
      break;
    }
  }
  const seen = new Set();
  for (const mark of marks) {
    if (seen.has(mark.name)) problems.push(`Mark "${mark.name}" appears twice.`);
    seen.add(mark.name);
    for (const [key, box] of Object.entries(mark.boxes)) {
      const inside =
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height;
      if (!inside) {
        problems.push(
          `Box "${key}" of mark "${mark.name}" leaves the ${String(viewport.width)}x${String(viewport.height)} viewport.`
        );
      }
    }
  }
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].at < marks[i - 1].at) {
      problems.push(`Mark "${marks[i].name}" is earlier than "${marks[i - 1].name}".`);
    }
  }
  for (const click of clicks) {
    if (click.x < 0 || click.y < 0 || click.x > viewport.width || click.y > viewport.height) {
      problems.push(`Click at ${String(click.at)} ms is off screen.`);
    }
  }
  return problems;
}

/** An ffmpeg filter outlining every box of a mark on a frame captured at `scale`. */
export function reviewFilter(boxes, scale) {
  const filters = Object.values(boxes).map(
    (box) =>
      `drawbox=x=${String(box.x * scale)}:y=${String(box.y * scale)}:w=${String(box.width * scale)}` +
      `:h=${String(box.height * scale)}:color=red@0.9:t=${String(4 * scale)}`
  );
  return filters.length === 0 ? "null" : filters.join(",");
}
```

Create `scripts/demo-capture-lib.d.mts`:

```ts
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Frame {
  at: number;
  file: string;
}

export interface Mark {
  name: string;
  at: number;
  boxes: Record<string, Box>;
}

export interface Click {
  at: number;
  x: number;
  y: number;
}

export interface Manifest {
  version: 1;
  viewport: { width: number; height: number };
  scale: number;
  frames: Frame[];
  marks: Mark[];
  clicks: Click[];
}

export function toBox(
  box: Box | null | undefined,
  name: string,
  viewport: { width: number; height: number }
): Box;
export function unionBox(boxes: Box[]): Box;
export function clickPoint(box: Box): { x: number; y: number };
export function frameAt(frames: Frame[], at: number): Frame;
export function manifestProblems(manifest: Manifest): string[];
export function reviewFilter(boxes: Record<string, Box>, scale: number): string;
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run tests/demo-capture.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Lint, format, commit**

```bash
pnpm exec eslint scripts/demo-capture-lib.mjs scripts/demo-capture-lib.d.mts tests/demo-capture.test.ts
pnpm exec prettier --write scripts/demo-capture-lib.mjs scripts/demo-capture-lib.d.mts tests/demo-capture.test.ts
git add scripts/demo-capture-lib.mjs scripts/demo-capture-lib.d.mts tests/demo-capture.test.ts
git commit -m "feat(demo): capture helpers for geometry and the capture manifest"
```

---

### Task 3: Rewrite the capture and retire narration

**Files:**
- Modify (rewrite): `scripts/demo-video.mjs`
- Modify: `package.json` (drop the `demo:narrate` script)
- Delete: `scripts/demo-narrate.mjs`, `scripts/demo-narration.json`, `scripts/demo-tts.py`

This task has no unit test of its own (the helpers are tested in Task 2); it is verified by a real capture and its review stills.

- [ ] **Step 1: Rewrite `scripts/demo-video.mjs`**

Replace the whole file with the following. The block from `const WANTED` through `waitOutLiveWindow` is the current file's lines 57 to 167 unchanged (seeding, replay destination, live window); it is reproduced here so the file is complete.

Task 1 recorded the result link ancestry as `a < li < ul < main < div` (so `rowOf` stays as written) and chose PNG frames with real DSF: the code below already uses PNG, launches Chromium with `--force-device-scale-factor=2`, and sets no context `deviceScaleFactor` (that option does not enlarge screencast frames).

```js
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
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const OUT = process.env["OUT_DIR"] ?? join(tmpdir(), "wayscribe-demo-video");
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

/** Starts the screencast; returns a function that stops it once every frame is on disk. */
async function startScreencast(page) {
  const session = await page.context().newCDPSession(page);
  const writes = [];
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const at =
      metadata.timestamp === undefined ? now() : Math.round(metadata.timestamp * 1000 - startedAt);
    const file = `frames/${String(frames.length).padStart(6, "0")}.${EXTENSION}`;
    frames.push({ at, file });
    writes.push(writeFile(join(CAPTURE, file), Buffer.from(data, "base64")));
    session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  await session.send("Page.startScreencast", {
    ...FRAME,
    maxWidth: VIEWPORT.width * SCALE,
    maxHeight: VIEWPORT.height * SCALE,
    everyNthFrame: 1
  });
  return async () => {
    await session.send("Page.stopScreencast");
    await Promise.all(writes);
    await session.detach();
  };
}

/** The table row or list item a result link sits in, or the link itself. */
const rowOf = (link) => link.locator("xpath=ancestor-or-self::*[self::tr or self::li][1]");

/** Table rows whose first matching cell holds exactly one of `names`. */
const rowsNamed = (page, names) =>
  page.locator("tr", { has: page.locator(names.map((name) => `td:text-is('${name}')`).join(", ")) });

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
  return {
    box,
    boxAll,
    /** Records a moment of the story once it has settled, with the boxes of what it is about. */
    async mark(name, boxes = {}) {
      await sleep(SETTLE_MS);
      const measured = {};
      for (const [key, target] of Object.entries(boxes)) {
        measured[key] = typeof target === "function" ? await target() : await box(target, `${name}.${key}`);
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
  const stepLink = (name) => page.locator("a[href*='?event=']", { hasText: name }).first();

  // Search for the account.
  await page.goto(`${WEB_URL}/`);
  await page.waitForLoadState("networkidle");
  const query = page.locator("input[name=q]");
  await act.mark("home", { query });
  await act.click(query, { wait: null });
  await query.pressSequentially(ENTITY_ID, { delay: 90 });
  await act.click(page.locator("button[type=submit]", { hasText: "Search" }), { wait: "networkidle" });
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
      unionBox([await act.box(failedRow, "failed row"), await act.box(completedRow, "completed row")])
  });

  // The failed journey's timeline.
  await act.click(failedLink, { wait: "networkidle" });
  await page.waitForSelector("text=All times UTC");
  await act.scrollTo(page.locator("a[href*='?event=']").first(), 24);
  await act.mark("timeline", {
    steps: () => act.boxAll(page.locator("a[href*='?event=']"), "steps"),
    failure: stepLink(failedStep),
    transform: stepLink("transform-salesforce")
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
    form: async () => unionBox([await act.box(destination, "destination"), await act.box(send, "send")])
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
    } finally {
      await stop();
    }
    await context.close();
  } finally {
    await browser.close();
  }

  const manifest = { version: 1, viewport: VIEWPORT, scale: SCALE, frames, marks, clicks };
  const problems = manifestProblems(manifest);
  if (problems.length > 0) throw new Error(`The capture is not usable:\n  ${problems.join("\n  ")}`);
  await writeFile(join(CAPTURE, "marks.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeReviewStills(manifest);
  console.log(`\n  ${String(frames.length)} frames, ${(now() / 1000).toFixed(1)}s: ${CAPTURE}`);
}

function render() {
  if (!existsSync(join(VIDEO, "node_modules"))) {
    throw new Error("The video project is not installed. Run: pnpm --dir video install");
  }
  execFileSync("pnpm", ["--dir", VIDEO, "exec", "tsx", "scripts/render.ts", "--capture", CAPTURE, "--out", OUT], {
    stdio: "inherit"
  });
}

if (!RENDER_ONLY) await capture();
if (!CAPTURE_ONLY) render();
```

- [ ] **Step 2: Retire narration**

```bash
git rm scripts/demo-narrate.mjs scripts/demo-narration.json scripts/demo-tts.py
```

In `package.json`, delete the line `"demo:narrate": "node scripts/demo-narrate.mjs",`. Then find every remaining reference:

```bash
grep -rn "demo-narrat\|demo-tts\|demo:narrate\|KOKORO" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude . | grep -v "docs/superpowers/"
```

Expected remaining hits: `docs/DEMO_RECORDING.md` (rewritten in Task 12) and `site/README.md` (Task 15). Anything else: fix it in this step so nothing points at a deleted file.

- [ ] **Step 3: Capture for real**

```bash
export DOCKER_CONFIG="$SCRATCH/docker-config"
OUT_DIR="$SCRATCH/out" node scripts/demo-video.mjs --capture-only
```

Expected: one line per mark (`home`, `results`, `timeline`, `diff`, `good-diff`, `replay-link`, `replay-form`, `replay-response`, `comparison`, `end`), then the frame count. If a box throws (`Nothing of "x" is on screen`), the selector or scroll offset is wrong for this UI: fix the locator, rerun.

- [ ] **Step 4: Review the geometry**

Open every PNG in `$SCRATCH/out/capture/review/` (Read tool). Each outlined box must sit on what its name says: `query` on the search box; `failed` and `completed` on whole result rows; `steps` around the step list; `failure` on the failed step; `diff` on the diff table; `phone` on the Phone and phone rows; `replay` on the "Replay this input" link; `form` around the destination select and the Send button; `response` on the response status; `comparison` and its `phone` on the replay comparison. Fix and recapture until all are right. Also check frame dimensions: `ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$SCRATCH/out/capture/frames/000010.png"` gives `3840,2160`.

- [ ] **Step 5: Lint, full tests, commit**

```bash
pnpm exec eslint scripts/demo-video.mjs
pnpm exec prettier --write scripts/demo-video.mjs package.json
pnpm test
git add scripts/demo-video.mjs package.json
git commit -m "feat(demo): capture frames and story marks for the v2 video; retire narration"
```

Expected: `pnpm test` all green.

---

### Task 4: The `video/` package, kept out of the workspace, lint and images

**Files:**
- Create: `video/package.json`, `video/pnpm-workspace.yaml`, `video/tsconfig.json`, `video/vitest.config.ts`, `video/.gitignore`, `video/README.md`, `video/tests/smoke.test.ts`
- Create: `tests/video-package.test.ts`
- Modify: `eslint.config.js`, `.dockerignore`, `scripts/verify-image-contents.sh`

- [ ] **Step 1: Write the failing root test**

Create `tests/video-package.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { read, root } from "./docs-helpers.js";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("the demo video project", () => {
  it("stays out of the root workspace, the root lint and the images", () => {
    const workspace = parse(read("pnpm-workspace.yaml")) as { packages: string[] };
    expect(workspace.packages.some((pattern) => pattern.startsWith("video"))).toBe(false);
    expect(existsSync(join(root, "video/pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(root, "video/pnpm-workspace.yaml"))).toBe(true);
    expect(read("eslint.config.js")).toContain('"video/**"');
    expect(read(".dockerignore").split("\n")).toContain("video");
    expect(read("scripts/verify-image-contents.sh")).toMatch(/for DIR in [^\n]* \/app\/video /);
  });

  it("pins every dependency to an exact version, and Remotion to Shorts Studio's", () => {
    const manifest = JSON.parse(read("video/package.json")) as PackageJson;
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      if (name === "remotion" || name.startsWith("@remotion/")) expect(version, name).toBe("4.0.532");
    }
  });
});
```

Run: `pnpm vitest run tests/video-package.test.ts`
Expected: FAIL (no `video/pnpm-lock.yaml`, no ignore entries).

- [ ] **Step 2: Create the package files**

`video/pnpm-workspace.yaml`:

```yaml
# The demo video is its own pnpm project, with its own lockfile, and not a
# member of the root workspace: Remotion and the browser it renders with stay
# out of every install except this one and the CI job that tests it. This file
# makes pnpm treat video/ as a root of its own (the same arrangement as site/).

# Build scripts are denied by default in pnpm 11; each must be decided explicitly.
#
#   esbuild  Vitest's and Remotion's bundler. Its postinstall fetches the
#            platform binary, so it must run.
allowBuilds:
  esbuild: true
```

`video/package.json` (versions are filled by Step 3's commands; start with this):

```json
{
  "name": "wayscribe-demo-video",
  "private": true,
  "type": "module",
  "description": "Renders the Wayscribe demo video from a capture of the real web app. See docs/DEMO_RECORDING.md.",
  "engines": {
    "node": ">=24.0.0 <25.0.0"
  },
  "packageManager": "pnpm@11.20.0+sha512.9a6f330a95b66446ea088faf1521405a8a01f07fde7124cc9958dfed52d4bb436737e65b08f85f37b46fcba375092558ac51262b816844b22f63406ed166bfee",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`video/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "tests", "vitest.config.ts"]
}
```

`video/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] }
});
```

`video/.gitignore`:

```
node_modules/
```

`video/tests/smoke.test.ts` (replaced by real tests in later tasks; it proves the toolchain):

```ts
import { expect, it } from "vitest";

it("runs", () => {
  expect(1 + 1).toBe(2);
});
```

`video/README.md`:

```markdown
# Demo video

Renders the Wayscribe demo video (16:9 and 1:1) from a capture of the real web
app. `pnpm demo:video` at the repository root runs the capture and then this
project; docs/DEMO_RECORDING.md is the whole procedure.

This is its own pnpm project, not a member of the root workspace, so Remotion
stays out of every other install:

    pnpm --dir video install
    pnpm --dir video test
    pnpm --dir video typecheck

The music synth in src/audio/ was copied from Shorts Studio; each copied file
names its source. Nothing is imported from there.

Remotion is not open source. Its licence terms are summarized in the demo video
plan (docs/superpowers/plans/2026-10-04-demo-video-v2.md, "Spike results");
read them before rendering on behalf of a company.
```

- [ ] **Step 3: Install pinned dependencies**

```bash
pnpm --dir video add -E remotion@4.0.532 @remotion/bundler@4.0.532 @remotion/renderer@4.0.532 @remotion/fonts@4.0.532 react@19.3.0 react-dom@19.3.0 @fontsource/inter
pnpm --dir video add -D -E typescript@5.9.3 vitest tsx @types/node @types/react @types/react-dom
```

If pnpm refuses with `ERR_PNPM_ADDING_TO_ROOT` (it sees `video/` as a workspace root because of its `pnpm-workspace.yaml`), repeat the commands with `-w`. If `@remotion/fonts@4.0.532` does not exist (`pnpm view @remotion/fonts@4.0.532 version` prints nothing), stop and report; Task 11's font loading depends on it. If pnpm reports an ignored build script other than esbuild, decide it in `video/pnpm-workspace.yaml` with a comment saying why, like the root file does. Check `video/package.json` now has exact versions only (no `^`).

- [ ] **Step 4: Keep it out of root lint and the images**

In `eslint.config.js`, inside the first `ignores` array, after the `"site/.astro/**",` entry, add:

```js
      // The demo video is its own pnpm project (video/README.md). Its
      // dependencies are not installed at the root, so type-aware rules cannot
      // resolve them here; its CI job type-checks it.
      "video/**",
```

In `.dockerignore`, add a line `video` directly after the line `site`.

In `scripts/verify-image-contents.sh` line 85, insert ` /app/video` before ` /app/site` so the line reads:

```sh
for DIR in /app/apps/demo /app/apps/web /app/packages/protocol/conformance /app/packages/sdk-node /app/packages/sdk-python /app/packages/sdk-go /app/tests /app/video /app/site; do
```

- [ ] **Step 5: Run everything**

```bash
pnpm --dir video test
pnpm --dir video typecheck
pnpm vitest run tests/video-package.test.ts
pnpm exec prettier --write video
pnpm format:check
pnpm lint
pnpm test
```

Expected: all pass. `pnpm test` matters here: several root tests walk the whole tree, including `video/` and its lockfile.

- [ ] **Step 6: Commit**

```bash
git add video eslint.config.js .dockerignore scripts/verify-image-contents.sh tests/video-package.test.ts
git commit -m "feat(video): standalone Remotion project outside the workspace, lint and images"
```

---

### Task 5: Copy the synth core from Shorts Studio and add the sine and tick voices

**Files:**
- Create: `video/src/audio/{constants,types,rng,notes,synth,mixer,wav}.ts`
- Create: `video/tests/audio/{synth,mixer,wav}.test.ts`

- [ ] **Step 1: Copy the files at the named commit**

```bash
SS=~/workspace/shorts-studio
mkdir -p video/src/audio video/tests/audio
for f in types rng notes synth mixer wav; do git -C "$SS" show "5675fc1:src/audio/$f.ts" > "video/src/audio/$f.ts"; done
for f in synth mixer wav; do git -C "$SS" show "5675fc1:tests/audio/$f.test.ts" > "video/tests/audio/$f.test.ts"; done
```

Create `video/src/audio/constants.ts`:

```ts
// The one constant the synth copied from Shorts Studio needs from its
// src/constants.ts (commit 5675fc1).
export const SAMPLE_RATE = 48000;
```

- [ ] **Step 2: Cut the copies loose from Shorts Studio**

In `synth.ts`, `mixer.ts` and `wav.ts`, change `from "../constants"` to `from "./constants"`.

The copied tests import `../../src/audio/...`, which resolves the same way under `video/tests/audio/`, so those paths stay. Delete every `it(...)` block that uses any of `buildTimeline`, `parseScript`, `baseScript`, `punchyScript`, `toYaml`, `renderAudio`, `mapSfx` or `compose`, and remove those imports. Every other case stays as copied.

Put this header at the top of each copied file (source and test), naming its own path:

```ts
// Copied from Shorts Studio, src/audio/synth.ts at commit 5675fc1, and not
// imported from there: later changes in Shorts Studio do not flow in.
// Local changes: <list them, or "import paths only">.
```

Local changes to list: `synth.ts` "added the sine and tick voices"; `types.ts` "added the sine and tick voices to Voice"; test files "dropped the cases that need Shorts Studio's script and timeline". The others: "import paths only" (or "none" for `rng.ts` and `notes.ts`).

Run: `pnpm --dir video test`
Expected: PASS (the copied cases as they were).

- [ ] **Step 3: Write the failing tests for the new voices**

Append to `video/tests/audio/synth.test.ts`, inside its `describe("synth", ...)` block (it already defines `SR` and `risingEdges`):

```ts
  it("renders a sine note at the right pitch", () => {
    const { left } = renderNotes([{ voice: "sine", start: 0, dur: 1, midi: 69, vel: 1 }], 1.6);
    const edges = risingEdges(left, Math.round(0.1 * SR), Math.round(0.9 * SR));
    expect(Math.abs(edges - 440 * 0.8)).toBeLessThanOrEqual(2);
  });

  it("ends a tick within a tenth of a second of its start", () => {
    const { left } = renderNotes([{ voice: "tick", start: 0.1, dur: 0.05, midi: 88, vel: 1 }], 1);
    const peak = left
      .slice(Math.round(0.1 * SR), Math.round(0.15 * SR))
      .reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(0.01);
    expect(left.slice(Math.round(0.25 * SR)).every((v) => v === 0)).toBe(true);
  });
```

Run: `pnpm --dir video test`
Expected: FAIL to type-check or run: `"sine"` and `"tick"` are not voices.

- [ ] **Step 4: Add the voices**

In `types.ts`:

```ts
export type Voice = "pulse1" | "pulse2" | "triangle" | "noise" | "pad" | "sine" | "tick";
```

In `synth.ts`, extend the three tables and the switch:

```ts
const PAN: Record<Voice, number> = { pulse1: -0.25, pulse2: 0.25, triangle: 0, noise: 0.1, pad: 0, sine: 0.15, tick: 0 };
const GAIN: Record<Voice, number> = { pulse1: 0.18, pulse2: 0.14, triangle: 0.32, noise: 0.16, pad: 0.12, sine: 0.16, tick: 0.2 };
const ENV: Record<Exclude<Voice, "noise">, Env> = {
  pulse1: { a: 0.005, d: 0.08, s: 0.6, r: 0.06 },
  pulse2: { a: 0.005, d: 0.06, s: 0.5, r: 0.05 },
  triangle: { a: 0.002, d: 0.05, s: 0.9, r: 0.03 },
  pad: { a: 0.25, d: 0.3, s: 0.7, r: 0.6 },
  // A soft lead: a gentle attack and a long release.
  sine: { a: 0.03, d: 0.25, s: 0.6, r: 0.5 },
  // A short struck sound: gone by the end of its decay.
  tick: { a: 0.001, d: 0.06, s: 0, r: 0.02 },
};
```

In `TAIL_SEC` add `sine: ENV.sine.r,` and `tick: ENV.tick.r,`. In `renderNote`'s switch, before `case "pad":`, add:

```ts
      case "sine":
      case "tick":
        phase = (phase + hz / sr) % 1;
        s = Math.sin(2 * Math.PI * phase);
        break;
```

- [ ] **Step 5: Run, format, commit**

```bash
pnpm --dir video test
pnpm --dir video typecheck
pnpm exec prettier --write video
git add video
git commit -m "feat(video): synth core copied from Shorts Studio at 5675fc1, with sine and tick voices"
```

Expected: tests and typecheck pass.

---

### Task 6: The calm arrangement and the music track

**Files:**
- Create: `video/src/audio/calm.ts`, `video/src/audio/music.ts`
- Test: `video/tests/audio/calm.test.ts`, `video/tests/audio/music.test.ts`

- [ ] **Step 1: Write the failing tests**

`video/tests/audio/calm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CALM, composeCalm, makeMotif, scaleMidi } from "../../src/audio/calm";
import { makeRng } from "../../src/audio/rng";
import { TAIL_SEC } from "../../src/audio/synth";

describe("the calm arrangement", () => {
  const track = composeCalm({ totalSec: 61.5, seed: 7 });
  const pitchClass = (midi: number) => (((midi - track.root) % 12) + 12) % 12;

  it("is the same track for the same seed and another for another seed", () => {
    expect(composeCalm({ totalSec: 61.5, seed: 7 })).toEqual(track);
    expect(composeCalm({ totalSec: 61.5, seed: 8 }).notes).not.toEqual(track.notes);
  });

  it("keeps a slow tempo", () => {
    expect(track.bpm).toBeGreaterThanOrEqual(CALM.bpm[0]);
    expect(track.bpm).toBeLessThanOrEqual(CALM.bpm[1]);
    expect(CALM.bpm[0]).toBeGreaterThanOrEqual(70);
    expect(CALM.bpm[1]).toBeLessThanOrEqual(85);
  });

  it("uses only soft voices", () => {
    expect(new Set(track.notes.map((n) => n.voice))).toEqual(new Set(["pad", "triangle", "sine"]));
  });

  it("stays in key", () => {
    for (const note of track.notes) expect(CALM.scale).toContain(pitchClass(note.midi));
  });

  it("lets every note ring out before the video ends", () => {
    for (const note of track.notes) {
      expect(note.start + note.dur + TAIL_SEC[note.voice]).toBeLessThan(61.5);
    }
  });

  it("ends on the home chord", () => {
    const lastStart = Math.max(...track.notes.filter((n) => n.voice === "pad").map((n) => n.start));
    const lastChord = track.notes.filter((n) => n.voice === "pad" && n.start === lastStart);
    expect(new Set(lastChord.map((n) => pitchClass(n.midi)))).toEqual(new Set([0, 4, 7]));
  });

  it("keeps Shorts Studio's scale and motif helpers' behaviour", () => {
    expect(scaleMidi([0, 2, 4, 5, 7, 9, 11], 0, 60, 7)).toBe(72);
    expect(scaleMidi([0, 2, 4, 5, 7, 9, 11], 0, 60, -1)).toBe(59);
    const motif = makeMotif(makeRng(1));
    expect(motif.reduce((sum, m) => sum + m.beats, 0)).toBe(4);
  });
});
```

`video/tests/audio/music.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SAMPLE_RATE } from "../../src/audio/constants";
import { CEILING } from "../../src/audio/mixer";
import { applyFades, renderMusic, tickNotes } from "../../src/audio/music";

describe("the music track", () => {
  const options = { totalSec: 10, seed: 3, ticks: [4], fadeInSec: 2, fadeOutSec: 3 };
  const track = renderMusic(options);

  it("lasts exactly as long as the video", () => {
    expect(track.left.length).toBe(Math.ceil(10 * SAMPLE_RATE));
    expect(track.right.length).toBe(track.left.length);
  });

  it("fades in from silence and out to silence", () => {
    expect(track.left[0]).toBe(0);
    expect(track.left[track.left.length - 1]).toBe(0);
  });

  it("stays under the mixer's ceiling", () => {
    let peak = 0;
    for (let i = 0; i < track.left.length; i++) {
      peak = Math.max(peak, Math.abs(track.left[i] ?? 0), Math.abs(track.right[i] ?? 0));
    }
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(peak).toBeGreaterThan(0.1);
  });

  it("is the same track for the same seed", () => {
    expect(renderMusic(options).left).toEqual(track.left);
  });

  it("puts one soft tick at each moment asked for", () => {
    expect(tickNotes([4, 9.5])).toEqual([
      { voice: "tick", start: 4, dur: 0.05, midi: 88, vel: 0.35 },
      { voice: "tick", start: 9.5, dur: 0.05, midi: 88, vel: 0.35 }
    ]);
  });

  it("fades linearly at both ends and leaves the middle alone", () => {
    const s = { left: Float32Array.of(1, 1, 1, 1, 1), right: Float32Array.of(1, 1, 1, 1, 1) };
    applyFades(s, 2, 2, 1);
    expect(Array.from(s.left)).toEqual([0, 0.5, 1, 0.5, 0]);
  });
});
```

Run: `pnpm --dir video test`
Expected: FAIL, modules not found.

- [ ] **Step 2: Write `calm.ts`**

```ts
// A calm arrangement for the demo video, written for this repository on top of
// the synth copied from Shorts Studio. scaleMidi and makeMotif are copied from
// Shorts Studio's src/audio/composer.ts at commit 5675fc1; the rest is new.
import { fitBefore } from "./notes";
import { makeRng, type Rng } from "./rng";
import type { NoteEvent } from "./types";

export const CALM = {
  scale: [0, 2, 4, 5, 7, 9, 11],
  bpm: [72, 84] as const,
  progressions: [
    [0, 5, 3, 4],
    [0, 3, 5, 4],
    [5, 3, 0, 4]
  ]
};

const BEATS_PER_BAR = 4;
const BASS = 36;
const MID = 60;
const LEAD = 72;
// The last bar starts at least this long before the end, so its chord can ring.
const FINAL_BAR_LEAD_SEC = 2;

export type MotifNote = { step: number; beats: number };

export function scaleMidi(scale: number[], root: number, base: number, degree: number): number {
  const n = scale.length;
  const octave = Math.floor(degree / n);
  const d = ((degree % n) + n) % n;
  return base + root + (scale[d] ?? 0) + 12 * octave;
}

// 4 to 8 notes spread over 8 eighth-notes, ending on a chord tone.
export function makeMotif(rng: Rng): MotifNote[] {
  const count = rng.int(4, 8);
  const eighths = new Array<number>(count).fill(1);
  for (let extra = 8 - count; extra > 0; extra--) eighths[rng.int(0, count - 1)]++;
  let step = 0;
  return eighths.map((len, i) => {
    if (i > 0) step += rng.pick([-2, -1, 1, 1, 2, 3, -3, 0]);
    if (i === count - 1) step = rng.pick([0, 2, 4]);
    return { step, beats: len / 2 };
  });
}

export type CalmTrack = { bpm: number; root: number; notes: NoteEvent[] };

/** Pads holding each bar's chord, a soft bass, a gentle eighth-note pulse and a sparse sine lead. */
export function composeCalm({ totalSec, seed }: { totalSec: number; seed: number }): CalmTrack {
  const rng = makeRng(seed);
  const bpm = rng.int(CALM.bpm[0], CALM.bpm[1]);
  const root = rng.int(0, 11);
  const progression = rng.pick(CALM.progressions);
  const motif = makeMotif(rng);
  const beat = 60 / bpm;
  const bar = beat * BEATS_PER_BAR;
  const lastBar = Math.max(0, Math.floor((totalSec - FINAL_BAR_LEAD_SEC) / bar));
  const deg = (base: number, degree: number) => scaleMidi(CALM.scale, root, base, degree);
  const notes: NoteEvent[] = [];
  const add = (note: NoteEvent) => {
    const fit = fitBefore(note, totalSec);
    if (fit !== undefined) notes.push(fit);
  };

  for (let b = 0; b <= lastBar; b++) {
    const t = b * bar;
    const chord = b === lastBar ? 0 : (progression[b % progression.length] ?? 0);
    for (const degree of [chord, chord + 2, chord + 4]) {
      add({ voice: "pad", start: t, dur: bar, midi: deg(MID, degree), vel: 0.5 });
    }
    for (const at of [0, 2]) {
      add({ voice: "triangle", start: t + at * beat, dur: beat * 1.5, midi: deg(BASS, chord), vel: 0.45 });
    }
    if (b === lastBar) continue;
    for (let e = 0; e < 8; e++) {
      const degree = chord + ([0, 2, 4, 2][e % 4] ?? 0);
      add({ voice: "sine", start: t + (e * beat) / 2, dur: (beat / 2) * 0.8, midi: deg(MID + 12, degree), vel: 0.18 });
    }
    if (b >= 2 && b % 2 === 0) {
      let at = 0;
      for (const m of motif) {
        add({ voice: "sine", start: t + at * beat, dur: m.beats * beat * 0.9, midi: deg(LEAD, chord + m.step), vel: 0.3 });
        at += m.beats;
      }
    }
  }
  return { bpm, root, notes };
}
```

Note on the "stays in key" test: `scaleMidi` adds `root`, and `pitchClass` subtracts it, so every note's class is a member of `CALM.scale` by construction; the final pad chord is degrees 0, 2, 4, which are classes 0, 4, 7.

- [ ] **Step 3: Write `music.ts`**

```ts
// Renders the demo's music: the calm arrangement, the two soft ticks, and the
// fades, mixed by the mixer copied from Shorts Studio. Final loudness is set by
// ffmpeg's loudnorm in scripts/render.ts.
import { composeCalm } from "./calm";
import { SAMPLE_RATE } from "./constants";
import { mix } from "./mixer";
import { renderNotes } from "./synth";
import type { NoteEvent, Stereo } from "./types";

export type MusicOptions = {
  totalSec: number;
  seed: number;
  /** Seconds at which a highlight lands. */
  ticks: readonly number[];
  fadeInSec: number;
  fadeOutSec: number;
};

const TICK_MIDI = 88;

export const tickNotes = (ticks: readonly number[]): NoteEvent[] =>
  ticks.map((start) => ({ voice: "tick", start, dur: 0.05, midi: TICK_MIDI, vel: 0.35 }));

export function renderMusic(options: MusicOptions, sr = SAMPLE_RATE): Stereo {
  const { notes } = composeCalm({ totalSec: options.totalSec, seed: options.seed });
  const music = renderNotes(notes, options.totalSec, sr);
  const ticks = renderNotes(tickNotes(options.ticks), options.totalSec, sr);
  const nothing: Stereo = {
    left: new Float32Array(music.left.length),
    right: new Float32Array(music.right.length)
  };
  // Ticks ride on top of the music without ducking it.
  return applyFades(mix(music, nothing, ticks, sr), options.fadeInSec, options.fadeOutSec, sr);
}

/** Linear fades from and to silence, in place. */
export function applyFades(s: Stereo, inSec: number, outSec: number, sr = SAMPLE_RATE): Stereo {
  const n = s.left.length;
  const fadeIn = Math.round(inSec * sr);
  const fadeOut = Math.round(outSec * sr);
  for (let i = 0; i < n; i++) {
    const gain = Math.min(1, fadeIn > 0 ? i / fadeIn : 1, fadeOut > 0 ? (n - 1 - i) / fadeOut : 1);
    s.left[i] = (s.left[i] ?? 0) * gain;
    s.right[i] = (s.right[i] ?? 0) * gain;
  }
  return s;
}
```

- [ ] **Step 4: Run, listen once, commit**

```bash
pnpm --dir video test
pnpm --dir video typecheck
```

Expected: PASS. Then write a one-off WAV to listen to (not committed):

```bash
OUT_WAV="$SCRATCH/music-preview.wav" pnpm --dir video exec tsx -e 'import { writeFileSync } from "node:fs"; import { renderMusic } from "./src/audio/music"; import { encodeWav } from "./src/audio/wav"; writeFileSync(process.env.OUT_WAV ?? "music-preview.wav", encodeWav(renderMusic({ totalSec: 61.5, seed: 20261004, ticks: [24.3, 46.3], fadeInSec: 4.5, fadeOutSec: 5 })));'
```

(The ticks are where scenes 6 and 10 land their highlights: each scene's start plus 0.8 s.)

Send `$SCRATCH/music-preview.wav` to Jorge with SendUserFile (status proactive) so he can veto the mood early; do not wait for an answer to continue.

```bash
pnpm exec prettier --write video
git add video
git commit -m "feat(video): calm arrangement and music track with fades and ticks"
```

---

### Task 7: The story: scenes, captions, transcript

**Files:**
- Create: `video/src/geometry.ts`, `video/src/scenes.ts`, `video/src/captions.ts`, `video/src/transcript.ts`
- Test: `video/tests/scenes.test.ts`, `video/tests/transcript.test.ts`
- Delete: `video/tests/smoke.test.ts`

- [ ] **Step 1: Write the failing tests**

`video/tests/scenes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateLines, minSeconds, words } from "../src/captions";
import { captionText, FORMATS, SCENES } from "../src/scenes";

describe("captions", () => {
  it("counts words the way a reader does", () => {
    expect(words("  Search by the account's Salesforce ID. ")).toBe(6);
    expect(words("Looking for pilot teams: pilots@wayscribe.dev")).toBe(5);
  });

  it("asks for 1 second per 3 words plus 1, never under 2.5 seconds", () => {
    expect(minSeconds("one two three four five six")).toBe(3);
    expect(minSeconds("Short.")).toBe(2.5);
  });

  it("estimates wrapped lines conservatively", () => {
    expect(estimateLines("a".repeat(10), 50, 1000)).toBe(1);
    expect(estimateLines("aaaa ".repeat(20).trim(), 50, 300)).toBe(10);
  });
});

describe("the story", () => {
  it("gives every caption at least its reading time", () => {
    for (const scene of SCENES) {
      expect(scene.seconds, scene.id).toBeGreaterThanOrEqual(minSeconds(captionText(scene)));
    }
  });

  it("runs about a minute", () => {
    const total = SCENES.reduce((sum, scene) => sum + scene.seconds, 0);
    expect(total).toBeGreaterThanOrEqual(55);
    expect(total).toBeLessThanOrEqual(65);
  });

  it("uses no em dashes, en dashes or backticks", () => {
    for (const scene of SCENES) expect(captionText(scene), scene.id).not.toMatch(/[\u2013\u2014`]/);
  });

  it("fits every caption on its band's lines in both formats", () => {
    for (const scene of SCENES) {
      if (scene.kind !== "capture") continue;
      for (const format of Object.values(FORMATS)) {
        const lines = estimateLines(scene.caption, format.captionPx, format.captionMaxWidth - 72);
        expect(lines, `${scene.id} ${format.id}`).toBeLessThanOrEqual(format.captionLines);
      }
    }
  });

  it("opens on the hook and closes on the call to pilot teams", () => {
    expect(SCENES[0]?.kind).toBe("card");
    const last = SCENES[SCENES.length - 1];
    expect(last?.kind).toBe("card");
    expect(last === undefined ? "" : captionText(last)).toContain("pilots@wayscribe.dev");
  });

  it("gives every scene a unique id and every capture scene a shot in each format", () => {
    expect(new Set(SCENES.map((scene) => scene.id)).size).toBe(SCENES.length);
    for (const scene of SCENES) {
      if (scene.kind !== "capture") continue;
      for (const format of Object.values(FORMATS)) {
        expect(scene.shots[format.id].length, `${scene.id} ${format.id}`).toBeGreaterThan(0);
        for (const shot of scene.shots[format.id]) expect(shot.maxZoom).toBeLessThanOrEqual(2.2);
      }
    }
  });

  it("sounds a tick only where a highlight lands, and exactly twice", () => {
    const ticking = SCENES.filter((scene) => scene.kind === "capture" && scene.tick === true);
    expect(ticking.map((scene) => scene.id)).toEqual(["phone", "comparison"]);
    for (const scene of ticking) if (scene.kind === "capture") expect(scene.highlight).toBeDefined();
  });

  it("glides only into a scene that starts on the frame the previous one froze on", () => {
    SCENES.forEach((scene, index) => {
      if (scene.kind !== "capture" || scene.enter !== "glide") return;
      const previous = SCENES[index - 1];
      expect(previous?.kind).toBe("capture");
      if (previous?.kind === "capture") {
        expect(previous.until).toBeUndefined();
        expect(previous.from).toBe(scene.from);
      }
    });
  });
});
```

`video/tests/transcript.test.ts`:

```ts
import { expect, it } from "vitest";
import { SCENES } from "../src/scenes";
import { transcript } from "../src/transcript";

it("lists every caption in order, cards line by line, with no dashes", () => {
  const text = transcript(SCENES);
  let at = 0;
  for (const scene of SCENES) {
    for (const line of scene.kind === "card" ? scene.lines : [scene.caption]) {
      const found = text.indexOf(line, at);
      expect(found, line).toBeGreaterThanOrEqual(at);
      at = found + line.length;
    }
  }
  expect(text).not.toMatch(/[\u2013\u2014]/);
  expect(text.startsWith("Wayscribe demo: finding a lost phone number\n")).toBe(true);
  expect(text.endsWith("\n")).toBe(true);
});
```

Run: `rm video/tests/smoke.test.ts && pnpm --dir video test`
Expected: FAIL, modules not found.

- [ ] **Step 2: Write `geometry.ts` and `captions.ts`**

`video/src/geometry.ts`:

```ts
/** A rectangle in CSS pixels of the captured page, relative to its viewport. */
export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
```

`video/src/captions.ts`:

```ts
export const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

/** The spec's reading rule: 1 second per 3 words plus 1 second, never under 2.5 seconds. */
export const minSeconds = (text: string): number => Math.max(2.5, words(text) / 3 + 1);

/**
 * Lines `text` wraps to at `fontPx` in `maxWidthPx`, assuming every character
 * is 0.58 em wide: wider than Inter's average, so the estimate errs high. The
 * stills review in Task 13 is the real check.
 */
export function estimateLines(text: string, fontPx: number, maxWidthPx: number): number {
  const perLine = Math.floor(maxWidthPx / (fontPx * 0.58));
  let lines = 1;
  let used = 0;
  for (const word of text.trim().split(/\s+/)) {
    const need = used === 0 ? word.length : used + 1 + word.length;
    if (need <= perLine) used = need;
    else {
      lines++;
      used = word.length;
    }
  }
  return lines;
}
```

- [ ] **Step 3: Write `scenes.ts`**

Use Task 1's decision for the `phone` caption (the alternative wording is in Task 1, Step 5). Replace the line marked below if Task 1 found the step shown as succeeded.

```ts
// The story, scene by scene: the single source for order, caption text,
// timing and framing. Every caption has to stay true to what is on screen. If
// the demo changes what it shows, change the caption, not the other way round.

export const FPS = 30;

export type FormatId = "wide" | "square";

export type Format = {
  id: FormatId;
  width: number;
  height: number;
  captionPx: number;
  captionMaxWidth: number;
  captionLines: number;
  captionBottom: number;
  /** Height kept clear at the bottom for the caption; the camera frames subjects above it. */
  band: number;
};

export const FORMATS: Record<FormatId, Format> = {
  wide: { id: "wide", width: 1920, height: 1080, captionPx: 48, captionMaxWidth: 1600, captionLines: 2, captionBottom: 48, band: 230 },
  square: { id: "square", width: 1080, height: 1080, captionPx: 44, captionMaxWidth: 960, captionLines: 3, captionBottom: 40, band: 270 }
};

/** Frame `box` of mark `mark`, zoomed in no further than `maxZoom` output pixels per CSS pixel. */
export type Shot = { mark: string; box: string; maxZoom: number };

export type Highlight = { mark: string; box: string; tone: "lost" | "kept" };

export type CardScene = {
  id: string;
  kind: "card";
  layout: "statement" | "end";
  lines: string[];
  seconds: number;
};

export type CaptureScene = {
  id: string;
  kind: "capture";
  caption: string;
  seconds: number;
  /** The mark the scene opens on. */
  from: string;
  /** The mark the scene's action runs up to; without one, the scene holds `from`. */
  until?: string;
  /** Fade in over the previous scene, or glide the camera on from where it stopped. */
  enter: "fade" | "glide";
  shots: Record<FormatId, Shot[]>;
  highlight?: Highlight;
  tick?: boolean;
};

export type Scene = CardScene | CaptureScene;

export const captionText = (scene: Scene): string =>
  scene.kind === "card" ? scene.lines.join(" ") : scene.caption;

const same = (mark: string, box: string, maxZoom: number): Record<FormatId, Shot[]> => ({
  wide: [{ mark, box, maxZoom }],
  square: [{ mark, box, maxZoom }]
});

export const SCENES: readonly Scene[] = [
  {
    id: "hook",
    kind: "card",
    layout: "statement",
    lines: ["A phone number left Salesforce.", "It never reached the CRM."],
    seconds: 4.5
  },
  {
    id: "search",
    kind: "capture",
    caption: "Search by the account's Salesforce ID.",
    seconds: 4,
    from: "home",
    until: "results",
    enter: "fade",
    shots: same("home", "query", 1.6)
  },
  {
    id: "results",
    kind: "capture",
    caption: "Two journeys for this account. One completed, one failed.",
    seconds: 5,
    from: "results",
    until: "timeline",
    enter: "fade",
    shots: same("results", "results", 1.5)
  },
  {
    id: "timeline",
    kind: "capture",
    caption: "Delivery failed twice. Was that where the phone was lost?",
    seconds: 5,
    from: "timeline",
    until: "diff",
    enter: "fade",
    shots: same("timeline", "steps", 1.4)
  },
  {
    id: "diff",
    kind: "capture",
    caption: "The transform step: what it received and what it produced.",
    seconds: 5,
    from: "diff",
    enter: "fade",
    shots: { wide: [{ mark: "diff", box: "diff", maxZoom: 1.5 }], square: [{ mark: "diff", box: "phone", maxZoom: 1.2 }] }
  },
  {
    id: "phone",
    kind: "capture",
    // Task 1 decides between this and the "reported success" wording.
    caption: "The phone goes in with a value and comes out null. This step lost it.",
    seconds: 7,
    from: "diff",
    enter: "glide",
    shots: same("diff", "phone", 2.2),
    highlight: { mark: "diff", box: "phone", tone: "lost" },
    tick: true
  },
  {
    id: "completed",
    kind: "capture",
    caption: "For contrast: this input carried Phone__c, so the phone survived.",
    seconds: 6,
    from: "good-diff",
    enter: "fade",
    shots: same("good-diff", "phone", 1.8),
    highlight: { mark: "good-diff", box: "phone", tone: "kept" }
  },
  {
    id: "replay",
    kind: "capture",
    caption: "Replay the step's recorded input against development, where the fix runs.",
    seconds: 6,
    from: "replay-link",
    until: "replay-response",
    enter: "fade",
    shots: {
      wide: [
        { mark: "replay-link", box: "replay", maxZoom: 1.6 },
        { mark: "replay-form", box: "form", maxZoom: 1.6 }
      ],
      square: [
        { mark: "replay-link", box: "replay", maxZoom: 1.6 },
        { mark: "replay-form", box: "form", maxZoom: 1.6 }
      ]
    }
  },
  {
    id: "response",
    kind: "capture",
    caption: "The fixed transform answers 200.",
    seconds: 3,
    from: "replay-response",
    enter: "fade",
    shots: same("replay-response", "response", 1.8)
  },
  {
    id: "comparison",
    kind: "capture",
    caption: "Original against replay: null before, the phone number after.",
    seconds: 6,
    from: "comparison",
    enter: "fade",
    shots: same("comparison", "phone", 2.0),
    highlight: { mark: "comparison", box: "phone", tone: "kept" },
    tick: true
  },
  {
    id: "end",
    kind: "card",
    layout: "end",
    lines: [
      "Wayscribe",
      "Follow one record through every service, see what each step changed, and replay it.",
      "Self-hosted and open source: wayscribe.dev",
      "Looking for pilot teams: pilots@wayscribe.dev"
    ],
    seconds: 10
  }
];
```

- [ ] **Step 4: Write `transcript.ts`**

```ts
import type { Scene } from "./scenes";

/** The captions in order, as site/public/videos/wayscribe-demo-transcript.txt. */
export function transcript(scenes: readonly Scene[]): string {
  const blocks = scenes.map((scene) => (scene.kind === "card" ? scene.lines.join("\n") : scene.caption));
  return [
    "Wayscribe demo: finding a lost phone number",
    "",
    "Caption transcript. The video has no narration: these are its on-screen captions, in order.",
    "",
    blocks.join("\n\n"),
    ""
  ].join("\n");
}
```

- [ ] **Step 5: Run, format, commit**

```bash
pnpm --dir video test
pnpm --dir video typecheck
pnpm exec prettier --write video
git add -A video
git commit -m "feat(video): the story's scenes, captions and transcript"
```

Expected: all pass.

---

### Task 8: Capture types and the timeline

**Files:**
- Create: `video/src/capture.ts`, `video/src/timeline.ts`, `video/src/fixtures/capture.json`
- Test: `video/tests/timeline.test.ts`

- [ ] **Step 1: Write the synthetic fixture**

`video/src/fixtures/capture.json` (replaced by the real capture's manifest in Task 9; frames trimmed):

```json
{
  "version": 1,
  "viewport": { "width": 1920, "height": 1080 },
  "scale": 2,
  "frames": [
    { "at": 0, "file": "frames/000000.png" },
    { "at": 1000, "file": "frames/000001.png" }
  ],
  "marks": [
    { "name": "home", "at": 1000, "boxes": { "query": { "x": 560, "y": 220, "width": 800, "height": 48 } } },
    {
      "name": "results",
      "at": 5200,
      "boxes": {
        "failed": { "x": 480, "y": 300, "width": 960, "height": 56 },
        "completed": { "x": 480, "y": 356, "width": 960, "height": 56 },
        "results": { "x": 480, "y": 300, "width": 960, "height": 112 }
      }
    },
    {
      "name": "timeline",
      "at": 9800,
      "boxes": {
        "steps": { "x": 480, "y": 140, "width": 960, "height": 520 },
        "failure": { "x": 480, "y": 600, "width": 960, "height": 60 },
        "transform": { "x": 480, "y": 320, "width": 960, "height": 60 }
      }
    },
    {
      "name": "diff",
      "at": 13900,
      "boxes": {
        "diff": { "x": 480, "y": 120, "width": 960, "height": 560 },
        "phone": { "x": 480, "y": 400, "width": 960, "height": 96 }
      }
    },
    {
      "name": "good-diff",
      "at": 16500,
      "boxes": {
        "diff": { "x": 480, "y": 120, "width": 960, "height": 560 },
        "phone": { "x": 480, "y": 380, "width": 960, "height": 96 }
      }
    },
    { "name": "replay-link", "at": 19800, "boxes": { "replay": { "x": 480, "y": 300, "width": 180, "height": 32 } } },
    {
      "name": "replay-form",
      "at": 22400,
      "boxes": {
        "destination": { "x": 480, "y": 260, "width": 600, "height": 40 },
        "form": { "x": 480, "y": 260, "width": 600, "height": 360 }
      }
    },
    { "name": "replay-response", "at": 25600, "boxes": { "response": { "x": 480, "y": 60, "width": 960, "height": 140 } } },
    {
      "name": "comparison",
      "at": 26600,
      "boxes": {
        "comparison": { "x": 480, "y": 120, "width": 960, "height": 400 },
        "phone": { "x": 480, "y": 300, "width": 960, "height": 48 }
      }
    },
    { "name": "end", "at": 27400, "boxes": {} }
  ],
  "clicks": [
    { "at": 1800, "x": 680, "y": 244 },
    { "at": 3900, "x": 1300, "y": 244 },
    { "at": 6000, "x": 600, "y": 328 },
    { "at": 10600, "x": 600, "y": 350 },
    { "at": 20600, "x": 570, "y": 316 },
    { "at": 23200, "x": 900, "y": 600 }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

`video/tests/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type Capture, frameAt } from "../src/capture";
import fixture from "../src/fixtures/capture.json";
import { type CaptureScene, type CardScene, SCENES } from "../src/scenes";
import { buildTimeline, frameAtSourceMs, GLIDE_FRAMES, sourceMsAt } from "../src/timeline";

const capture = fixture as Capture;
const box = { x: 0, y: 0, width: 100, height: 100 };
const tiny: Capture = {
  version: 1,
  viewport: { width: 1920, height: 1080 },
  scale: 2,
  frames: [{ at: 0, file: "f0" }],
  marks: [
    { name: "a", at: 1000, boxes: { b: box } },
    { name: "c", at: 3000, boxes: { b: box } },
    { name: "d", at: 13000, boxes: { b: box } }
  ],
  clicks: []
};
const card = (id: string, seconds: number): CardScene => ({ id, kind: "card", layout: "statement", lines: ["x"], seconds });
// A capture scene from mark "a" to mark "c" over 3 s, framing box "b" of its opening mark.
const scene = (over: Partial<CaptureScene>): CaptureScene => {
  const from = over.from ?? "a";
  return {
    id: "s",
    kind: "capture",
    caption: "x",
    seconds: 3,
    from,
    until: "c",
    enter: "fade",
    shots: { wide: [{ mark: from, box: "b", maxZoom: 2 }], square: [{ mark: from, box: "b", maxZoom: 2 }] },
    ...over
  };
};

describe("frame lookup", () => {
  it("shows the last frame captured at or before a moment", () => {
    const frames = [
      { at: 0, file: "a" },
      { at: 100, file: "b" }
    ];
    expect(frameAt(frames, 50).file).toBe("a");
    expect(frameAt(frames, 100).file).toBe("b");
    expect(frameAt(frames, -1).file).toBe("a");
  });
});

describe("the timeline", () => {
  it("lays scenes end to end in whole frames", () => {
    const t = buildTimeline([card("one", 2), scene({})], tiny, 30);
    expect(t.scenes.map((s) => [s.startFrame, s.frames])).toEqual([
      [0, 60],
      [60, 90]
    ]);
    expect(t.totalFrames).toBe(150);
  });

  it("holds the opening state, then plays the action at real speed", () => {
    const [s] = buildTimeline([scene({})], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect([s.holdMs, s.rate]).toEqual([1000, 1]);
    expect(sourceMsAt(s, 0, 30)).toBe(1000);
    expect(sourceMsAt(s, 30, 30)).toBe(1000);
    expect(sourceMsAt(s, 60, 30)).toBe(2000);
    expect(sourceMsAt(s, 90, 30)).toBe(3000);
  });

  it("speeds the action up when the capture runs longer than the scene", () => {
    const [s] = buildTimeline([scene({ from: "c", until: "d", seconds: 5 })], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect([s.holdMs, s.rate]).toEqual([0, 2]);
    expect(sourceMsAt(s, 75, 30)).toBe(8000);
  });

  it("refuses to play capture faster than 3x", () => {
    expect(() => buildTimeline([scene({ from: "a", until: "d", seconds: 3 })], tiny, 30)).toThrow(/above 3x/);
  });

  it("freezes on its mark when a scene has no end mark", () => {
    const [s] = buildTimeline([scene({ from: "c", until: undefined, seconds: 2 })], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect(sourceMsAt(s, 59, 30)).toBe(3000);
  });

  it("maps a source moment back to the frame that shows it", () => {
    const [s] = buildTimeline([scene({})], tiny, 30).scenes;
    if (s === undefined) throw new Error("no scene");
    expect(frameAtSourceMs(s, 500, 30)).toBe(0);
    expect(frameAtSourceMs(s, 2000, 30)).toBe(60);
  });

  it("names every mark and box the scenes need that the capture lacks", () => {
    const broken = scene({
      until: "zz",
      shots: { wide: [{ mark: "a", box: "nope", maxZoom: 2 }], square: [{ mark: "a", box: "b", maxZoom: 2 }] }
    });
    expect(() => buildTimeline([broken], tiny, 30)).toThrow(/no mark "zz"[\s\S]*no box "nope"/);
  });

  it("refuses a shot whose mark falls outside its scene", () => {
    const early = scene({
      from: "c",
      until: "d",
      seconds: 6,
      shots: { wide: [{ mark: "a", box: "b", maxZoom: 2 }], square: [{ mark: "c", box: "b", maxZoom: 2 }] }
    });
    expect(() => buildTimeline([early], tiny, 30)).toThrow(/shot on mark "a" falls outside/);
  });

  it("sounds each tick once the camera has arrived", () => {
    const t = buildTimeline(
      [card("one", 2), scene({ tick: true, highlight: { mark: "a", box: "b", tone: "lost" } })],
      tiny,
      30
    );
    expect(t.ticks).toEqual([(60 + GLIDE_FRAMES) / 30]);
  });

  it("covers the real story with the recorded capture", () => {
    const t = buildTimeline(SCENES, capture);
    expect(t.totalFrames).toBe(1845);
    expect(t.ticks).toHaveLength(2);
  });
});
```

Run: `pnpm --dir video test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `capture.ts`**

```ts
import type { Box } from "./geometry";

// The capture's manifest, written by scripts/demo-video.mjs as marks.json.
// `at` values are milliseconds from the start of the capture; boxes and click
// points are CSS pixels; frames are `scale` device pixels per CSS pixel.

export type Frame = { at: number; file: string };
export type Mark = { name: string; at: number; boxes: Record<string, Box> };
export type Click = { at: number; x: number; y: number };
export type Capture = {
  version: 1;
  viewport: { width: number; height: number };
  scale: number;
  frames: Frame[];
  marks: Mark[];
  clicks: Click[];
};

/** The frame on screen at `at` ms: the last one captured at or before it (the first, before any). */
export function frameAt(frames: readonly Frame[], at: number): Frame {
  const first = frames[0];
  if (first === undefined) throw new Error("The capture has no frames.");
  if (at <= first.at) return first;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((frames[middle]?.at ?? Infinity) <= at) low = middle;
    else high = middle - 1;
  }
  return frames[low] ?? first;
}

export function findMark(capture: Capture, name: string): Mark | undefined {
  return capture.marks.find((mark) => mark.name === name);
}

export function markNamed(capture: Capture, name: string): Mark {
  const mark = findMark(capture, name);
  if (mark === undefined) throw new Error(`The capture has no mark "${name}".`);
  return mark;
}

export function boxOf(capture: Capture, mark: string, box: string): Box {
  const found = markNamed(capture, mark).boxes[box];
  if (found === undefined) throw new Error(`Mark "${mark}" has no box "${box}".`);
  return found;
}
```

- [ ] **Step 4: Write `timeline.ts`**

```ts
import { type Capture, findMark, markNamed } from "./capture";
import { FPS, type Scene } from "./scenes";

/** Fastest a scene may play its capture. */
export const MAX_RATE = 3;
/** How long the camera takes to arrive on a shot (0.8 s). */
export const GLIDE_FRAMES = 24;
/** How long a scene takes to fade in over the previous one (0.3 s). */
export const FADE_FRAMES = 9;

export type TimedScene = {
  scene: Scene;
  index: number;
  startFrame: number;
  frames: number;
  /** Capture scenes only: where the source window opens, how long it runs, how long the opening holds, how fast it plays. */
  fromMs: number;
  spanMs: number;
  holdMs: number;
  rate: number;
};

export type Timeline = { fps: number; totalFrames: number; scenes: TimedScene[]; ticks: number[] };

/** Every mark and box the scenes refer to that the capture lacks, as sentences. */
export function missingForScenes(scenes: readonly Scene[], capture: Capture): string[] {
  const problems: string[] = [];
  const needMark = (scene: Scene, name: string) => {
    if (findMark(capture, name) === undefined) problems.push(`Scene "${scene.id}": the capture has no mark "${name}".`);
  };
  const needBox = (scene: Scene, mark: string, box: string) => {
    const found = findMark(capture, mark);
    if (found !== undefined && found.boxes[box] === undefined) {
      problems.push(`Scene "${scene.id}": mark "${mark}" has no box "${box}".`);
    }
  };
  for (const scene of scenes) {
    if (scene.kind !== "capture") continue;
    needMark(scene, scene.from);
    if (scene.until !== undefined) needMark(scene, scene.until);
    for (const shots of Object.values(scene.shots)) {
      for (const shot of shots) {
        needMark(scene, shot.mark);
        needBox(scene, shot.mark, shot.box);
      }
    }
    if (scene.highlight !== undefined) {
      needMark(scene, scene.highlight.mark);
      needBox(scene, scene.highlight.mark, scene.highlight.box);
    }
  }
  return problems;
}

export function buildTimeline(scenes: readonly Scene[], capture: Capture, fps = FPS): Timeline {
  const problems = missingForScenes(scenes, capture);
  if (problems.length > 0) {
    throw new Error(`The capture does not cover the scenes:\n  ${problems.join("\n  ")}`);
  }
  const timed: TimedScene[] = [];
  const ticks: number[] = [];
  let startFrame = 0;
  for (const [index, scene] of scenes.entries()) {
    const frames = Math.round(scene.seconds * fps);
    const outMs = (frames / fps) * 1000;
    let fromMs = 0;
    let spanMs = 0;
    let holdMs = outMs;
    let rate = 1;
    if (scene.kind === "capture") {
      fromMs = markNamed(capture, scene.from).at;
      const untilMs = scene.until === undefined ? fromMs : markNamed(capture, scene.until).at;
      spanMs = untilMs - fromMs;
      if (spanMs < 0) throw new Error(`Scene "${scene.id}": mark "${String(scene.until)}" comes before "${scene.from}".`);
      for (const shots of Object.values(scene.shots)) {
        for (const shot of shots) {
          const at = markNamed(capture, shot.mark).at;
          if (at < fromMs || at > untilMs) {
            throw new Error(`Scene "${scene.id}": its shot on mark "${shot.mark}" falls outside the scene.`);
          }
        }
      }
      rate = Math.max(1, spanMs / outMs);
      if (rate > MAX_RATE) {
        throw new Error(
          `Scene "${scene.id}" would play ${String(spanMs)} ms of capture at ${rate.toFixed(2)}x, above ${String(MAX_RATE)}x. Lengthen the scene or tighten the capture.`
        );
      }
      holdMs = Math.max(0, outMs - spanMs);
      if (scene.tick === true) ticks.push((startFrame + GLIDE_FRAMES) / fps);
    }
    timed.push({ scene, index, startFrame, frames, fromMs, spanMs, holdMs, rate });
    startFrame += frames;
  }
  return { fps, totalFrames: startFrame, scenes: timed, ticks };
}

/** The capture moment shown `frame` frames into a capture scene: the opening held, then the action played. */
export function sourceMsAt(t: TimedScene, frame: number, fps = FPS): number {
  const u = (frame / fps) * 1000;
  if (u <= t.holdMs) return t.fromMs;
  return t.fromMs + Math.min(t.spanMs, (u - t.holdMs) * t.rate);
}

/** The frame within a capture scene that first shows capture moment `ms`. */
export function frameAtSourceMs(t: TimedScene, ms: number, fps = FPS): number {
  if (ms <= t.fromMs) return 0;
  const u = t.holdMs + (Math.min(ms, t.fromMs + t.spanMs) - t.fromMs) / t.rate;
  return Math.round((u / 1000) * fps);
}
```

Check against the tests: scene `a`..`c` (2000 ms) over 3 s gives hold 1000, rate 1, so frame 60 (2000 ms) shows 2000 ms of source past hold: `1000 + (2000 - 1000) = 2000`. `frameAtSourceMs(s, 2000)` is `1000 + 1000 = 2000` ms, frame 60.

- [ ] **Step 5: Run, format, commit**

```bash
pnpm --dir video test
pnpm --dir video typecheck
pnpm exec prettier --write video
git add video
git commit -m "feat(video): capture types and the scene timeline"
```

Expected: PASS.

---

### Task 9: Camera and cursor, checked against the real capture

**Files:**
- Create: `video/src/ease.ts`, `video/src/camera.ts`, `video/src/cursor.ts`
- Modify: `video/src/fixtures/capture.json` (replaced with the real manifest)
- Test: `video/tests/camera.test.ts`, `video/tests/cursor.test.ts`

- [ ] **Step 1: Write the failing tests**

`video/tests/camera.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { between, frameBox, minZoom, projectBox, safeArea, sceneCamera } from "../src/camera";
import { boxOf, type Capture } from "../src/capture";
import fixture from "../src/fixtures/capture.json";
import { FORMATS, SCENES } from "../src/scenes";
import { buildTimeline } from "../src/timeline";

const capture = fixture as Capture;
const viewport = { width: 1920, height: 1080 };
const wide = FORMATS.wide;

describe("framing", () => {
  it("frames a small box as close as the zoom limit allows, centred in the safe area", () => {
    const box = { x: 900, y: 500, width: 120, height: 40 };
    const view = frameBox(box, wide, viewport, 2.2);
    expect(view.zoom).toBe(2.2);
    const p = projectBox(view, box);
    expect(p.x + p.width / 2).toBeCloseTo(960);
    expect(p.y + p.height / 2).toBeCloseTo((1080 - wide.band) / 2);
  });

  it("zooms out to fit a big box, but never below the whole page", () => {
    expect(frameBox({ x: 0, y: 0, width: 1920, height: 1080 }, wide, viewport, 2.2)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it("keeps the view on the page near its edges", () => {
    const view = frameBox({ x: 0, y: 0, width: 50, height: 20 }, wide, viewport, 2);
    expect([view.x, view.y]).toEqual([0, 0]);
  });

  it("shows a square cut a full page height at the least", () => {
    expect(minZoom(FORMATS.square, viewport)).toBe(1);
  });

  it("glides zoom geometrically and arrives exactly", () => {
    const a = { x: 0, y: 0, zoom: 1 };
    const b = { x: 500, y: 300, zoom: 2 };
    const start = between(a, b, 0, wide);
    expect([start.x, start.y, start.zoom]).toEqual([0, 0, 1]);
    const end = between(a, b, 1, wide);
    expect(end.zoom).toBeCloseTo(2);
    expect(end.x).toBeCloseTo(500);
    expect(end.y).toBeCloseTo(300);
    expect(between(a, b, 0.5, wide).zoom).toBeCloseTo(Math.SQRT2);
  });
});

describe("the real story's framing", () => {
  it("keeps every shot's subject inside the frame and clear of the caption band, in both formats", () => {
    for (const scene of SCENES) {
      if (scene.kind !== "capture") continue;
      for (const format of Object.values(FORMATS)) {
        const safe = safeArea(format);
        for (const shot of scene.shots[format.id]) {
          const box = boxOf(capture, shot.mark, shot.box);
          const p = projectBox(frameBox(box, format, capture.viewport, shot.maxZoom), box);
          const inside =
            p.x >= -0.5 && p.y >= -0.5 && p.x + p.width <= safe.width + 0.5 && p.y + p.height <= safe.height + 0.5;
          expect(inside, `${scene.id} ${format.id} ${shot.box}`).toBe(true);
        }
      }
    }
  });

  it("starts a gliding scene exactly where the previous one stopped", () => {
    const t = buildTimeline(SCENES, capture);
    const i = t.scenes.findIndex((s) => s.scene.id === "phone");
    const previous = t.scenes[i - 1];
    if (previous === undefined) throw new Error("no previous scene");
    for (const format of Object.values(FORMATS)) {
      const a = sceneCamera(t, i, 0, format, capture);
      const b = sceneCamera(t, i - 1, previous.frames - 1, format, capture);
      expect(a.zoom).toBeCloseTo(b.zoom);
      expect(a.x).toBeCloseTo(b.x);
      expect(a.y).toBeCloseTo(b.y);
    }
  });
});
```

`video/tests/cursor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cursorAt, LEAD_MS, RIPPLE_MS, rippleAt, showsCursor } from "../src/cursor";

const clicks = [
  { at: 1000, x: 100, y: 100 },
  { at: 3000, x: 500, y: 300 }
];
const start = { x: 960, y: 540 };

describe("the drawn cursor", () => {
  it("rests at the start until the lead before the first click", () => {
    expect(cursorAt(clicks, 100, start)).toEqual(start);
  });

  it("arrives on each click exactly as it lands", () => {
    expect(cursorAt(clicks, 1000, start)).toEqual({ x: 100, y: 100 });
    expect(cursorAt(clicks, 3000, start)).toEqual({ x: 500, y: 300 });
  });

  it("glides over the lead, halfway at its middle", () => {
    expect(cursorAt(clicks, 3000 - LEAD_MS / 2, start)).toEqual({ x: 300, y: 200 });
  });

  it("rests on the last click between glides", () => {
    expect(cursorAt(clicks, 2000, start)).toEqual({ x: 100, y: 100 });
  });

  it("ripples for a moment after a click, then stops", () => {
    expect(rippleAt(clicks, 1000)?.progress).toBe(0);
    expect(rippleAt(clicks, 1000 + RIPPLE_MS / 2)?.progress).toBeCloseTo(0.5);
    expect(rippleAt(clicks, 1000 + RIPPLE_MS + 1)).toBeUndefined();
    expect(rippleAt(clicks, 500)).toBeUndefined();
  });

  it("shows only in scenes whose action holds a click", () => {
    expect(showsCursor(clicks, 0, 1500)).toBe(true);
    expect(showsCursor(clicks, 1500, 1000)).toBe(false);
  });
});
```

Run: `pnpm --dir video test`
Expected: FAIL, modules not found.

- [ ] **Step 2: Write `ease.ts`, `camera.ts`, `cursor.ts`**

`video/src/ease.ts`:

```ts
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
```

`video/src/camera.ts`:

```ts
import { boxOf, type Capture, markNamed } from "./capture";
import { clamp01, easeInOutCubic } from "./ease";
import type { Box, Point } from "./geometry";
import type { CaptureScene, Format } from "./scenes";
import { frameAtSourceMs, GLIDE_FRAMES, type Timeline, type TimedScene } from "./timeline";

/** A view of the page: its top-left corner in CSS pixels, and output pixels per CSS pixel. */
export type Camera = { x: number; y: number; zoom: number };
type Viewport = { width: number; height: number };

/** Space kept around a subject, in CSS pixels. */
export const PADDING = 32;

/** The part of the frame above the caption band, where subjects are framed. */
export const safeArea = (format: Format): Box => ({
  x: 0,
  y: 0,
  width: format.width,
  height: format.height - format.band
});

/** The least zoom that still fills the frame with page. */
export const minZoom = (format: Format, viewport: Viewport): number =>
  Math.max(format.width / viewport.width, format.height / viewport.height);

export function clampCamera(c: Camera, format: Format, viewport: Viewport): Camera {
  const w = format.width / c.zoom;
  const h = format.height / c.zoom;
  return {
    zoom: c.zoom,
    x: Math.min(Math.max(0, c.x), viewport.width - w),
    y: Math.min(Math.max(0, c.y), viewport.height - h)
  };
}

/** The view that frames `box` in the safe area, as close as `maxZoom` allows, kept on the page. */
export function frameBox(box: Box, format: Format, viewport: Viewport, maxZoom: number): Camera {
  const safe = safeArea(format);
  const fit = Math.min(safe.width / (box.width + 2 * PADDING), safe.height / (box.height + 2 * PADDING));
  const zoom = Math.max(minZoom(format, viewport), Math.min(maxZoom, fit));
  const x = box.x + box.width / 2 - (safe.x + safe.width / 2) / zoom;
  const y = box.y + box.height / 2 - (safe.y + safe.height / 2) / zoom;
  return clampCamera({ x, y, zoom }, format, viewport);
}

const centre = (c: Camera, format: Format): Point => ({
  x: c.x + format.width / c.zoom / 2,
  y: c.y + format.height / c.zoom / 2
});

/** The widest view about the same centre: where a scene that fades in starts its zoom. */
export function widest(target: Camera, format: Format, viewport: Viewport): Camera {
  const zoom = minZoom(format, viewport);
  const c = centre(target, format);
  return clampCamera({ zoom, x: c.x - format.width / zoom / 2, y: c.y - format.height / zoom / 2 }, format, viewport);
}

/** Between two views at progress `t`: zoom moves geometrically and the centre linearly, eased. */
export function between(a: Camera, b: Camera, t: number, format: Format): Camera {
  const e = easeInOutCubic(clamp01(t));
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e);
  const ca = centre(a, format);
  const cb = centre(b, format);
  const cx = ca.x + (cb.x - ca.x) * e;
  const cy = ca.y + (cb.y - ca.y) * e;
  return { zoom, x: cx - format.width / zoom / 2, y: cy - format.height / zoom / 2 };
}

export const project = (c: Camera, p: Point): Point => ({ x: (p.x - c.x) * c.zoom, y: (p.y - c.y) * c.zoom });

export const projectBox = (c: Camera, b: Box): Box => ({
  x: (b.x - c.x) * c.zoom,
  y: (b.y - c.y) * c.zoom,
  width: b.width * c.zoom,
  height: b.height * c.zoom
});

/**
 * The camera `frame` frames into capture scene `index`. Each shot takes over
 * when the capture reaches its mark, and the camera glides to it over
 * GLIDE_FRAMES: from the previous shot, from where the previous scene stopped
 * (a "glide" entrance), or from the widest view (a "fade" entrance).
 */
export function sceneCamera(timeline: Timeline, index: number, frame: number, format: Format, capture: Capture): Camera {
  const timed = timeline.scenes[index] as TimedScene;
  const scene = timed.scene as CaptureScene;
  const shots = scene.shots[format.id];
  const views = shots.map((shot) => frameBox(boxOf(capture, shot.mark, shot.box), format, capture.viewport, shot.maxZoom));
  const starts = shots.map((shot, i) => (i === 0 ? 0 : frameAtSourceMs(timed, markNamed(capture, shot.mark).at, timeline.fps)));
  let active = 0;
  while (active + 1 < shots.length && frame >= (starts[active + 1] ?? Infinity)) active++;
  const target = views[active] as Camera;
  let origin: Camera;
  if (active > 0) origin = views[active - 1] as Camera;
  else if (scene.enter === "glide" && index > 0) {
    const previous = timeline.scenes[index - 1] as TimedScene;
    origin = sceneCamera(timeline, index - 1, previous.frames - 1, format, capture);
  } else origin = widest(target, format, capture.viewport);
  const t = (frame - (starts[active] ?? 0)) / GLIDE_FRAMES;
  return clampCamera(between(origin, target, t, format), format, capture.viewport);
}
```

`video/src/cursor.ts`:

```ts
import type { Click } from "./capture";
import { clamp01, easeInOutCubic } from "./ease";
import type { Point } from "./geometry";

/** CLICK_LEAD_MS in scripts/demo-video.mjs: the capture waits this long before each click. */
export const LEAD_MS = 800;
export const RIPPLE_MS = 450;

/** Where the drawn cursor is at capture moment `ms`: resting on the last click, gliding to the next over the lead. */
export function cursorAt(clicks: readonly Click[], ms: number, start: Point): Point {
  let previous: Point = start;
  for (const click of clicks) {
    if (click.at <= ms) {
      previous = click;
      continue;
    }
    const t = (ms - (click.at - LEAD_MS)) / LEAD_MS;
    if (t <= 0) break;
    const e = easeInOutCubic(clamp01(t));
    return { x: previous.x + (click.x - previous.x) * e, y: previous.y + (click.y - previous.y) * e };
  }
  return { x: previous.x, y: previous.y };
}

/** The ripple of the latest click, while it lasts. */
export function rippleAt(clicks: readonly Click[], ms: number): (Point & { progress: number }) | undefined {
  for (let i = clicks.length - 1; i >= 0; i--) {
    const click = clicks[i] as Click;
    if (click.at > ms) continue;
    const progress = (ms - click.at) / RIPPLE_MS;
    return progress <= 1 ? { x: click.x, y: click.y, progress } : undefined;
  }
  return undefined;
}

/** A scene draws the cursor only when its action holds a click. */
export const showsCursor = (clicks: readonly Click[], fromMs: number, spanMs: number): boolean =>
  clicks.some((click) => click.at >= fromMs && click.at <= fromMs + spanMs);
```

Run: `pnpm --dir video test`
Expected: PASS against the synthetic fixture.

- [ ] **Step 3: Swap in the real capture's manifest**

Copy Task 3's manifest over the fixture, keeping only its first three frames (the fixture is a test input, not a capture):

```bash
node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); m.frames=m.frames.slice(0,3); fs.writeFileSync(process.argv[2], JSON.stringify(m,null,2)+"\n");' "$SCRATCH/out/capture/marks.json" video/src/fixtures/capture.json
pnpm --dir video test
```

Expected: the framing test may now FAIL for some scene and format: that is this step's point. For each failure, change that scene's shot in `video/src/scenes.ts` (a smaller box, a lower `maxZoom`, or for the square a different box) until the subject fits clear of the band. Typical fix: the square `diff` scene frames `phone` rather than the whole table. The timeline test "covers the real story" may fail with a rate above 3x: lengthen that scene or tighten the capture's waits. Do not loosen a test to pass.

- [ ] **Step 4: Format, commit**

```bash
pnpm --dir video typecheck
pnpm exec prettier --write video
git add video
git commit -m "feat(video): camera framing and drawn cursor, fitted to the real capture"
```

---

### Task 10: The Remotion composition

**Files:**
- Create: `video/src/index.ts`, `video/src/Root.tsx`, `video/src/Demo.tsx`, `video/src/theme.ts`
- Create: `video/src/components/{CaptureView,Card,Caption,Cursor,Highlight}.tsx`
- Create: `video/scripts/bundle.ts`, `video/scripts/preview-stills.ts`

Components are checked by type-checking and by looking at rendered stills (Step 4), not by unit tests.

- [ ] **Step 1: Theme, entry and root**

`video/src/theme.ts`:

```ts
export const FONT = "Inter";
export const INK = "#0f172a";
export const PAPER = "#f8fafc";
export const MUTED = "#94a3b8";
export const PAGE = "#ffffff";
export const LOST = "#ef4444";
export const KEPT = "#22c55e";
export const POINTER = "#2563eb";
```

`video/src/index.ts`:

```ts
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
```

`video/src/Root.tsx`:

```tsx
import { loadFont } from "@remotion/fonts";
import { Composition, staticFile } from "remotion";
import type { Capture } from "./capture";
import { Demo, type DemoProps } from "./Demo";
import sample from "./fixtures/capture.json";
import { FORMATS, FPS, SCENES } from "./scenes";
import { FONT } from "./theme";
import { buildTimeline } from "./timeline";

// Inter (SIL OFL 1.1, @fontsource/inter), copied into the render's public
// directory by scripts/bundle.ts. Nothing is fetched from a font host.
for (const weight of ["400", "600", "700"]) {
  void loadFont({ family: FONT, url: staticFile(`fonts/inter-latin-${weight}-normal.woff2`), weight });
}

const calculateMetadata = ({ props }: { props: DemoProps }) => ({
  durationInFrames: buildTimeline(SCENES, props.capture, FPS).totalFrames
});

export const Root = () => (
  <>
    <Composition
      id="DemoWide"
      component={Demo}
      width={FORMATS.wide.width}
      height={FORMATS.wide.height}
      fps={FPS}
      durationInFrames={1}
      defaultProps={{ capture: sample as Capture, format: "wide" }}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="DemoSquare"
      component={Demo}
      width={FORMATS.square.width}
      height={FORMATS.square.height}
      fps={FPS}
      durationInFrames={1}
      defaultProps={{ capture: sample as Capture, format: "square" }}
      calculateMetadata={calculateMetadata}
    />
  </>
);
```

- [ ] **Step 2: The composition and its components**

`video/src/Demo.tsx`:

```tsx
import { useMemo } from "react";
import { AbsoluteFill, interpolate, Sequence, useCurrentFrame } from "remotion";
import type { Capture } from "./capture";
import { CaptureView } from "./components/CaptureView";
import { Card } from "./components/Card";
import { FORMATS, type FormatId, SCENES } from "./scenes";
import { INK } from "./theme";
import { buildTimeline, FADE_FRAMES, type Timeline, type TimedScene } from "./timeline";

export type DemoProps = { capture: Capture; format: FormatId };

export const Demo = ({ capture, format }: DemoProps) => {
  const timeline = useMemo(() => buildTimeline(SCENES, capture), [capture]);
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      {timeline.scenes.map((timed) => {
        const last = timed.index === timeline.scenes.length - 1;
        // Each scene stays on screen, frozen on its last frame, while the next fades in over it.
        return (
          <Sequence key={timed.scene.id} from={timed.startFrame} durationInFrames={timed.frames + (last ? 0 : FADE_FRAMES)}>
            <SceneView timed={timed} timeline={timeline} capture={capture} format={format} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

const SceneView = ({
  timed,
  timeline,
  capture,
  format
}: {
  timed: TimedScene;
  timeline: Timeline;
  capture: Capture;
  format: FormatId;
}) => {
  const local = useCurrentFrame();
  const frame = Math.min(local, timed.frames - 1);
  const glides = timed.scene.kind === "capture" && timed.scene.enter === "glide";
  const opacity =
    timed.index === 0 || glides ? 1 : interpolate(local, [0, FADE_FRAMES], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity }}>
      {timed.scene.kind === "card" ? (
        <Card scene={timed.scene} format={FORMATS[format]} />
      ) : (
        <CaptureView timed={timed} timeline={timeline} capture={capture} format={FORMATS[format]} frame={frame} />
      )}
    </AbsoluteFill>
  );
};
```

`video/src/components/CaptureView.tsx`:

```tsx
import { AbsoluteFill, Img, staticFile } from "remotion";
import { project, projectBox, sceneCamera } from "../camera";
import { boxOf, type Capture, frameAt } from "../capture";
import { cursorAt, rippleAt, showsCursor } from "../cursor";
import type { CaptureScene, Format } from "../scenes";
import { PAGE } from "../theme";
import { GLIDE_FRAMES, sourceMsAt, type Timeline, type TimedScene } from "../timeline";
import { Caption } from "./Caption";
import { Cursor } from "./Cursor";
import { Highlight } from "./Highlight";

export const CaptureView = ({
  timed,
  timeline,
  capture,
  format,
  frame
}: {
  timed: TimedScene;
  timeline: Timeline;
  capture: Capture;
  format: Format;
  frame: number;
}) => {
  const scene = timed.scene as CaptureScene;
  const ms = sourceMsAt(timed, frame, timeline.fps);
  const camera = sceneCamera(timeline, timed.index, frame, format, capture);
  const shown = frameAt(capture.frames, ms);
  const { width, height } = capture.viewport;
  const s = capture.scale;
  const start = { x: width / 2, y: height / 2 };
  const ripple = rippleAt(capture.clicks, ms);
  return (
    <AbsoluteFill style={{ backgroundColor: PAGE, overflow: "hidden" }}>
      <Img
        src={staticFile(`capture/${shown.file}`)}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: width * s,
          height: height * s,
          transformOrigin: "0 0",
          transform: `scale(${String(camera.zoom / s)}) translate(${String(-camera.x * s)}px, ${String(-camera.y * s)}px)`
        }}
      />
      {scene.highlight === undefined ? null : (
        <Highlight
          box={projectBox(camera, boxOf(capture, scene.highlight.mark, scene.highlight.box))}
          tone={scene.highlight.tone}
          frame={frame}
          at={GLIDE_FRAMES}
        />
      )}
      {showsCursor(capture.clicks, timed.fromMs, timed.spanMs) ? (
        <Cursor
          at={project(camera, cursorAt(capture.clicks, ms, start))}
          ripple={ripple === undefined ? undefined : { ...project(camera, ripple), progress: ripple.progress }}
        />
      ) : null}
      <Caption text={scene.caption} format={format} frame={frame} />
    </AbsoluteFill>
  );
};
```

`video/src/components/Caption.tsx`:

```tsx
import { interpolate } from "remotion";
import type { Format } from "../scenes";
import { FONT, INK, PAPER } from "../theme";

/** One idea per screen, large, on a solid backing, in the band the camera keeps clear. */
export const Caption = ({ text, format, frame }: { text: string; format: Format; frame: number }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: format.captionBottom,
      display: "flex",
      justifyContent: "center",
      opacity: interpolate(frame, [0, 6], [0, 1], { extrapolateRight: "clamp" })
    }}
  >
    <div
      style={{
        maxWidth: format.captionMaxWidth,
        padding: "20px 36px",
        borderRadius: 16,
        backgroundColor: INK,
        color: PAPER,
        fontFamily: FONT,
        fontWeight: 600,
        fontSize: format.captionPx,
        lineHeight: 1.25,
        textAlign: "center",
        boxShadow: "0 8px 30px rgba(0, 0, 0, 0.35)"
      }}
    >
      {text}
    </div>
  </div>
);
```

`video/src/components/Card.tsx`:

```tsx
import { AbsoluteFill } from "remotion";
import type { CardScene, Format } from "../scenes";
import { FONT, INK, MUTED, PAPER } from "../theme";

export const Card = ({ scene, format }: { scene: CardScene; format: Format }) => {
  const square = format.id === "square";
  const [title, line, ...rest] = scene.lines;
  return (
    <AbsoluteFill
      style={{
        backgroundColor: INK,
        color: PAPER,
        fontFamily: FONT,
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: square ? 72 : 160
      }}
    >
      {scene.layout === "statement"
        ? scene.lines.map((text) => (
            <div key={text} style={{ fontSize: square ? 60 : 72, fontWeight: 600, lineHeight: 1.3 }}>
              {text}
            </div>
          ))
        : [
            <div key="title" style={{ fontSize: square ? 96 : 120, fontWeight: 700 }}>
              {title}
            </div>,
            <div key="line" style={{ marginTop: 32, fontSize: square ? 40 : 48, fontWeight: 600, lineHeight: 1.3, maxWidth: 1400 }}>
              {line}
            </div>,
            ...rest.map((text) => (
              <div key={text} style={{ marginTop: 24, fontSize: square ? 34 : 40, color: MUTED }}>
                {text}
              </div>
            ))
          ]}
    </AbsoluteFill>
  );
};
```

`video/src/components/Cursor.tsx`:

```tsx
import type { Point } from "../geometry";
import { INK, POINTER } from "../theme";

/** A drawn pointer (Playwright's capture shows none), with a ripple as a click lands. */
export const Cursor = ({ at, ripple }: { at: Point; ripple?: Point & { progress: number } }) => (
  <>
    {ripple === undefined ? null : (
      <div
        style={{
          position: "absolute",
          left: ripple.x - (12 + 30 * ripple.progress),
          top: ripple.y - (12 + 30 * ripple.progress),
          width: 2 * (12 + 30 * ripple.progress),
          height: 2 * (12 + 30 * ripple.progress),
          borderRadius: "50%",
          border: `4px solid ${POINTER}`,
          opacity: 0.6 * (1 - ripple.progress)
        }}
      />
    )}
    <svg style={{ position: "absolute", left: at.x - 6, top: at.y - 3 }} width={36} height={36} viewBox="0 0 24 24">
      <path
        d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.5 L12 13.5 L19 13.5 Z"
        fill="#ffffff"
        stroke={INK}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  </>
);
```

`video/src/components/Highlight.tsx`:

```tsx
import { interpolate } from "remotion";
import type { Box } from "../geometry";
import { KEPT, LOST } from "../theme";

/** Outlines the subject once the camera has arrived, and dims the rest of the page a little. */
export const Highlight = ({ box, tone, frame, at }: { box: Box; tone: "lost" | "kept"; frame: number; at: number }) => {
  const p = interpolate(frame, [at, at + 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pad = 8;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x - pad,
        top: box.y - pad,
        width: box.width + 2 * pad,
        height: box.height + 2 * pad,
        border: `5px solid ${tone === "lost" ? LOST : KEPT}`,
        borderRadius: 12,
        opacity: p,
        transform: `scale(${String(1.06 - 0.06 * p)})`,
        boxShadow: `0 0 0 9999px rgba(15, 23, 42, ${String(0.18 * p)})`
      }}
    />
  );
};
```

Run: `pnpm --dir video typecheck`
Expected: PASS. If Remotion's `Composition` rejects `DemoProps` (it requires props assignable to `Record<string, unknown>`), keep `DemoProps` a `type` alias (not an `interface`), which satisfies it.

- [ ] **Step 3: Bundling and preview stills**

`video/scripts/bundle.ts`:

```ts
import { copyFile, link, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import type { Capture } from "../src/capture";

export const VIDEO = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function readCapture(captureDir: string): Promise<Capture> {
  const capture = JSON.parse(await readFile(join(captureDir, "marks.json"), "utf8")) as Capture;
  if (capture.version !== 1) throw new Error(`Unknown capture version ${String(capture.version)}.`);
  return capture;
}

/**
 * Builds the render's public directory (the capture's frames, hard-linked, and
 * the Inter font files) under `outDir`, and bundles the composition with it.
 */
export async function prepareBundle(captureDir: string, outDir: string): Promise<string> {
  const publicDir = join(outDir, "render-public");
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(join(publicDir, "capture", "frames"), { recursive: true });
  await mkdir(join(publicDir, "fonts"), { recursive: true });
  for (const name of await readdir(join(captureDir, "frames"))) {
    await link(join(captureDir, "frames", name), join(publicDir, "capture", "frames", name));
  }
  for (const weight of ["400", "600", "700"]) {
    const file = `inter-latin-${weight}-normal.woff2`;
    await copyFile(join(VIDEO, "node_modules", "@fontsource", "inter", "files", file), join(publicDir, "fonts", file));
  }
  return bundle({ entryPoint: join(VIDEO, "src", "index.ts"), publicDir });
}
```

If hard links fail across file systems (`EXDEV`), the capture and `OUT_DIR` are on different volumes: keep `OUT_DIR` holding both, as `scripts/demo-video.mjs` does by default.

`video/scripts/preview-stills.ts`:

```ts
// Renders a still at the middle of every scene in both formats, for review
// while building: pnpm --dir video exec tsx scripts/preview-stills.ts --capture <dir> --out <dir>
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderStill, selectComposition } from "@remotion/renderer";
import { SCENES } from "../src/scenes";
import { buildTimeline } from "../src/timeline";
import { prepareBundle, readCapture } from "./bundle";

const { values } = parseArgs({ options: { capture: { type: "string" }, out: { type: "string" } } });
if (values.capture === undefined || values.out === undefined) throw new Error("Pass --capture and --out.");
const capture = await readCapture(values.capture);
const timeline = buildTimeline(SCENES, capture);
const serveUrl = await prepareBundle(values.capture, values.out);
for (const [id, format] of [
  ["DemoWide", "wide"],
  ["DemoSquare", "square"]
] as const) {
  const inputProps = { capture, format };
  const composition = await selectComposition({ serveUrl, id, inputProps });
  const dir = join(values.out, "preview", format);
  await mkdir(dir, { recursive: true });
  for (const timed of timeline.scenes) {
    const frame = timed.startFrame + Math.floor(timed.frames / 2);
    const output = join(dir, `${String(timed.index + 1).padStart(2, "0")}-${timed.scene.id}.png`);
    await renderStill({ composition, serveUrl, output, frame, inputProps, imageFormat: "png" });
    console.log(`  ${output}`);
  }
}
```

- [ ] **Step 4: Render the preview stills and look at them**

```bash
pnpm --dir video exec tsx scripts/preview-stills.ts --capture "$SCRATCH/out/capture" --out "$SCRATCH/out"
```

The first run downloads Remotion's headless browser once. Expected: 22 PNGs. Open several of each format (Read tool), at least: hook, search, diff, phone, comparison, end. Check: the page is sharp (text in the phone scene is crisp, not smeared); the caption sits in its band and covers no subject; the highlight outlines the phone rows; cards use Inter (not a serif fallback). Fix and re-render until right.

- [ ] **Step 5: Format, commit**

```bash
pnpm --dir video typecheck
pnpm --dir video test
pnpm exec prettier --write video
git add video
git commit -m "feat(video): Remotion composition with captions, camera, cursor and highlights"
```

---

### Task 11: Render pipeline and output checks

**Files:**
- Create: `video/src/checks.ts`, `video/scripts/ffmpeg.ts`, `video/scripts/render.ts`
- Test: `video/tests/checks.test.ts`

- [ ] **Step 1: Write the failing tests**

`video/tests/checks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { integratedLufs, loudnormMeasure, type Probe, videoProblems } from "../src/checks";

const wide = { width: 1920, height: 1080, minSeconds: 55, maxSeconds: 65, maxBytes: 8_000_000 };
const good: Probe = {
  format: { duration: "61.5", size: "6000000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
    { codec_type: "audio", codec_name: "aac" }
  ]
};

describe("output checks", () => {
  it("passes a cut that meets the spec", () => {
    expect(videoProblems("wide", good, wide)).toEqual([]);
  });

  it("names each way a cut misses the spec", () => {
    const bad: Probe = {
      format: { duration: "70", size: "9000000" },
      streams: [{ codec_type: "video", codec_name: "hevc", width: 1280, height: 720 }]
    };
    expect(videoProblems("wide", bad, wide)).toEqual([
      "wide: 70.0 s, outside 55 to 65 s.",
      "wide: 9.0 MB, over 8.0 MB.",
      "wide: video is hevc 1280x720, not h264 1920x1080.",
      "wide: 0 AAC audio streams, not 1."
    ]);
  });

  it("reads the integrated loudness from ffmpeg's ebur128 summary", () => {
    const stderr =
      "[Parsed_ebur128_0 @ 0x1] t: 1.0 M: -21.0\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -20.3 LUFS\n    Threshold: -30.6 LUFS\n";
    expect(integratedLufs(stderr)).toBe(-20.3);
    expect(() => integratedLufs("nothing")).toThrow();
  });

  it("reads loudnorm's first-pass measurement", () => {
    const stderr =
      'noise\n[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-27.61",\n\t"input_tp" : "-9.40",\n\t"input_lra" : "5.20",\n\t"input_thresh" : "-38.00",\n\t"output_i" : "-20.02",\n\t"target_offset" : "0.02"\n}\n';
    expect(loudnormMeasure(stderr)).toEqual({
      input_i: "-27.61",
      input_tp: "-9.40",
      input_lra: "5.20",
      input_thresh: "-38.00",
      target_offset: "0.02"
    });
  });
});
```

Run: `pnpm --dir video test`
Expected: FAIL, module not found.

- [ ] **Step 2: Write `checks.ts`**

```ts
export type Probe = {
  format: { duration: string; size: string };
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
};

export type Expectation = { width: number; height: number; minSeconds: number; maxSeconds: number; maxBytes: number };

export const LUFS_TARGET = -20;
export const LUFS_TOLERANCE = 1.5;
export const MAX_MP4_BYTES = 8_000_000;
export const MAX_GIF_BYTES = 2_000_000;

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** Everything about a probed cut that misses the spec, as sentences. */
export function videoProblems(name: string, probe: Probe, expect: Expectation): string[] {
  const problems: string[] = [];
  const seconds = Number(probe.format.duration);
  if (!(seconds >= expect.minSeconds && seconds <= expect.maxSeconds)) {
    problems.push(`${name}: ${seconds.toFixed(1)} s, outside ${String(expect.minSeconds)} to ${String(expect.maxSeconds)} s.`);
  }
  const bytes = Number(probe.format.size);
  if (bytes > expect.maxBytes) problems.push(`${name}: ${mb(bytes)}, over ${mb(expect.maxBytes)}.`);
  const videos = probe.streams.filter((s) => s.codec_type === "video");
  const video = videos[0];
  if (videos.length !== 1 || video === undefined) {
    problems.push(`${name}: ${String(videos.length)} video streams, not 1.`);
  } else if (video.codec_name !== "h264" || video.width !== expect.width || video.height !== expect.height) {
    problems.push(
      `${name}: video is ${video.codec_name} ${String(video.width)}x${String(video.height)}, not h264 ${String(expect.width)}x${String(expect.height)}.`
    );
  }
  const aac = probe.streams.filter((s) => s.codec_type === "audio" && s.codec_name === "aac").length;
  if (aac !== 1) problems.push(`${name}: ${String(aac)} AAC audio streams, not 1.`);
  return problems;
}

/** The integrated loudness, in LUFS, from the summary ffmpeg's ebur128 filter prints last. */
export function integratedLufs(stderr: string): number {
  const matches = [...stderr.matchAll(/Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?) LUFS/g)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) throw new Error("ffmpeg printed no integrated loudness.");
  return Number(last);
}

export type LoudnormMeasure = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/** loudnorm's first-pass measurement: the JSON block it prints last. */
export function loudnormMeasure(stderr: string): LoudnormMeasure {
  const json = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as Record<string, string>;
  const pick = (key: keyof LoudnormMeasure) => {
    const value = json[key];
    if (value === undefined) throw new Error(`loudnorm printed no ${key}.`);
    return value;
  };
  return {
    input_i: pick("input_i"),
    input_tp: pick("input_tp"),
    input_lra: pick("input_lra"),
    input_thresh: pick("input_thresh"),
    target_offset: pick("target_offset")
  };
}
```

Run: `pnpm --dir video test`
Expected: PASS.

- [ ] **Step 3: Write `scripts/ffmpeg.ts`**

```ts
import { spawnSync } from "node:child_process";
import { integratedLufs, loudnormMeasure, LUFS_TARGET, type Probe } from "../src/checks";

const FFMPEG = process.env["FFMPEG"] ?? "ffmpeg";
const FFPROBE = process.env["FFPROBE"] ?? "ffprobe";

function run(command: string, args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr.slice(-2000)}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const ffmpeg = (args: string[]) => run(FFMPEG, ["-hide_banner", "-y", ...args]);

export function probe(file: string): Probe {
  const { stdout } = run(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,codec_name,width,height",
    "-of",
    "json",
    file
  ]);
  return JSON.parse(stdout) as Probe;
}

/** Two-pass loudnorm to the spec's target: measure, then apply linearly. */
export function loudnorm(input: string, output: string): void {
  const filter = `loudnorm=I=${String(LUFS_TARGET)}:TP=-2:LRA=11`;
  const { stderr } = run(FFMPEG, ["-hide_banner", "-i", input, "-af", `${filter}:print_format=json`, "-f", "null", "-"]);
  const m = loudnormMeasure(stderr);
  ffmpeg([
    "-i",
    input,
    "-af",
    `${filter}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    "-ar",
    "48000",
    output
  ]);
}

export function loudness(file: string): number {
  const { stderr } = run(FFMPEG, ["-hide_banner", "-nostats", "-i", file, "-map", "0:a", "-af", "ebur128", "-f", "null", "-"]);
  return integratedLufs(stderr);
}

/** The final cut: the silent render re-encoded at `crf` with the music, ready to stream. */
export function encodeFinal(silent: string, music: string, output: string, crf: number): void {
  ffmpeg([
    "-i", silent,
    "-i", music,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", String(crf),
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "+faststart",
    output
  ]);
}

export function still(input: string, seconds: number, output: string): void {
  ffmpeg(["-ss", seconds.toFixed(3), "-i", input, "-frames:v", "1", output]);
}

export function gif(input: string, startSec: number, endSec: number, colors: number, output: string): void {
  ffmpeg([
    "-ss", startSec.toFixed(2),
    "-to", endSec.toFixed(2),
    "-i", input,
    "-vf",
    `fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${String(colors)}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    output
  ]);
}
```

- [ ] **Step 4: Write `scripts/render.ts`**

```ts
// Renders both cuts of the demo video from a capture, with music, posters, the
// README GIF, the transcript, a still per caption, and the spec's checks.
// Run through `pnpm demo:video` (see docs/DEMO_RECORDING.md), or directly:
//   pnpm --dir video exec tsx scripts/render.ts --capture <dir> --out <dir>
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { renderMusic } from "../src/audio/music";
import { encodeWav } from "../src/audio/wav";
import { LUFS_TARGET, LUFS_TOLERANCE, MAX_GIF_BYTES, MAX_MP4_BYTES, videoProblems } from "../src/checks";
import { FORMATS, type FormatId, SCENES } from "../src/scenes";
import { buildTimeline } from "../src/timeline";
import { transcript } from "../src/transcript";
import { prepareBundle, readCapture } from "./bundle";
import { encodeFinal, gif, loudness, loudnorm, probe, still } from "./ffmpeg";

const { values } = parseArgs({
  options: { capture: { type: "string" }, out: { type: "string" }, seed: { type: "string", default: "20261004" } }
});
if (values.capture === undefined || values.out === undefined) throw new Error("Pass --capture and --out.");
const OUT = values.out;
const capture = await readCapture(values.capture);
const timeline = buildTimeline(SCENES, capture);
const totalSec = timeline.totalFrames / timeline.fps;
const sceneById = (id: string) => {
  const found = timeline.scenes.find((t) => t.scene.id === id);
  if (found === undefined) throw new Error(`No scene "${id}".`);
  return found;
};
const seconds = (frame: number) => frame / timeline.fps;
const work = join(OUT, "work");
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

// Music: the calm arrangement, fading in over the hook card and out over the end card.
const hook = sceneById("hook");
const raw = join(work, "music.raw.wav");
const music = join(work, "music.wav");
await writeFile(
  raw,
  encodeWav(renderMusic({ totalSec, seed: Number(values.seed), ticks: timeline.ticks, fadeInSec: hook.scene.seconds, fadeOutSec: 5 }))
);
loudnorm(raw, music);

// Picture: one bundle, two silent near-lossless renders, then the final encodes.
const serveUrl = await prepareBundle(values.capture, OUT);
const CUTS: { id: string; format: FormatId; file: string; poster: string }[] = [
  { id: "DemoWide", format: "wide", file: "wayscribe-demo.mp4", poster: "wayscribe-demo-poster.png" },
  { id: "DemoSquare", format: "square", file: "wayscribe-demo-square.mp4", poster: "wayscribe-demo-square-poster.png" }
];
const problems: string[] = [];
const report: string[] = [];
const phone = sceneById("phone");
const posterAt = seconds(phone.startFrame + phone.frames / 2);

for (const cut of CUTS) {
  const inputProps = { capture, format: cut.format };
  const composition = await selectComposition({ serveUrl, id: cut.id, inputProps });
  const silent = join(work, `silent-${cut.format}.mp4`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    crf: 12,
    imageFormat: "png",
    muted: true,
    inputProps,
    outputLocation: silent,
    onProgress: ({ progress }) => process.stdout.write(`\r  ${cut.format} ${(progress * 100).toFixed(0)}%   `)
  });
  process.stdout.write("\n");
  const output = join(OUT, cut.file);
  for (let crf = 20; ; crf += 2) {
    encodeFinal(silent, music, output, crf);
    if ((await stat(output)).size <= MAX_MP4_BYTES) {
      report.push(`${cut.file}: CRF ${String(crf)}`);
      break;
    }
    if (crf >= 30) {
      problems.push(`${cut.file}: still over budget at CRF 30.`);
      break;
    }
  }
  const format = FORMATS[cut.format];
  problems.push(
    ...videoProblems(cut.format, probe(output), {
      width: format.width,
      height: format.height,
      minSeconds: 55,
      maxSeconds: 65,
      maxBytes: MAX_MP4_BYTES
    })
  );
  const lufs = loudness(output);
  report.push(`${cut.file}: ${lufs.toFixed(1)} LUFS integrated`);
  if (Math.abs(lufs - LUFS_TARGET) > LUFS_TOLERANCE) problems.push(`${cut.file}: ${lufs.toFixed(1)} LUFS, not about ${String(LUFS_TARGET)}.`);
  still(output, posterAt, join(OUT, cut.poster));

  // A still at the middle of every caption, to review without playing the video.
  const dir = join(OUT, "stills", cut.format);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const timed of timeline.scenes) {
    const name = `${String(timed.index + 1).padStart(2, "0")}-${timed.scene.id}.png`;
    still(output, seconds(timed.startFrame + timed.frames / 2), join(dir, name));
  }
}

// The README's GIF: the zoom onto the lost phone, from the 16:9 cut.
const gifPath = join(OUT, "demo-diff.gif");
for (const colors of [128, 64]) {
  gif(join(OUT, CUTS[0]?.file ?? ""), seconds(phone.startFrame), seconds(phone.startFrame + phone.frames), colors, gifPath);
  if ((await stat(gifPath)).size <= MAX_GIF_BYTES) break;
}
const gifBytes = (await stat(gifPath)).size;
report.push(`demo-diff.gif: ${(gifBytes / 1e6).toFixed(2)} MB`);
if (gifBytes > MAX_GIF_BYTES) problems.push(`demo-diff.gif: ${(gifBytes / 1e6).toFixed(2)} MB, over 2 MB.`);

await writeFile(join(OUT, "wayscribe-demo-transcript.txt"), transcript(SCENES));
const summary = [...report, "", problems.length === 0 ? "All checks pass." : `Problems:\n  ${problems.join("\n  ")}`].join("\n");
await writeFile(join(OUT, "report.txt"), `${summary}\n`);
console.log(`\n${summary}\n\n  ${OUT}`);
if (problems.length > 0) process.exitCode = 1;
```

- [ ] **Step 5: Render for real**

```bash
OUT_DIR="$SCRATCH/out" node scripts/demo-video.mjs --render-only
```

Expected: progress for both cuts, then a report ending "All checks pass." If loudness misses, adjust nothing in the check: re-run (loudnorm is deterministic) and if it still misses, report the measured value. If size misses at CRF 30, report: the capture likely has noise (for example a blinking caret) worth removing from the UI state.

- [ ] **Step 6: Format, commit**

```bash
pnpm --dir video typecheck
pnpm --dir video test
pnpm exec prettier --write video
git add video
git commit -m "feat(video): render pipeline with music, posters, GIF, transcript and checks"
```

---

### Task 12: Recording procedure rewritten

**Files:**
- Modify (rewrite): `docs/DEMO_RECORDING.md`

- [ ] **Step 1: Rewrite the document**

Replace `docs/DEMO_RECORDING.md` with:

````markdown
# Recording the demo video

The demo video is made in two steps. The capture drives the real web app
against the demo stack, the way a person would: it seeds missing journeys
through the source webhook, signs in outside the captured browser context,
opens the recorded transformation diff and sends that step's stored input to
an approved development replay destination. It does not change the replay
allowlist. The render then turns the capture into the finished cuts, with
burned-in captions, zoom, a drawn cursor and quiet music. There is no
narration: the video is made to be understood with the sound off.

Start the demo stack, install the video project once, then capture and render:

```bash
docker compose -f infrastructure/compose.yaml \
  -f infrastructure/compose.demo.yaml up --build -d
pnpm --dir video install
pnpm demo:video
```

`pnpm demo:video --capture-only` stops after the capture, and
`pnpm demo:video --render-only` renders the last capture again (after a
caption or timing change in `video/src/scenes.ts`, for example). The first
render downloads Remotion's headless browser once.

The capture reads `WEB_URL`, `API_URL`, `DEMO_SOURCE_URL`, `ADMIN_TOKEN`,
`ENTITY_ID`, `PROJECT_NAME`, `FFMPEG` and `OUT_DIR`; the render also reads
`FFPROBE`. Replay defaults to `http://demo-integration:3200`, the Compose
service address. Set `DEMO_REPLAY_URL` only when the capture runs in another
network topology, for example `DEMO_REPLAY_URL=http://127.0.0.1:3200` when the
demo integration service is published on that host port. The configured URL
must still satisfy the API's development replay policy and allowlist.

The capture reuses only an enabled recorder destination for the exact URL. It
uses a readable, non-secret URL-specific name when it creates one and leaves
unrelated destinations unchanged. If an exact recorder destination is
disabled, the capture stops with an instruction to enable it explicitly or
choose a different URL; it never re-enables or replaces it.

## What lands in `OUT_DIR`

- `capture/`: the captured frames, `marks.json` (when each moment of the story
  starts and where its subject is on screen) and `review/`, one still per mark
  with its boxes outlined.
- `wayscribe-demo.mp4` (16:9) and `wayscribe-demo-square.mp4` (1:1), their
  posters, `wayscribe-demo-transcript.txt` and `demo-diff.gif`.
- `stills/`: a still at the middle of every caption, in both formats.
- `report.txt`: sizes, loudness and the result of every check.

The story, its captions and their timing live in `video/src/scenes.ts`. Every
caption has to stay true to what is on screen: if the demo changes what it
shows, change the caption rather than the other way round. Captions follow a
reading rule (at least 1 second per 3 words plus 1 second, never under 2.5
seconds) that `pnpm --dir video test` enforces.

## Before replacing the published video

1. `report.txt` says all checks pass.
2. Every still in `stills/` has its caption fully inside the frame, clear of
   the subject the camera zoomed to, and readable.
3. Watch the square cut muted at phone width.
4. `pnpm test` and `pnpm --dir video test` pass.
5. Copy the cuts, posters and transcript to `site/public/videos/` and the GIF
   to `docs/images/demo-diff.gif`, and update the download size on the landing
   page (`site/src/content/docs/index.mdx`).
````

- [ ] **Step 2: Check and commit**

```bash
grep -n $'\u2014\|\u2013' docs/DEMO_RECORDING.md || echo "no dashes"
pnpm test
git add docs/DEMO_RECORDING.md
git commit -m "docs: demo recording procedure for capture then render"
```

Expected: "no dashes", tests pass.

---

### Task 13: CI job for the video project

**Files:**
- Modify: `.gitlab-ci.yml`, `tests/video-package.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe("the demo video project", ...)` in `tests/video-package.test.ts`:

```ts
  it("type-checks and tests in CI, only when it changes", () => {
    const ci = parse(read(".gitlab-ci.yml")) as Record<string, { script?: string[]; before_script?: string[]; rules?: unknown[] }>;
    const job = ci["video"];
    expect(job?.before_script).toContain("pnpm --dir video install --frozen-lockfile");
    expect(job?.script).toEqual(["pnpm --dir video run typecheck", "pnpm --dir video test"]);
    expect(JSON.stringify(job?.rules)).toContain("video/**/*");
  });
```

Note: the `yaml` parser resolves the `*video-changes` alias, so the rules contain the glob itself. If `parse` rejects GitLab's `!reference` tags anywhere in the file, read the job's block as text instead: slice from `\nvideo:\n` to the next top-level key and assert the same strings.

Run: `pnpm vitest run tests/video-package.test.ts`
Expected: FAIL (no `video` job).

- [ ] **Step 2: Add the job**

In `.gitlab-ci.yml`, after the `site:` job's block, add:

```yaml
# The demo video project (video/) is its own pnpm project, outside the
# workspace, so the default before_script would install everything else and
# not it. Rendering stays local; CI only type-checks it and runs its tests.
.video-changes: &video-changes
  - video/**/*
  - .gitlab-ci.yml

video:
  stage: test
  needs: []
  cache:
    key:
      files:
        - video/pnpm-lock.yaml
      prefix: video
    paths:
      - .pnpm-store
  before_script:
    - corepack enable
    - pnpm config set store-dir "$PNPM_STORE_DIR"
    - pnpm --dir video install --frozen-lockfile
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      when: never
    - if: $CI_COMMIT_TAG
      when: never
    - changes: *video-changes
  script:
    - pnpm --dir video run typecheck
    - pnpm --dir video test
```

- [ ] **Step 3: Rehearse the job in its image, then commit**

```bash
export DOCKER_CONFIG="$SCRATCH/docker-config"
docker run --rm -v "$PWD/video:/src:ro" node:24-alpine sh -c 'cp -r /src /w && cd /w && rm -rf node_modules && corepack enable && pnpm install --frozen-lockfile && pnpm run typecheck && pnpm test'
pnpm vitest run tests/video-package.test.ts
pnpm format:check
pnpm test
git add .gitlab-ci.yml tests/video-package.test.ts
git commit -m "ci: type-check and test the video project when it changes"
```

Expected: the container run passes on Alpine, root tests pass.

- [ ] **Step 4: Push the branch without a pipeline**

```bash
git push -o ci.skip -u origin demo-video-v2
```

---

### Task 14: Final render, checks, and Jorge's review (GATE)

**Files:** none committed in this task.

- [ ] **Step 1: Fresh capture and render**

```bash
export DOCKER_CONFIG="$SCRATCH/docker-config"
OUT_DIR="$SCRATCH/final" node scripts/demo-video.mjs
```

Expected: report ends "All checks pass."

- [ ] **Step 2: Check every output against the spec**

1. `cat "$SCRATCH/final/report.txt"`: both cuts within 55 to 65 s, one H.264 and one AAC stream each, each MP4 at most 8 MB, GIF at most 2 MB, loudness within -20 plus or minus 1.5 LUFS.
2. Open every still in `$SCRATCH/final/stills/wide/` and `$SCRATCH/final/stills/square/` (Read tool). For each: caption fully inside the frame, not covering the zoom target, readable; page text sharp in the zoomed scenes.
3. Em dashes: `grep -c $'\u2014\|\u2013' "$SCRATCH/final/wayscribe-demo-transcript.txt" video/src/scenes.ts` prints 0 for both.
4. Muted watch-through of the square cut at phone width (the controller does this step: subagents have no browser pane). Write `$SCRATCH/final/watch.html` containing `<!doctype html><meta name="viewport" content="width=device-width"><video src="wayscribe-demo-square.mp4" muted controls playsinline style="width:100%"></video>`, open it in the in-app browser pane, set the viewport to 375 px wide (`resize_window` preset mobile), play it through, and screenshot the phone scene and the comparison scene as evidence. If the pane refuses `file://`, serve the directory with `python3 -m http.server` on a free localhost port for the duration of the check. Reset the viewport afterwards.
5. `pnpm test` and `pnpm --dir video test`: both green.

- [ ] **Step 3: Send both cuts to Jorge and stop**

Send `wayscribe-demo.mp4`, `wayscribe-demo-square.mp4`, `demo-diff.gif`, `report.txt` and the transcript with SendUserFile (status proactive), with a short note listing: the final caption text (he approves the wording), the scene 6 wording chosen and why, the measured sizes and loudness, and anything that looked off. **Do not proceed to Task 15 until Jorge approves both cuts.** If he asks for changes, make them (usually in `video/src/scenes.ts` or the components), re-render with `--render-only`, and send again.

---

### Task 15: Publish on the branch, verify in CI, merge (after approval only)

**Files:**
- Add/replace: `site/public/videos/wayscribe-demo.mp4`, `wayscribe-demo-square.mp4`, `wayscribe-demo-poster.png`, `wayscribe-demo-square-poster.png`, `wayscribe-demo-transcript.txt`; `docs/images/demo-diff.gif`
- Delete: `site/public/videos/wayscribe-demo.en.vtt`
- Modify: `site/src/content/docs/index.mdx`, `site/README.md`, `tests/site.test.ts`, `CHANGELOG.md`

- [ ] **Step 1: Write the failing landing-page test**

In `tests/site.test.ts`, inside `describe("the landing page", ...)`, add (it uses the file's existing `landing`, `root` and `statSync` imports; add `statSync` to the `node:fs` import if missing):

```ts
  it("shows the captioned demo with its real download size and no caption track", () => {
    const video = landing.slice(landing.indexOf('<figure class="shot">'), landing.indexOf("</figure>"));
    expect(video).not.toContain("<track");
    expect(video).toContain('href="/videos/wayscribe-demo-transcript.txt"');
    expect(video).toContain('width="1920"');
    const bytes = statSync(join(root, "site/public/videos/wayscribe-demo.mp4")).size;
    expect(video).toContain(`Download video (MP4, ${String(Math.round(bytes / 1e6))} MB)`);
    expect(existsSync(join(root, "site/public/videos/wayscribe-demo.en.vtt"))).toBe(false);
  });
```

If `landing` is not the name the file uses for the landing page's text, use the variable it does define for `site/src/content/docs/index.mdx`.

Run: `pnpm vitest run tests/site.test.ts`
Expected: FAIL (track present, old size, old width).

- [ ] **Step 2: Copy the approved outputs**

```bash
F="$SCRATCH/final"
cp "$F/wayscribe-demo.mp4" "$F/wayscribe-demo-square.mp4" "$F/wayscribe-demo-poster.png" "$F/wayscribe-demo-square-poster.png" "$F/wayscribe-demo-transcript.txt" site/public/videos/
cp "$F/demo-diff.gif" docs/images/demo-diff.gif
git rm site/public/videos/wayscribe-demo.en.vtt
```

These must be the exact files Jorge approved (same render). Confirm with `shasum -a 256` against the files sent in Task 14.

- [ ] **Step 3: Update the landing page**

In `site/src/content/docs/index.mdx`:

- Line 26: replace "In 91 seconds, follow" with "In about a minute, follow".
- In the `<video>` element: `width="1920"` and `height="1080"`; delete the whole `<track ... />` element.
- Replace the `<figcaption>` contents with (N is the 16:9 MP4's size in MB, rounded):

```mdx
  <figcaption id="demo-caption">
    Captioned walkthrough with no narration, made to be followed with the sound
    off; quiet music plays underneath.
    {" "}<a href="/videos/wayscribe-demo-transcript.txt">Read the transcript</a>
    {" · "}<a href="/videos/wayscribe-demo.mp4" download>Download video (MP4, N MB)</a>
  </figcaption>
```

In `site/README.md`, replace the sentence about `public/videos/wayscribe-demo.en.vtt` and its cues with one saying the demo's captions are burned into the video, so there is no caption track, and the transcript at `public/videos/wayscribe-demo-transcript.txt` carries their text.

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]` in `CHANGELOG.md` (create a `### Changed` heading there if none exists), add:

```markdown
- The demo video is remade: about a minute, captioned for watching with the
  sound off, with no synthetic narration and quiet music, in 16:9 and a 1:1
  cut for social feeds. `pnpm demo:video` now captures the real web app and
  renders both cuts with the new `video/` project (docs/DEMO_RECORDING.md).
```

- [ ] **Step 5: Full checks**

```bash
grep -rn $'\u2014\|\u2013' site/src/content/docs/index.mdx site/README.md CHANGELOG.md docs/DEMO_RECORDING.md site/public/videos/wayscribe-demo-transcript.txt || echo "no dashes"
grep -rn "91 seconds\|narrat\|Kokoro\|wayscribe-demo.en.vtt" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.claude . | grep -v "docs/superpowers/\|CHANGELOG.md" || echo "no stale references"
pnpm format:check
pnpm lint
pnpm test
pnpm --dir video test
pnpm --dir site install --frozen-lockfile && pnpm --dir site run build
```

Expected: no dashes, no stale references (the CHANGELOG mentions narration on purpose), all green, site builds.

- [ ] **Step 6: Commit, push, and run one real pipeline with a deadline**

```bash
git add -A site/public/videos docs/images/demo-diff.gif site/src/content/docs/index.mdx site/README.md tests/site.test.ts CHANGELOG.md
git commit -m "feat(site): publish demo video v2 (captioned, muted-first, 16:9 and 1:1)"
git push origin demo-video-v2
```

Find the pipeline (`glab ci list --ref demo-video-v2 -P 1`) and wait on it with a 40-minute deadline (a loop that polls `glab api projects/:id/pipelines/<id>` every 30 s and gives up at the deadline). Expected: green, including the new `video` job and `site`.

- [ ] **Step 7: Merge**

With the pipeline green and Jorge's approval from Task 14 on record, fast-forward main (standing approval to merge verified work):

```bash
git fetch origin
git rebase origin/main   # only if main moved; then push and re-run Step 6's pipeline
git push origin demo-video-v2:main
```

Then wait on main's pipeline the same way (40-minute deadline), confirm `pages` deployed, and check the live landing page plays the new video (in-app browser, https://wayscribe.dev). Do not start any publishing job.
