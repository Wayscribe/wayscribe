# Phase 0: Repository Foundation — Design

**Date:** 2026-08-06
**Status:** Approved
**Scope:** Phase 0 of the V0 implementation plan, plus the architecture decisions and
document corrections that Phase 0 is blocked on.

## 1. Context

The Flight Recorder planning documents describe a complete V0 but leave several
decisions explicitly open, and contain a small number of contradictions between
documents. `AGENTS.md` requires that contradictions be resolved through decision
records rather than silently, so those resolutions are part of this phase.

V0 as specified is eight phases, fifteen epics, and roughly 290 checklist items —
too large for a single design. This document covers Phase 0 only. Each later phase
gets its own design and plan, informed by what the previous phase actually taught us.

### Product context

Flight Recorder is intended as a published open-source product where adoption is the
measure of success. That framing drives several decisions below: the license is
permissive to keep the SDK embeddable, onboarding cost is treated as a real
constraint, and the default installation must not acquire new required services.

## 2. Decisions

These become ADR-014 through ADR-026 in `docs/DECISIONS.md`.

### ADR-014: Apache-2.0 for all packages

The repository is licensed Apache-2.0, with a `NOTICE` file.

The SDK is embedded directly into other organizations' applications, which makes a
copyleft license an adoption barrier for exactly the users the product targets. A
split license (copyleft server, permissive SDK) was considered and rejected: it
preserves commercial optionality but adds contributor friction, and the stated goal
is adoption rather than a commercial wedge.

Relicensing later requires consent from every contributor, so this is treated as a
one-way door and decided now.

### ADR-015: ElasticMQ for the demo queue; core stack stays PostgreSQL-only

The demo Compose profile provides ElasticMQ, an SQS-compatible server distributed as
a roughly 40 MB native image. The core `compose.yaml` continues to require only
PostgreSQL, preserving ADR-012.

The SDK's queue helpers are written against the SQS message-attribute contract, so
code that works against ElasticMQ works unchanged against AWS SQS.

Alternatives rejected:

- A PostgreSQL-backed queue using `FOR UPDATE SKIP LOCKED` adds no services, but
  leaves Epic 11's SQS attribute injection and extraction with nothing real to test
  against, and makes the demo stop resembling the target user's actual stack.
- LocalStack is more faithful, including dead-letter redrive semantics, but is a
  roughly 1 GB image sitting in the path of the onboarding target.
- An in-process fake queue never proves propagation across a real process boundary,
  which is the entire point of Phase 4.

### ADR-016: Web UI authentication is a single admin token

The web interface authenticates against a single admin token supplied by environment
variable, exchanged for a session cookie. The local seed generates and prints one.
Compose binds published ports to `127.0.0.1` by default.

The interface displays captured customer PII — names, phone numbers, email addresses.
Shipping a published, self-hostable tool with no authentication means some operators
will expose it on a public host. The onboarding cost is roughly one environment
variable.

Local user accounts were rejected as scope that V1's OIDC support will replace.
Reusing the project API key was rejected because those keys are scoped for SDK
ingestion, and a browser session should not carry write access to the ingestion
endpoint.

**Implementation timing:** this decision is recorded in Phase 0, and the environment
variable is defined in `packages/config`. The token exchange and session handling land
in Phase 2, alongside the first interface that displays real data.

### ADR-017: Node.js 24.x and pnpm 10.x, pinned

Node.js 24.x is the current active LTS; Node.js 20 reached end of life in April 2026.
Pinned through `.nvmrc` and the `engines` field, with pnpm pinned through
`packageManager`.

### ADR-018: Capture-mode names use the protocol form

The canonical values are `metadata-only`, `allowlisted-fields`, `redacted-payload`,
and `full-payload`, used in the protocol, the SDK configuration surface, the API, and
the `environments.capture_mode` check constraint.

