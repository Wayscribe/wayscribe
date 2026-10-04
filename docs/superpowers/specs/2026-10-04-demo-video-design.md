# Demo video v2 design

**Date:** 2026-10-04
**Status:** design approved in discussion; written spec awaiting Jorge's review
**Replaces:** the narrated 91-second walkthrough published 2026-09-19
(`site/public/videos/wayscribe-demo.mp4`)

## Why

The current video works but has two problems Jorge named:

1. It sounds generated. The Kokoro text-to-speech narration reads as AI to the
   audiences the launch targets (Hacker News, Reddit, LinkedIn).
2. Production polish. 1280×720, no cursor, no zoom on the diff, no
   transitions.

Decisions made in the 2026-10-04 discussion:

- **No voiceover at all.** The story is told by burned-in captions and motion.
  Music plays underneath, quietly. The video must make complete sense muted.
- **Approach A:** keep the scripted Playwright capture of the real product, and
  add an edit layer built with Remotion. No paid services and no screen
  recorder app.
- **Music from our own synth:** the Shorts Studio audio module, copied into
  this repository, with a new calm mood.
- **Same story, tighter:** the lost phone number, about 60 seconds.
- **Two outputs:** 16:9 (1920×1080) and 1:1 (1080×1080, for LinkedIn).

Out of scope: voiceover, a 9:16 vertical cut, AI avatars, stock music, any paid
service.

## Architecture

```
demo stack (compose.yaml + compose.demo.yaml)
        │
        ▼
scripts/demo-video.mjs  ──►  OUT_DIR/capture/
  (Playwright, real UI)        raw video or frames
                               marks.json  (times + element boxes + clicks)
        │
        ▼
video/  (Remotion, standalone package)
  src/scenes.ts        scene list: caption, time range, crop per format
  src/audio/           synth copied from Shorts Studio + calm mood
  src/Demo.tsx         composition, rendered twice (16:9, 1:1)
        │
        ▼
OUT_DIR/  wayscribe-demo.mp4, wayscribe-demo-square.mp4, posters,
          demo-diff.gif, transcript.txt, captions stills
```

One command builds everything: `pnpm demo:video` (capture, then render). A
render-only command reuses the last capture: `pnpm demo:video --render-only`.

### 1. Capture (`scripts/demo-video.mjs`, modified)

- Keep what works: the seeded journeys (`WANTED`: one completed with
  `Phone__c`, one failed with `{}` that dead-letters), sign-in in a separate
  unrecorded context with `storageState`, the replay-destination rules in
  `docs/DEMO_RECORDING.md`.
- Viewport 1920×1080. Remove the burned-in caption overlay and the narration
  hold timing (`holdFor`, `--narrate`), because captions now live in the edit
  layer.
- **Marks carry geometry, not just time.** Each mark records `at` (ms), `name`,
  and the bounding boxes of the elements that scene is about (the search box,
  the two result rows, the transform step, the `phone` row in the diff, the
  replay response, the original-vs-replay comparison). Each click records its
  coordinates. Zoom targets and the cursor come from these boxes, so a UI
  change that moves an element does not need hand-tuned coordinates.
- Output: `OUT_DIR/capture/marks.json` plus the raw capture.
- **Capture quality spike (first task).** Playwright's `recordVideo` encodes
  at a modest bitrate, and text may smear when the edit layer zooms 2x on the
  diff. Compare (a) `recordVideo` at 1920×1080 against (b) a CDP
  `Page.startScreencast` or timed-screenshot capture at `deviceScaleFactor: 2`.
  Pick the one where the `phone` row stays sharp at 2x zoom. Record the result
  in the plan.

### 2. Edit layer (`video/`, new standalone package)

- Remotion pinned to the version Shorts Studio uses (4.0.532), TypeScript.
- **Outside the pnpm workspace** (`pnpm-workspace.yaml` lists `apps/*` and
  `packages/*` only), with its own lockfile, installed with
  `pnpm --dir video install --ignore-workspace`. Remotion's dependencies stay
  out of every CI install.
- `scenes.ts` is the single source for story order, caption text, the mark
  each scene starts on, its duration, and its crop rectangle for each format.
- Effects, all driven by `marks.json`:
  - zoom and pan onto the scene's target box, eased, never above 2.2x;
  - a drawn cursor that moves between recorded click points, with a ripple on
    each click (Playwright recordings show no cursor);
  - a highlight outline on the changed field in the diff and on the restored
    value in the comparison;
  - short cross-fades between scenes; time between marks may be sped up or
    held (freeze frame) so the pacing follows the captions, not the browser.
- **Captions:** burned in, one idea per screen, large type (at least 44 px at
  1080 tall in 16:9; scaled for square), high contrast on a solid backing.
  Reading time: at least 1 second per 3 words plus 1 second, never under 2.5
  seconds.
- **Square cut:** the same scenes and timing, with tighter crop rectangles per
  scene so the diff and the comparison fill the frame. Captions sit in a band
  that never covers the zoom target.
- Font: a locally bundled OFL-licensed typeface (match the docs site if its
  font is OFL), no network fetch at render time.
