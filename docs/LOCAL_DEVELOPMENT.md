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
git clone https://gitlab.com/jojithedev/wayscribe.git
cd wayscribe
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
| `postgres` | Wayscribe metadata and events | core |
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

Four things are worth knowing about the demo profile:

- **No manual migration step.** `demo-bootstrap` runs the migrations, registers
  the demo API key, and creates the demo database and its customer table, then
  exits. Everything after it waits for it to succeed.
- **The demo has its own `demo` database** inside the same PostgreSQL container,
  so its customer table never mixes with Wayscribe's own schema.
- **The demo API key is fixed and committed.** It is a placeholder that
  authorises writing demo events to a local stack and nothing else. Keys for
  anything real come from `pnpm key:create`, which prints each one
  exactly once.
- **The host ports are overridable.** The API publishes on `127.0.0.1:8080` and
  the interface on `127.0.0.1:3000`; set `API_PORT` or `WEB_PORT` in the shell
  when either is taken. `pnpm demo:trigger` honours `WEB_PORT` in the link it
  prints.

`demo-source` and `demo-target` are deliberately uninstrumented: they stand in
for Salesforce and HubSpot, which a team using Wayscribe does not own. The
timeline covers `demo-integration` and `demo-worker` only.

### Running the acceptance test

`pnpm test:demo` asserts the whole reference journey against a **running** stack:
the ten events and their order, the phone diff, the target's 422, the retries,
and the dead-letter state. Bring the stack up first: unlike `pnpm test` and
`pnpm test:integration`, it starts nothing itself.

### Running the browser suite

`pnpm test:e2e` drives the interface with Playwright against a **running** API
and web app, and starts nothing itself either. It reads four variables from the
shell:

| Variable | What it must be |
|---|---|
| `ADMIN_TOKEN` | the token the web app and the API run with; the specs sign in with it and call the admin API |
| `WAYSCRIBE_API_KEY` | an unrevoked key for an environment named `development`; the specs seed their journeys through it |
| `API_URL` | the API as this shell reaches it; default `http://localhost:8080` |
| `WEB_URL` | the interface; default `http://localhost:3000` |

The specs seed their own journeys, so the database needs no fixture. When it has
more than one project, each spec chooses the project its key wrote to in the
picker after signing in. Against the demo stack on its default ports and
secrets, the demo's own key works:

```bash
ADMIN_TOKEN=replace-for-local-development-0000 \
  WAYSCRIBE_API_KEY=wsk_demo0000000000000000000000000000 pnpm test:e2e
```

With your own `.env`, use its `ADMIN_TOKEN`, and set `API_URL` and `WEB_URL`
when `API_PORT` or `WEB_PORT` moved the stack. A key from
`pnpm key:create <project> development e2e` works as well as the demo's. The
first run needs the browser: `pnpm exec playwright install chromium`.

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

