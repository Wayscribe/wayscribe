# Local Development

## 1. Prerequisites

The setup is intentionally lightweight and requires no hosted account or paid service.

- Git
- Docker with Docker Compose
- Node.js 24 (see `.nvmrc`)
- pnpm 11, via corepack

## 2. Setup

One Compose command starts the platform services. Contributors may still run
applications directly for hot reload.

```bash
git clone https://gitlab.com/jojithedev/flight-recorder.git
cd flight-recorder
nvm use            # Node 24, per .nvmrc
corepack enable
pnpm install
cp .env.example .env
docker compose -f infrastructure/compose.yaml up -d --build
pnpm db:migrate
```

`/ready` returns 503 with `migrations_pending` until `pnpm db:migrate` runs. That is
the intended answer, not a fault: a process serving against a schema older than its
build expects must not take traffic.

## 3. Services

| Service | Purpose | Profile |
|---|---|---|
| `postgres` | Flight Recorder metadata and events | core |
| `api` | Ingestion, query, and replay API | core |
| `web` | Developer interface | core |
| `elasticmq` | SQS-compatible queue | demo |
| `demo-bootstrap` | One-shot setup; runs and exits | demo |
| `demo-source` | Source webhook simulator | demo |
| `demo-integration` | Integration API | demo |
| `demo-worker` | Queue consumer | demo |
| `demo-target` | Target API simulator | demo |

### Running the demo

```bash
docker compose -f infrastructure/compose.yaml \
               -f infrastructure/compose.demo.yaml up --build
```

```bash
pnpm demo:trigger
```

The trigger prints a direct link to the journey. It takes about ten seconds to
finish, because the queue's retries are real; only the waiting is compressed.

Three things are worth knowing about the demo profile:

- **No manual migration step.** `demo-bootstrap` runs the migrations, registers
  the demo API key, and creates the demo database and its customer table, then
  exits. Everything after it waits for it to succeed.
- **The demo has its own `demo` database** inside the same PostgreSQL container,
  so its customer table never mixes with Flight Recorder's own schema.
- **The demo API key is fixed and committed.** It is a placeholder that
  authorises writing demo events to a local stack and nothing else. Keys for
  anything real come from `pnpm key:create`, which prints each one
  exactly once.
- **The host ports are overridable.** The API publishes on `127.0.0.1:8080` and
  the interface on `127.0.0.1:3000`; set `API_PORT` or `WEB_PORT` in the shell
  when either is taken. `pnpm demo:trigger` honours `WEB_PORT` in the link it
  prints.

`demo-source` and `demo-target` are deliberately uninstrumented: they stand in
for Salesforce and HubSpot, which a team using Flight Recorder does not own. The
timeline covers `demo-integration` and `demo-worker` only.

### Running the acceptance test

`pnpm test:demo` asserts the whole reference journey against a **running** stack:
the ten events and their order, the phone diff, the target's 422, the retries,
and the dead-letter state. Bring the stack up first — unlike `pnpm test` and
`pnpm test:integration`, it starts nothing itself.

## 4. Local URLs

```text
Web: http://localhost:3000
API: http://localhost:8080
Demo source: http://localhost:3100
Demo integration: http://localhost:3200
Demo target: http://localhost:3300
PostgreSQL: localhost:5432
ElasticMQ: localhost:9324
```

Every one binds to `127.0.0.1` rather than to all interfaces, so a `docker
compose up` on a cloud host does not expose the stack to the internet.

## 5. Environment variables

Copy the template and generate your own secrets:

```bash
cp .env.example .env
```

