# Instrument a service

The smallest real thing: one service, one record, one journey you can search for.

This is a standalone project. It does not use the workspace, so it shows exactly
what your own application would do.

## What it does

It handles a pretend account webhook, transforms it, "saves" it, and sends it on
— recording each step. The transformation drops the phone number, which is the
point: you will find the step where a value disappeared.

## Run it

You need Node 24, pnpm (`corepack enable`), and Docker. Everything below until
the last three commands runs from the repository root.

The SDK is not published to npm yet, so this example installs it from
`packages/sdk-node`, which has to be built first:

```bash
pnpm install
pnpm --filter @flight-recorder/node build
```

Start Flight Recorder and apply its migrations. The `pnpm` commands read the
repository-root `.env`, so create it if you have not; its keys match the ones
the stack uses by default.

```bash
[ -f .env ] || cp .env.example .env
docker compose -f infrastructure/compose.yaml up --build -d
pnpm db:migrate
```

Create a project and issue it an API key. The key is printed once:

```bash
pnpm project:create local "Local"
pnpm key:create local development my-service
```

Then install the example, from its own directory:

```bash
cd examples/instrument-a-service
npm install
```

```bash
FLIGHT_RECORDER_API_KEY=fr_the_key_you_just_issued node index.mjs
```

It prints a link. Open it, sign in with your `ADMIN_TOKEN`, and read the
timeline.

If you moved the stack's ports (`API_PORT=8081 WEB_PORT=3001 docker compose …`),
tell the example where they went, or it sends to `localhost:8080` and prints a
link to `localhost:3000`:

```bash
FLIGHT_RECORDER_URL=http://localhost:8081 FLIGHT_RECORDER_WEB=http://localhost:3001 \
  FLIGHT_RECORDER_API_KEY=fr_the_key_you_just_issued node index.mjs
```

## Installing from npm instead

This example installs the SDK from the repository so it works before the package
is published. Once it is, in your own project:

```bash
npm install @flight-recorder/node
```
