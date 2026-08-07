# Local Development

## 1. Prerequisites

The default local setup is intentionally lightweight and requires no hosted account or paid service.

Planned local prerequisites:

- Git
- Docker with Docker Compose
- Node.js active LTS
- pnpm

Pin exact Node.js and pnpm versions in the repository before implementation begins.

## 2. Intended setup

The released quick start should provide one primary Compose command that starts the required platform services. Repository contributors may still run applications directly for hot reload.

```bash
git clone <repository-url>
cd flight-recorder
pnpm install
docker compose -f infrastructure/compose.yaml up -d
```

These commands are targets for the implementation. Update this file when actual commands exist.

## 3. Planned services

| Service | Planned purpose |
|---|---|
| `postgres` | Flight Recorder metadata and events |
| `api` | Ingestion, query, and replay API |
| `web` | Developer interface |
| `demo-source` | Source webhook simulator |
| `demo-integration` | Integration API |
| `demo-worker` | Queue consumer |
| `demo-target` | Target API simulator |

## 4. Planned local URLs

Choose final ports during Phase 0. Suggested starting values:

```text
Web: http://localhost:3000
API: http://localhost:8080
Demo source: http://localhost:3100
Demo integration: http://localhost:3200
Demo target: http://localhost:3300
PostgreSQL: localhost:5432
```

## 5. Environment variables

Initial server variables:

```env
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight
APP_URL=http://localhost:3000
API_URL=http://localhost:8080
ENCRYPTION_KEY=replace-for-local-development
DEFAULT_RETENTION_DAYS=7
MAX_EVENT_PAYLOAD_BYTES=262144
ALLOW_FULL_PAYLOAD_CAPTURE=true
REPLAY_ALLOWED_HOSTS=localhost,host.docker.internal,demo-integration
```

Initial SDK variables:

```env
FLIGHT_RECORDER_URL=http://localhost:8080
FLIGHT_RECORDER_API_KEY=generated-local-key
FLIGHT_RECORDER_CAPTURE_MODE=redacted-payload
FLIGHT_RECORDER_BATCH_SIZE=20
FLIGHT_RECORDER_FLUSH_INTERVAL_MS=1000
FLIGHT_RECORDER_REQUEST_TIMEOUT_MS=1500
```

Never commit real secrets.

## 6. Planned commands

```text
pnpm dev
pnpm build
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm db:migrate
pnpm db:rollback
pnpm db:seed
pnpm demo:trigger
```

## 7. Development data

Provide a deterministic local project, environment, and API key seed.

The full key may be printed only in local seed output and must not be persisted in plaintext.

## 8. Resetting local state

Planned:

```bash
docker compose -f infrastructure/compose.yaml down -v
docker compose -f infrastructure/compose.yaml up -d
pnpm db:migrate
pnpm db:seed
```

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
- alias type
- HMAC key consistency
- project and environment scope

### Replay cannot reach host application

When Flight Recorder runs in Docker and the destination runs on the host, use the supported host gateway name for the operating system, commonly `host.docker.internal`.

### Payload is unexpectedly redacted

Server capture policy may be stricter than SDK configuration. Server policy wins.

## 10. Before first implementation commit

- [ ] Choose exact Node.js version.
- [ ] Choose exact pnpm version.
- [ ] Choose an established open-source license.
- [ ] Confirm the complete self-hosted core is free to use.
- [ ] Validate the approximately 15-minute time-to-first-journey target.
- [ ] Create repository.
- [ ] Add root package manifest.
- [ ] Add workspace file.
- [ ] Add TypeScript base configuration.
- [ ] Add Compose file.
- [ ] Add CI.