`DATABASE_SCHEMA.md` previously used the shorter forms `metadata`, `allowlist`,
`redacted`, and `full`. The source-of-truth order in `AGENTS.md` ranks event and API
contracts above the database schema, and these strings already appear in the public
SDK configuration, so the wire form is authoritative.

### ADR-019: Replay destinations store an origin and base path

A replay destination stores `base_url`: scheme, host, port, and an optional base path.
A replay request supplies a relative `path`, which is appended to the base. Requests
must reject path traversal (`..`), absolute URLs, and protocol-relative URLs.

`API_SPEC.md` previously showed a destination created with a full URL including a
path, which conflicts with the `base_url` column in `DATABASE_SCHEMA.md` and the
separate `path` field in `CreateReplayRequest`.

SSRF validation needs a fixed, pre-approved origin established at destination-creation
time. Validating a complete per-request URL against a host allowlist is the pattern
that repeatedly produces bypasses through redirects, userinfo segments, and
DNS rebinding.

### ADR-020: Composite primary keys on journeys and events

`journeys` and `journey_events` use `(project_id, id)` as the primary key.
`entity_aliases` references journeys through a composite foreign key
`(project_id, journey_id)`.

The schema already requires `unique (project_id, id)` for idempotency, so a separate
surrogate primary key is an additional index that buys nothing. A composite key also
makes an accidental cross-project join structurally impossible, which is the property
`SECURITY.md` section 8 requires tests for.

Trade-off: composite foreign keys are more verbose to express in Knex.

### ADR-021: Conflicting duplicate event IDs are rejected

Each event row stores a `content_hash` computed from a canonical serialization of the
event. If an event arrives whose `(project_id, id)` already exists and whose content
hash differs, the API returns `409` with code `event_id_conflict`. In a batch, that
event is reported as `rejected` with the same code while other events proceed.

Identical resubmissions remain idempotent and return `duplicate: true`, unchanged.

`TESTING_STRATEGY.md` section 5 recommends this behavior. The alternative —
first-write-wins — means an SDK defect that reuses event IDs silently discards
evidence, which contradicts the append-only guarantee.

Cost: this introduces a canonical JSON serialization requirement (sorted keys,
stable number formatting) that the system would not otherwise need.

### ADR-022: Failed delivery uses the attempt's own operation

A failed delivery attempt emits `delivered` — or `retried` for subsequent attempts —
with `error` populated and the HTTP status in `metadata`. The `failed` operation is
reserved for terminal journey or branch failure, such as a message moving to a
dead-letter queue.

`EVENT_PROTOCOL.md` section 5 required this choice to be consistent without making it.
This reading matches the expected timeline in `DEMO_SCENARIO.md` section 6, and keeps
duration, input, and output attached to the same event rather than splitting an
attempt across two events.

### ADR-023: `identify()` emits a dedicated event

`identified` is added to the `JourneyOperation` enum, and `journey.identify()` emits a
dedicated event carrying the new aliases.

Adding an operation is a compatible protocol change under `EVENT_PROTOCOL.md`
section 11. Attaching aliases to the next event instead would lose them entirely if
the process terminates before that event is recorded, and identity mapping is a named
differentiation requirement under ADR-013.

The `aliases` field remains available on every event for callers that prefer to
attach identity inline.

### ADR-024: Payload diffs are computed at ingestion and stored

The structural diff is computed during ingestion and written to
`journey_events.payload_diff`.

The column already exists, events are immutable so a stored diff can never go stale,
and the timeline performance target — p95 under 500 ms for journeys of up to 500
events — cannot absorb per-request diffing of large payloads.

Cost: a change to the diff algorithm requires a backfill migration.

### ADR-025: Array diffs compare by index

Arrays are compared element-wise by index, with length differences reported as added
or removed entries. V0 performs no longest-common-subsequence matching and no move
detection, so a reordered array is reported as broadly changed. This limitation is
documented in the user-facing diff documentation.

Subsequence matching is O(n·m) against a specification that requires explicit
complexity limits on diffing.