- Check Remotion's licence terms for an individual's open-source project before
  the first commit, and record the result in the plan.

### 3. Story and captions (about 60 seconds)

Draft wording. Jorge approves the final text; no em dashes anywhere.

| # | Scene | Caption | ~s |
|---|---|---|---|
| 1 | Hook card | A phone number left Salesforce. It never reached the CRM. | 4 |
| 2 | Search | Search by the account's Salesforce ID. | 4 |
| 3 | Results | Two journeys for this account. One completed, one failed. | 5 |
| 4 | Failed timeline | It failed at delivery. Was that where the phone was lost? | 5 |
| 5 | Transform diff | The transform step: what it received and what it produced. | 5 |
| 6 | Zoom on `phone` | The phone goes in with a value and comes out null. This step lost it. | 7 |
| 7 | Completed journey | For contrast: this input carried `Phone__c`, so the phone survived. | 6 |
| 8 | Replay | Replay the step's recorded input against development, where the fix runs. | 6 |
| 9 | Replay response | The fixed transform answers 200. | 3 |
| 10 | Comparison | Original against replay: null before, the phone number after. | 6 |
| 11 | End card | Wayscribe. Follow one record through every service, see what each step changed, and replay it. Self-hosted and open source: wayscribe.dev. Looking for pilot teams: pilots@wayscribe.dev | 8 |

Total about 59 seconds. Before locking scene 6, check the recorded transform
step's status in the UI: if it is shown as succeeded, the caption may add "and
reported success", which is the strongest version of the point; if not, leave
it out.

### 4. Music (`video/src/audio/`)

- Copy the Shorts Studio audio module (`~/workspace/shorts-studio/src/audio/`:
  synth, composer, mixer, notes, rng, wav, render, types; about 630 lines) and
  its tests. Add a header naming the source repository and commit. Do not
  import from Shorts Studio at build time.
- Add a `calm` mood and a `soft` palette: sine and triangle voices, slow
  attack pads, a gentle pulse, roughly 70 to 85 BPM. Drop the chiptune
  palettes from the copy if nothing uses them.
- Sound effects: one soft tick when the diff highlight lands (scene 6) and one
  when the restored value lands (scene 10). Nothing else.
- Seeded: the same seed gives the same track. The track length follows the
  composition length.
- Loudness: normalized with ffmpeg `loudnorm` to about -20 LUFS integrated,
  quiet enough to sit under a muted-first video. Fade in over the hook card and
  out over the end card.

### 5. Outputs and publishing

| Output | Destination |
|---|---|
| `wayscribe-demo.mp4` (16:9, H.264, AAC) | `site/public/videos/` (replaces current) |
| `wayscribe-demo-square.mp4` (1:1) | `site/public/videos/` (new; used for LinkedIn) |
| `wayscribe-demo-poster.png`, `wayscribe-demo-square-poster.png` | `site/public/videos/` |
| `wayscribe-demo-transcript.txt` (caption text, in order) | `site/public/videos/` |
| `demo-diff.gif` (16:9 diff scene, about 960 px wide, 10 fps) | `docs/images/demo-diff.gif` |

- Size budget: each MP4 at most 8 MB, the GIF at most 2 MB.
- Captions are burned in, so drop the `<track>` element and
  `wayscribe-demo.en.vtt` from `site/src/content/docs/index.mdx` (a caption
  track would duplicate the on-screen text). Keep the transcript link and the
  `aria-describedby` text. Update the "7 MB" download label to the real size.
- Retire the narration path once the new video merges: `scripts/demo-narrate.mjs`,
  `scripts/demo-narration.json`, the TTS helper, the `demo:narrate` script, and
  the narration section of `docs/DEMO_RECORDING.md`, which is rewritten for the
  new two-step pipeline.

## Checks before anything replaces the current video

1. Probe every output with ffprobe: resolution, duration within 55 to 65
   seconds, one H.264 video and one AAC audio stream, sizes within budget.
2. Export a still at the midpoint of every caption in both formats. Review
   each: caption fully inside the frame, not covering the zoom target, text
   readable.
3. Muted watch-through of the square cut in a phone-sized viewport (the
   in-app browser at 375 px wide).
4. Full unit suite (`pnpm test`), which includes `tests/site.test.ts` for the
   landing page, plus `video/` unit tests (synth determinism, scene timing
   rules, caption reading-time rule, crop rectangles inside the frame).
5. Grep every caption and the transcript for em dashes.
6. Jorge watches both cuts and approves before merge.

`video/` unit tests also run in CI in a small job that triggers only on
changes under `video/**`; rendering stays local.

## Risks

- **Capture sharpness.** Settled by the spike in section 1 before any edit-layer
  work.
- **Demo stack drift.** The capture depends on the demo compose stack and
  seeded data; if seeding changes, `marks.json` changes with it, which is the
  point of recording geometry.
- **Docker in agent shells.** Builds and pulls can hang on the Docker
  credential helper; use a credential-free `DOCKER_CONFIG` that keeps the CLI
  plugins.
- **Shorts Studio is mid-build.** Copy its audio module at a named commit; later
  Shorts Studio changes do not flow in automatically.