```bash
printf 'ENCRYPTION_KEY=%s\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

`.env.example` is the authoritative list; it is not reproduced here, because two
copies of the same list drift and the copy in the documentation is the one that
goes stale.

**`ENCRYPTION_KEY` and `ADMIN_TOKEN` must each be at least 32 characters.** The
API validates them before it does anything else, so a short value fails at boot
with a message naming the variable.

The repository ships development defaults so `docker compose up` works with
nothing configured. They are published values, and the API logs a warning at
every boot while they are in use.

**Rotating `ENCRYPTION_KEY` is not a routine operation.** Search tokens and API
key verifiers are both derived from it, so rotating it orphans every existing
alias index and invalidates every issued key.

### SDK configuration is explicit, not environmental

The SDK reads no environment variables. `createRecorder` takes its endpoint and
key as arguments:

```typescript
const recorder = createRecorder({
  endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
  apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
  serviceName: "checkout-api",
  environment: "development"
});
```

Naming the variables in your own application is a convention this repository
suggests, not one the SDK enforces — a library that reads `process.env` behind
your back is a library that behaves differently in tests.

## 6. Commands

| Command | |
|---|---|
| `pnpm build` | compile every package |
| `pnpm lint` · `pnpm format` · `pnpm typecheck` | the three verify gates |
| `pnpm test` | unit; starts nothing, needs nothing running |
| `pnpm test:integration` | real PostgreSQL via Testcontainers; needs Docker |
| `pnpm test:e2e` | Playwright browser suite; needs the API and web running |
| `pnpm test:demo` | the product acceptance test; needs the demo stack up |
| `pnpm db:migrate` · `pnpm db:rollback` · `pnpm db:seed` | schema and local seed |
| `pnpm key:create <project> <environment> [name]` | issue an API key |
| `pnpm key:revoke <prefix>` | revoke one; `key:list` shows prefixes |
| `pnpm key:list [project]` | scope, name, and last use |
| `pnpm demo:trigger` | fire the reference journey |

## 7. Projects, environments, and keys

`pnpm db:seed` creates a `local` project with a `development` environment and
prints one API key. **The key is shown once and cannot be recovered** — only a
peppered HMAC of it is stored.

Issue further keys with `key:create`, which creates the environment if it does
not exist yet:

```bash
pnpm key:create local staging staging-worker
```

A key is scoped to one project *and one environment*. Ingestion returns 403 when
the event's `environment` does not match the key's, so a service that writes to
both needs two keys.

Revocation takes the prefix rather than the key, because the full value is not
stored and whoever is revoking it usually does not have it:

```bash
pnpm key:list
pnpm key:revoke fr_AbCdEfGhIjK
```

### Provisioning without a source checkout

The database CLI is inside the API image, so an operator running from published
images does not need this repository:

```bash
docker run --rm --network flight-recorder_default \
  -e DATABASE_URL=postgresql://flight:flight@postgres:5432/flight \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  --entrypoint node flight-recorder-api packages/database/dist/cli.js migrate
```

## 8. Resetting local state

`down -v` removes the volume, so this discards every recorded event.

```bash
docker compose -f infrastructure/compose.yaml down -v
docker compose -f infrastructure/compose.yaml up -d --build
pnpm db:migrate
pnpm db:seed
```

The demo profile needs none of this: `demo-bootstrap` migrates and seeds itself
on every start.

## 9. Troubleshooting principles

### API is healthy but not ready

Check PostgreSQL connectivity and migration state.

### SDK emits no events

Check:

- endpoint
- API key
- environment match
- debug logs
- circuit breaker state
- local network route from container or host

### Search finds no alias

Check:

- normalization rules
- HMAC key consistency — rotating `ENCRYPTION_KEY` orphans every existing token
- project and environment scope

Alias search is deliberately independent of alias *type* (ADR-028): a developer
typing an identifier into a search box does not know which type it was stored
under.

### Every search returns nothing at all

Check which project the session is reading. An admin token reads one named
project, and with more than one project present the interface asks you to choose
before it will search. `/projects` is that page.

### Replay cannot reach host application

When Flight Recorder runs in Docker and the destination runs on the host, use the supported host gateway name for the operating system, commonly `host.docker.internal`.

### Payload is unexpectedly redacted

Server capture policy may be stricter than SDK configuration. Server policy wins.

## 10. Resolved before implementation

| Decision | Outcome | Record |
|---|---|---|
| Node.js version | 24.x active LTS | ADR-017 |
| pnpm version | 11.x via corepack | ADR-017 |
| License | Apache-2.0 | ADR-014 |
| Free self-hosted core | Confirmed | ADR-011, ADR-014 |
| Queue technology | ElasticMQ, demo profile only | ADR-015 |
| Web interface authentication | Single admin token | ADR-016 |
| Migration file format | Plain ESM JavaScript | ADR-027 |

The time-to-first-journey target is measured in Epic 12, once the demo workflow makes
it a real number. Phase 0 verifies only that the documented Compose command brings up
the stack on a clean machine.