**Rotating `ENCRYPTION_KEY` is a procedure, not an edit.** Stored identifiers,
search tokens, and API key verifiers all derive from it, so replacing the value
alone makes existing data unreadable and every issued key fail. Set the new key
as `ENCRYPTION_KEY` and the old one as `ENCRYPTION_KEY_PREVIOUS` in `.env`, then
follow [Operations §6](OPERATIONS.md#6-key-rotation). The Compose stack reads
both from `.env` and ignores shell exports, and picks up a change only when its
containers are recreated with `up -d`, not on `restart`.

### SDK configuration is explicit, not environmental

The SDK reads no environment variables. `createRecorder` takes its endpoint and
key as arguments:

```typescript
const recorder = createRecorder({
  endpoint: process.env.WAYSCRIBE_URL ?? "http://localhost:8080",
  apiKey: process.env.WAYSCRIBE_API_KEY ?? "",
  serviceName: "checkout-api",
  environment: "development"
});
```

When `WAYSCRIBE_API_KEY` is unset, `?? ""` hands the SDK an empty key.
The SDK treats an empty or blank required setting as missing: it prints one
`configuration_error` line per process, even with `logDiagnostics` off, and the
server refuses the events
([Troubleshooting](TROUBLESHOOTING.md#3-did-the-sdk-reach-the-api)).

Naming the variables in your own application is a convention this repository
suggests, not one the SDK enforces: a library that reads `process.env` behind
your back is a library that behaves differently in tests.

## 6. Commands

| Command | |
|---|---|
| `pnpm build` | compile every package |
| `pnpm lint` · `pnpm format:check` · `pnpm typecheck` | the three verify gates; `pnpm format` rewrites what `format:check` refuses |
| `pnpm test` | unit; starts nothing, needs nothing running |
| `pnpm test:integration` | real PostgreSQL via Testcontainers; needs Docker |
| `pnpm test:e2e` | Playwright browser suite; needs the API and web running, and `ADMIN_TOKEN` and `WAYSCRIBE_API_KEY` set (§3, Running the browser suite) |
| `pnpm test:demo` | the product acceptance test; needs the demo stack up |
| `pnpm db:migrate` · `pnpm db:rollback` · `pnpm db:seed` | schema and local seed |
| `pnpm db:reset --yes` | roll the schema back to nothing, migrate, and seed; drops every recorded journey (§8) |
| `pnpm db:migrate:unlock` | release a migration lock a killed `migrate` left behind; only when no migrate is running |
| `pnpm key:create <project> <environment> [name]` | issue an API key |
| `pnpm key:revoke <prefix>` | revoke one; `key:list` shows prefixes |
| `pnpm key:list [project]` | scope, name, and last use |
| `pnpm rotate:reencrypt` | move stored data onto `ENCRYPTION_KEY` from `ENCRYPTION_KEY_PREVIOUS`; without a previous key, upgrade legacy values into the current format |
| `pnpm rotate:status` | what is still under another key; exits 0 when nothing is |
| `pnpm delete:journey <project> <journey-id>` | delete one journey |
| `pnpm delete:identifier <project> <value> [--environment <name>] [--dry-run]` | delete every journey matching an identifier; dry run first |
| `pnpm delete:range <project> <environment> --before <date> [--after <date>] [--dry-run]` | delete an environment's journeys by last activity |
| `pnpm delete:destination <project> <destination-id>` | delete a replay destination and its runs |
| `pnpm demo:trigger` | fire the reference journey |

## 7. Projects, environments, and keys

`pnpm db:seed` creates a `local` project with a `development` environment and
prints one API key. **The key is shown once and cannot be recovered**: only a
peppered HMAC of it is stored.

Issue further keys with `key:create`, which creates the environment if it does
not exist yet:

```bash
pnpm key:create local staging staging-worker
```

A key is scoped to one project *and one environment*. Ingestion refuses an event
whose `environment` does not match the key's with `unauthorized_environment`,
so a service that writes to both needs two keys. On `POST /v1/events/batch`,
which the SDK uses, the request is answered 202 and the refusal, with
`httpStatus: 403`, is in that event's result; only `POST /v1/events` answers
the request itself 403.

Revocation takes the prefix rather than the key, because the full value is not
stored and whoever is revoking it usually does not have it:

```bash
pnpm key:list
pnpm key:revoke wsk_AbCdEfGh
```

### Provisioning without a source checkout

The database CLI is inside the API image, so an operator running from published
images does not need this repository:

```bash
docker run --rm --network wayscribe_default \
  -e DATABASE_URL=postgresql://wayscribe:wayscribe@postgres:5432/wayscribe \
  -e ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  --entrypoint node wayscribe-api packages/database/dist/cli.js migrate
```

## 8. Resetting local state

`pnpm db:reset --yes` empties the database `DATABASE_URL` names and rebuilds
it: it rolls back every migration, which drops every table and every recorded
journey, then migrates and runs the local seed, which prints a new API key. The
container and its volume stay.

```bash
pnpm db:reset --yes
```

Without `--yes` it changes nothing and says which server it would have
wiped: nothing in `DATABASE_URL` says whether a database is a local one, so the
flag is how you say so. It also checks `ENCRYPTION_KEY` before dropping
anything, and it refuses under `NODE_ENV=production` even with the flag, which
is what the published API image sets, so the copy of this CLI inside that image
cannot reset an installation.

To start over from an empty volume instead, `down -v` removes it, so this
also discards every recorded event.

```bash
docker compose -f infrastructure/compose.yaml down -v
docker compose -f infrastructure/compose.yaml up -d --build
pnpm db:migrate
pnpm db:seed
```

The demo profile needs none of this: `demo-bootstrap` migrates and seeds itself
on every start.

### Upgrading a checkout from before the rename

The rename to Wayscribe (ADR-057) changed the Compose project, and with it the
volume, and the database user, password and name, which are now all
`wayscribe`. A stack started before the rename is not picked up: its volume
belongs to the old project and its database has the old user. Start fresh.

If you no longer need its data, remove the old stack and its volume. This
removes every container of the old project, the demo profile's included, so
none keeps running or holding a port:

```bash
docker compose -p flight-recorder -f infrastructure/compose.yaml down -v --remove-orphans
```

Then copy `.env.example` to `.env` again, or change `DATABASE_URL` in your
`.env` to the new user and name, and follow the setup in §2.

## 9. Troubleshooting principles

### API is healthy but not ready

Check PostgreSQL connectivity and migration state.

### SDK emits no events

[Troubleshooting](TROUBLESHOOTING.md#no-journeys-appear) walks through this one
question at a time. In short, check:

- endpoint
- API key
- environment match
- the lines `logDiagnostics: true` prints
- `counters()`, including `breakerOpened`
- local network route from container or host

### Search finds no alias

Check:

- normalization rules
- HMAC key consistency: `pnpm rotate:status` shows whether rows are under a key that is not configured, which happens when `ENCRYPTION_KEY_PREVIOUS` is removed before a rotation finishes
- project and environment scope

Alias search is deliberately independent of alias *type* (ADR-028): a developer
typing an identifier into a search box does not know which type it was stored
under.

### Every search returns nothing at all

Check which project the session is reading. An admin token reads one named
project, and with more than one project present the interface asks you to choose
before it will search. `/projects` is that page.

### Replay cannot reach host application

When Wayscribe runs in Docker and the destination runs on the host, use the supported host gateway name for the operating system, commonly `host.docker.internal`.

`infrastructure/compose.yaml` allows it. `compose.published.yaml` and the Helm chart do not, because it reaches every service on the Docker host: add it to `REPLAY_ALLOWED_HOSTS` yourself, on a machine where that is acceptable (`OPERATIONS.md` §9).

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

The time to a first journey was measured on 2026-09-14 from a fresh clone on a
laptop with no Docker layer cache: the demo stack built in 38 seconds, booted in
12, and showed the reference journey within a minute of the clone (the README's
*Try it*).