### ADR-026: Retention cleanup runs in the API process

Retention runs on an interval inside the API process, guarded by
`pg_try_advisory_lock` so that multiple API replicas do not delete concurrently, and
deletes in bounded batches.

This adds no container, preserving ADR-012. The advisory lock is a few lines of code
compared with operating a separate scheduler service.

## 3. Document corrections

Applied to the imported documents in the same change as the decision records:

1. `docs/DATABASE_SCHEMA.md` — capture-mode values updated to the protocol form
   (ADR-018).
2. `docs/API_SPEC.md` — the replay-destination example uses `baseUrl` with an origin
   rather than a full URL, and points at port 3200 (demo-integration) rather than
   3000, which `LOCAL_DEVELOPMENT.md` assigns to the web application (ADR-019).
3. `docs/DATABASE_SCHEMA.md` — primary and foreign key definitions made explicit
   (ADR-020), and a `content_hash` column added to `journey_events` (ADR-021).
4. `docs/EVENT_PROTOCOL.md` — `identified` added to the operation enum (ADR-023),
   and the failed-delivery semantics resolved (ADR-022).
5. `README.md` and `docs/IMPLEMENTATION_PLAN.md` — `apps/demo-worker` added to the
   repository layout. It is required by `docs/DEMO_SCENARIO.md` section 2 and
   `docs/LOCAL_DEVELOPMENT.md` section 3 but absent from both layout diagrams.
6. `docs/TASKS.md` — the time-to-first-journey measurement moves from Epic 0 to
   Epic 12, per section 6 below.

## 4. Repository structure

