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
