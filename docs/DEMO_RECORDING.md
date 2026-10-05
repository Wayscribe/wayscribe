# Recording the demo video

The demo video is made in two steps. The capture drives the real web app
against the demo stack, the way a person would: it seeds missing journeys
through the source webhook, signs in outside the captured browser context,
opens the recorded transformation diff and sends that step's stored input to
an approved development replay destination. It does not change the replay
allowlist. The render then turns the capture into the finished cuts, with
burned-in captions, camera zoom, a drawn cursor and quiet music. There is no
narration: the video is made to be understood with the sound off.

## Run it

Start the demo stack and install the dependencies once. The capture drives
Chromium through the root workspace's Playwright, and the render uses the video
project's own dependencies:

```bash
docker compose -f infrastructure/compose.yaml \
  -f infrastructure/compose.demo.yaml up --build -d
pnpm install
pnpm exec playwright install chromium
pnpm --dir video install
```

Wait for the stack, which takes a few minutes the first time:

```bash
docker compose -f infrastructure/compose.yaml \
  -f infrastructure/compose.demo.yaml ps
```

Only `postgres` and `api` define a healthcheck, so they are the two that show
`healthy`; wait for both. `web`, `elasticmq`, `demo-target`,
`demo-integration`, `demo-worker` and `demo-source` have none and show
`running`. `demo-bootstrap` runs once and exits, so `ps` leaves it out
(`ps -a` shows it as `Exited (0)`). Then capture and render:

```bash
pnpm demo:video
```

The video project is its own pnpm project outside the root workspace and needs
Node 24. `ffmpeg` and `ffprobe` must be on the `PATH`, or named in
`FFMPEG` and `FFPROBE`. Remotion is not open source: `video/README.md` points
to the licence summary to read before rendering on behalf of a company.

`pnpm demo:video --capture-only` stops after the capture, and
`pnpm demo:video --render-only` renders the last capture again (after a
caption or timing change in `video/src/scenes.ts`, for example). The first
render downloads Remotion's headless browser once. To see every scene's
still without encoding anything, run
`pnpm --dir video exec tsx scripts/preview-stills.ts --capture <dir> --out <dir>`;
it writes `preview/wide/` and `preview/square/` under the output directory.

## Configuration

The capture reads `WEB_URL`, `API_URL`, `DEMO_SOURCE_URL`, `ADMIN_TOKEN`,
`ENTITY_ID`, `PROJECT_NAME`, `DEMO_REPLAY_URL`, `FFMPEG` and `OUT_DIR`; the
render reads `FFMPEG`, `FFPROBE` and the `OUT_DIR` the capture hands it.
`OUT_DIR` defaults to a `wayscribe-demo-video` directory in the system temp
directory, outside the repository, and nothing written there is committed.

Replay defaults to `http://demo-integration:3200`, the Compose service address.
Set `DEMO_REPLAY_URL` only when the capture runs in another network topology,
for example `DEMO_REPLAY_URL=http://127.0.0.1:3200` when the demo integration
service is published on that host port. The configured URL must still satisfy
the API's development replay policy and allowlist.

The capture reuses only an enabled recorder destination for the exact URL. It
uses a readable, non-secret URL-specific name when it creates one and leaves
unrelated destinations unchanged. If an exact recorder destination is
disabled, the capture stops with an instruction to enable it explicitly or
choose a different URL; it never re-enables or replaces it.

## What the capture records