```text
flight-recorder/
├── apps/
│   ├── api/                  Fastify: /health, /ready, config boot
│   └── web/                  Next.js: application shell
├── packages/
│   ├── config/               Zod-parsed environment configuration
│   ├── database/             Knex configuration, migrate/rollback/seed
│   ├── protocol/             scaffold — implemented in Phase 1
│   ├── sdk-node/             scaffold — implemented in Phase 3
│   ├── payload-security/     scaffold — implemented in Phase 1
│   └── payload-diff/         scaffold — implemented in Phase 2
├── infrastructure/
│   ├── compose.yaml          postgres, api, web
│   └── compose.demo.yaml     elasticmq and demo services — filled in Phase 5
├── docs/
├── .gitlab/
│   ├── issue_templates/
│   └── merge_request_templates/
├── .gitlab-ci.yml
├── .nvmrc
├── AGENTS.md
├── CONTRIBUTING.md
├── LICENSE
├── NOTICE
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

`config` and `database` are fully implemented in this phase. The four scaffold
packages receive a real `package.json`, `tsconfig.json`, and `src/index.ts` with no
implementation — enough that the workspace dependency graph and type checking are
genuinely exercised without implying the packages are complete.

The tree above is what Phase 0 creates on disk. It deliberately omits the four demo
applications, which are built in Phase 5. Correction 5 in section 3 adds
`apps/demo-worker` to the layout diagrams inside `README.md` and
`docs/IMPLEMENTATION_PLAN.md`, which describe the eventual V0 repository rather than
Phase 0's output.

## 5. Components

### `packages/config`

Parses environment variables through Zod at process start and exports a typed,
frozen configuration object. Invalid or missing required values fail at boot with a
message naming the variable, rather than failing at first use.

Covers every variable in `docs/LOCAL_DEVELOPMENT.md` section 5, plus the admin token
from ADR-016. Ships with a matching `.env.example`.

Depends on nothing else in the workspace.

### `packages/database`

Owns Knex configuration, the migration directory, and the `db:migrate`,
`db:rollback`, and `db:seed` commands. In Phase 0 it contains the migration harness
and an initial migration establishing the `projects` table, which gives `/ready` a
concrete schema version to verify and gives the integration-test harness something
real to exercise.

The remaining migrations land in Phase 1.

### `apps/api`

A Fastify application exposing:

- `GET /health` — process liveness only. Returns 200 whenever the process is
  serving. It does not check dependencies.
- `GET /ready` — verifies PostgreSQL connectivity and that applied migrations match
  the version the build expects. A server running against a stale schema reports not
  ready. Returns 503 with a machine-readable reason when either check fails.

Depends on `config` and `database`.

### `apps/web`

A Next.js application shell with a single placeholder route confirming it builds,
starts, and can reach the API's health endpoint. No data-bearing interface exists
until Phase 2.

Must not connect to PostgreSQL directly, per `AGENTS.md`.

### `infrastructure/`

`compose.yaml` defines postgres, api, and web, with published ports bound to
`127.0.0.1`. `compose.demo.yaml` is created with ElasticMQ defined and the demo
services stubbed as comments, to be filled in Phase 5.

## 6. Scope adjustment

`docs/TASKS.md` Epic 0 includes "Record time to first useful journey." No component
emits events until Phase 3, and no complete journey exists until Phase 5, so this
cannot be measured during Phase 0.

Phase 0 verifies that the documented Compose command brings up the stack on a clean
machine. The time-to-first-journey measurement moves to Epic 12, where the demo
workflow makes it a real number. Moving it is preferable to marking it complete
without a measurement.

## 7. Testing

Phase 0 establishes the harnesses that later phases depend on, and covers its own
deliverables:

- **Unit** (Vitest): `packages/config` accepts a valid environment, rejects a missing
  required variable with a message naming it, and rejects malformed values.
- **Integration** (Vitest + Testcontainers): migrations apply against a real
  PostgreSQL container, roll back cleanly, and are idempotent on re-run.
- **API integration** (Fastify inject): `/health` returns 200 when the process is up;
  `/ready` returns 200 with a reachable database at the expected schema version, and
  503 with a reason when the database is unreachable or migrations are behind.

Browser and end-to-end stages are defined in CI but not populated until Phase 2 and
Phase 5 respectively.

## 8. CI

`.gitlab-ci.yml`, following `docs/TESTING_STRATEGY.md` section 8:

1. install
2. format check
3. lint
4. type check
5. unit tests
6. database integration tests
7. build

Browser and E2E stages are declared and skipped, so adding them later is a change to
an existing stage rather than a restructuring.

### Tooling choice

ESLint 9 flat configuration with type-aware `typescript-eslint` rules, plus Prettier.

Biome was considered — a single dependency, substantially faster, simpler
configuration — and rejected because it cannot perform type-aware linting.
`no-floating-promises` and `no-misused-promises` are directly load-bearing for
ADR-007: an SDK whose central guarantee is that recorder failure never breaks the host
application cannot rely on review alone to catch an unawaited promise.

## 9. Acceptance criteria

- `pnpm install` succeeds on a clean checkout.
- `pnpm typecheck` passes across the workspace.
- `pnpm lint` and `pnpm format:check` pass.
- `docker compose -f infrastructure/compose.yaml up` starts postgres, api, and web.
- `GET /health` returns 200 while the process is serving.
- `GET /ready` returns 200 against a migrated database, and 503 with a reason when
  the database is unreachable or the schema is behind.
- `pnpm db:migrate` and `pnpm db:rollback` run against the Compose database.
- The full CI pipeline passes.
- `LICENSE` contains Apache-2.0 and `README.md` states the self-hosted core is free.
- Node.js and pnpm versions are pinned.
- ADR-014 through ADR-026 are recorded in `docs/DECISIONS.md`.
- The six document corrections in section 3 are applied.
- PostgreSQL remains the only required backing service in `compose.yaml`.

## 10. Explicitly not in Phase 0

Event protocol schemas, ingestion, the remaining migrations, search, the timeline
interface, the SDK, propagation, the demo services, replay, retention
implementation, admin-token session handling, and browser tests. Each belongs to a
later phase and gets its own design.
