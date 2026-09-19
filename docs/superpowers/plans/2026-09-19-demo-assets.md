# Demo asset completion plan

**Goal:** Deliver reproducible, verified demo video/GIF/social assets from the current implementation.
**Spec:** `docs/superpowers/specs/2026-09-19-demo-assets-design.md`

## Global Constraints

- Preserve actual source-webhook seeding, recorded payloads, authentication isolation and development replay allowlists.
- Keep the existing Compose replay URL as default; the host override is explicit.
- Captions and narration must be supported by visible results from the current production UI.
- No product runtime dependencies, production UI changes, new brand design or public publication.
- Preserve the existing static screenshots and pre-existing demo commits. Videos remain outside git.
- No subagents; the controller owns services, independent review and integration.

## Task 1: Finish and verify the existing demo assets

**Files:** existing `scripts/demo-video.mjs`, narration scripts/config only if necessary, README, `docs/images/demo-diff.gif`, `site/public/og.png`, and a concise demo recording guide/evidence record.

- [ ] Read repository instructions and the handoff `/Users/jorgepolanco/workspace/wayscribe-release-evidence/2026-09-18/demo-preparation.md` for exact services, wrapper, outputs and constraints. Existing source commits 34109c4 and 9e45c7c are merged with reviewed c8ed426 in this branch; preserve them.
- [ ] Add a documented `DEMO_REPLAY_URL` override to the recorder, preserving `http://demo-integration:3200` as default. Do not change the application replay policy. Resolve the observed timeline framing/caption mismatch against actual page semantics; no unrelated redesign.
- [ ] Run the tracked recorder with narration through the controller wrapper using Node 24. Existing probe files are evidence, not a substitute for running the final tracked script. Wrapper: `node /tmp/wayscribe-timing-demo-run.mjs node scripts/demo-video.mjs --narrate`. It supplies private environment; never print its JSON contents, tokens or browser cookies. Capture output to a private log and redact credentials before reporting failures.
- [ ] Inspect every caption still and validate MP4/GIF streams, dimensions, duration, captions and narration timeline. Preserve actual MP4, GIF, stills and provenance under the external demo evidence directory. Record any limitation accurately; do not claim human audio audition from waveform metadata.
- [ ] Add the verified modest GIF to `docs/images/demo-diff.gif` with a README link near the static image, retaining the static screenshot. Copy the controller's verified `wayscribe-social-preview.png` to `site/public/og.png` and verify the built site includes it. Keep MP4/raw recordings/models/private logs outside git. Document reproduction and output paths without credentials.
- [ ] Run changed-code lint/format/syntax checks and relevant existing docs checks; build the site. No redundant full suites or prose-mirroring tests. Self-review, commit exact intended files with truthful Codex coauthor, write the report with exact checks, asset provenance and limitations. Controller reviews all demo branch changes against c8ed426 before integration.
