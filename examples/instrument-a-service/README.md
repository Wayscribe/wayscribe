# Instrument a service

The smallest real thing: one service, one record, one journey you can search for.

This is a standalone project. It does not use the workspace, so it shows exactly
what your own application would do.

## What it does

It handles a pretend account webhook, transforms it, "saves" it, and sends it on
— recording each step. The transformation drops the phone number, which is the
point: you will find the step where a value disappeared.

## Run it

Start Flight Recorder from the repository root:

```bash
docker compose -f infrastructure/compose.yaml up --build -d
```

Issue an API key:

```bash
pnpm key:create local development my-service
```

If `local` does not exist yet, run `pnpm db:seed` once to create it.

Then, from this directory:

```bash
npm install
```

```bash
FLIGHT_RECORDER_API_KEY=fr_the_key_you_just_issued node index.mjs
```

It prints a link. Open it, sign in with your `ADMIN_TOKEN`, and read the
timeline.

## Installing from npm instead

This example installs the SDK from the repository so it works before the package
is published. In your own project:

```bash
npm install @flight-recorder/node
```
