# Recording the demo walkthrough

The recorder drives the real demo workflow: it seeds missing journeys through
the source webhook, signs in outside the recorded browser context, opens the
recorded transformation diff and sends that step's stored input to an approved
development replay destination. It does not change the replay allowlist.

Start the demo stack, then record the silent, captioned walkthrough:

```bash
docker compose -f infrastructure/compose.yaml \
  -f infrastructure/compose.demo.yaml up --build -d
pnpm demo:video
```

`pnpm demo:video --narrate` also renders and mixes the optional local Kokoro
narration described in `scripts/demo-narrate.mjs`. Narration models and videos
stay outside the repository.

The recorder reads `WEB_URL`, `API_URL`, `DEMO_SOURCE_URL`, `ADMIN_TOKEN`,
`ENTITY_ID`, `PROJECT_NAME`, `FFMPEG`, `FFPROBE`, `KOKORO_DIR` and `OUT_DIR`.
Replay defaults to `http://demo-integration:3200`, the Compose service address.
Set `DEMO_REPLAY_URL` only when the recorder runs in another network topology,
for example `DEMO_REPLAY_URL=http://127.0.0.1:3200` when the demo integration
service is published on that host port. The configured URL must still satisfy
the API's development replay policy and allowlist.

The recorder reuses only an enabled recorder destination for the exact URL. It
uses a readable, non-secret URL-specific name when it creates one and leaves
unrelated destinations unchanged. If an exact recorder destination is disabled,
the recording stops with an instruction to enable it explicitly or choose a
different URL; the recorder never re-enables or replaces it.

`OUT_DIR` receives the silent and narrated MP4 files, the README-sized GIF,
caption stills, caption timing and raw recording. Review every still and probe
all media streams before copying the GIF to `docs/images/demo-diff.gif`.