The page is laid out at 1920x1080 CSS pixels and captured at twice that, so the
render can zoom onto a table row and still have a device pixel for every output
pixel. Chromium is launched with `--force-device-scale-factor=2` (a context
`deviceScaleFactor` does not enlarge the browser's screencast frames), and the
screencast is kept as 3840x2160 PNG files. The capture seeds the completed and
failed journeys it needs when they are missing, then waits, up to about 31
seconds, until the newest of them is out of the timeline's Live window, so the
timeline shows an old failure rather than a Live toggle.

`capture/marks.json` lists the frames, the clicks and the marks: when each
moment of the story starts and where its subject is on screen, as boxes in CSS
pixels. The marks are `home`, `results`, `timeline`, `diff`, `good-diff`,
`replay-link`, `replay-form`, `replay-response`, `comparison` and `end`. A
mark can carry several boxes: `home` has `query` (the search field) and `row`
(the field together with its search button). The capture also writes
`capture/review/`, one still per mark with its boxes outlined; check that each
outline sits on what the story is about before rendering.

## What the render does

The render builds a timeline from the story in `video/src/scenes.ts` and the
marks in the capture. A capture scene first holds its opening state while its
caption is read, then plays the action that leads to the next scene at real
speed, sped up (never past 3x) only when the action is longer than the scene.
The render stops with an error rather than play an action faster than that.

The camera frames each scene's subject above the caption band. It may zoom out
below 1x (never below 0.8, `MIN_ZOOM` in `video/src/camera.ts`) and move past
the page's top or bottom edge when the subject needs it. The app's pages are
white outside the content column, so the padding it shows there is filled with
white and reads as page.

The reading hold is measured, not enforced. In the first capture measured
(2026-10-04) four scenes started their action before the caption's reading time
was up: search by 3.0 s, replay by 2.0 s, timeline by 0.6 s and results by
0.4 s. The caption stays on screen through the action, and no scene is
lengthened to make up the difference. If a cut reads rushed when you watch it,
lengthen that scene in `video/src/scenes.ts`.

The music (the calm arrangement, fading in over the hook card and out over the
end card) is synthesized once and normalized to -20 LUFS. Then, for each cut
(16:9 at 1920x1080 and 1:1 at 1080x1080):

1. Remotion renders a silent, near-lossless H.264 video (CRF 12, PNG frames),
   also tagged `bt709`. Remotion's default is untagged BT.601, which players
   decode as BT.709 and which shifts saturated colours.
2. ffmpeg encodes the final H.264 video with the music as AAC at 128 kbit/s,
   starting at CRF 20 and raising it by 2 until the file is under 8 MB. The
   final encode sets the colour tags itself (`bt709` colour space, primaries
   and transfer, and `tv` range) rather than passing through whatever the
   silent render carries. As built, the wide cut lands at CRF 22 and 7.90 MB,
   close to that cap, so a busier capture can push it up another step. A cut
   still over budget at CRF 30 fails the check.
3. The checks run on the file itself: 55 to 65 seconds, under 8 MB, exactly
   one H.264 video stream at the format's size with `bt709` colour space,
   primaries and transfer and `tv` (limited) range (an untagged stream or any
   other value is rejected), exactly one AAC stream, and an integrated
   loudness within 1.5 LUFS of -20.

The poster is the midpoint of the `phone` scene, the zoom onto the lost phone.
`demo-diff.gif` is that whole scene taken from the 16:9 cut, 960 pixels wide at
10 frames per second with 128 colours (64 if that is over 2 MB).

## What lands in `OUT_DIR`

- `capture/`: `frames/` (the captured PNG frames), `marks.json` and `review/`.
- `wayscribe-demo.mp4` (16:9) and `wayscribe-demo-square.mp4` (1:1), their
  posters `wayscribe-demo-poster.png` and `wayscribe-demo-square-poster.png`,
  `wayscribe-demo-transcript.txt` and `demo-diff.gif`.
- `stills/wide/` and `stills/square/`: a still at the middle of every caption,
  named by scene (`06-phone.png`).
- `report.txt`: for each cut the CRF chosen, duration, size, codec and
  resolution, audio codec and integrated loudness; the GIF's size; then
  `All checks pass.` or a list of problems. The render exits with an error
  when any check fails.
- `work/`, `render-public/` and `render-bundle/`: intermediates (the silent
  renders and music, the capture's frames hard-linked with the Inter font
  files, and the Remotion bundle). The bundle always goes in the same
  `render-bundle/` directory, replaced on each render. They can be deleted
  once the cuts are final.

A new run replaces the last one's outputs, so copy out of `OUT_DIR` any cut
you want to keep, such as ones under review, before running again. A capture
deletes the previous `capture/` just before it starts recording, after seeding
and the Live-window wait. A render first deletes the
previous cuts, posters, `demo-diff.gif`, transcript, `report.txt` and
`stills/`, before anything that can fail. It then writes each output under a
`.partial` name and renames it into place only when it is complete. A render
that crashes therefore leaves no `report.txt` (so no stale `All checks pass.`)
and no cut that looks current, and `--render-only` leaves the capture alone.

## Changing the story

The story, its captions and their timing live in `video/src/scenes.ts`. Every
caption has to stay true to what is on screen: if the demo changes what it
shows, change the caption rather than the other way round. Captions follow a
reading rule (at least 1 second per 3 words plus 1 second, never under 2.5
seconds) that `pnpm --dir video test` enforces for every scene, along with the
total length (55 to 65 seconds) and that every caption fits its band in both
formats.

## Before replacing the published video

1. `report.txt` says `All checks pass.`
2. Every still in `stills/` has its caption fully inside the frame, clear of
   the subject the camera zoomed to, and readable. Where the camera zoomed out
   or left the page, no edge of the page shows.
3. Watch both cuts muted, the square one at phone width, and note any scene
   that reads rushed (see the reading hold above). Then watch once with sound:
   the music should stay quiet under the story.
4. `pnpm test` and `pnpm --dir video test` pass.
5. Copy the cuts, posters and transcript to `site/public/videos/` and the GIF
   to `docs/images/demo-diff.gif`, and update the download size on the landing
   page (`site/src/content/docs/index.mdx`).
