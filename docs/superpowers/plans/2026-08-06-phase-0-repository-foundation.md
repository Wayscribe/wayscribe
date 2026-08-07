# Phase 0: Repository Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Flight Recorder monorepo so that a clean checkout installs, type checks, lints, tests, starts under Docker Compose, and answers `/health` and `/ready` correctly — with the blocking architecture decisions recorded and the planning documents' contradictions corrected.

**Architecture:** A pnpm workspace with two applications (`apps/api` on Fastify, `apps/web` on Next.js) and six packages. Two packages are fully implemented here: `config` (Zod-parsed environment, fails fast at boot) and `database` (Knex migrations plus a schema-currency check that `/ready` depends on). Four packages are scaffolded so the workspace graph and type checking are genuinely exercised without implying completeness. PostgreSQL is the only required backing service.

**Tech Stack:** TypeScript 5.x, Node.js 24 LTS, pnpm 11, Fastify 5, Next.js 15, Knex, Zod 4, Vitest, Testcontainers, Docker Compose, GitLab CI.

**Source spec:** `docs/superpowers/specs/2026-08-06-phase-0-foundation-design.md`

---

## Prerequisites

The machine currently has Node v20.20.2, which reached end of life in April 2026, and no pnpm. Before Task 1:

```bash
nvm install 24 && nvm use 24
corepack enable
```

Verify `node -v` reports v24.x before continuing. Docker 29.4.1 is already present.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Workspace root: scripts, engine pins, packageManager |
| `pnpm-workspace.yaml` | Workspace member globs |
| `tsconfig.base.json` | Shared compiler options; every package extends it |
| `eslint.config.js` | Flat config with type-aware rules |
| `vitest.config.ts` | Unit test config (excludes integration) |
| `vitest.integration.config.ts` | Integration test config (Testcontainers, longer timeout) |
| `packages/config/src/schema.ts` | Zod schema for server environment |
| `packages/config/src/load.ts` | `loadServerEnv`, `ConfigError` |
| `packages/database/src/knexfile.ts` | Knex connection config |
| `packages/database/src/migrations.ts` | `pendingMigrationCount` — used by `/ready` |
| `packages/database/migrations/001_projects.ts` | First migration; proves the harness |
| `apps/api/src/app.ts` | `buildApp` — wires Fastify, injectable for tests |
| `apps/api/src/routes/health.ts` | `/health` and `/ready` handlers |
| `apps/api/src/server.ts` | Process entrypoint; loads config, starts listening |
| `apps/web/app/page.tsx` | Shell route |
| `infrastructure/compose.yaml` | postgres, api, web |
| `infrastructure/compose.demo.yaml` | ElasticMQ; demo services stubbed for Phase 5 |
| `.gitlab-ci.yml` | Seven-stage pipeline |

`config` depends on nothing. `database` depends on nothing. `apps/api` depends on both. Nothing depends on `apps/api`.

---

## Task 1: Workspace root and toolchain pins

**Files:**
- Create: `.nvmrc`, `package.json`, `pnpm-workspace.yaml`, `.gitignore`

- [ ] **Step 1: Pin Node**

Create `.nvmrc`:

```text
24
```

- [ ] **Step 2: Create the workspace manifest**

Create `package.json`:

```json
{
  "name": "flight-recorder",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "Apache-2.0",
  "engines": {
    "node": ">=24.0.0 <25.0.0"
  },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "db:migrate": "pnpm --filter @flight-recorder/database migrate",
    "db:rollback": "pnpm --filter @flight-recorder/database rollback",
    "db:seed": "pnpm --filter @flight-recorder/database seed"
  }
}
```

- [ ] **Step 3: Pin pnpm to the current 11.x**

Run: `corepack use pnpm@11`

This resolves the latest 11.x and writes the exact version into `packageManager`. Do not hand-write a patch version — let corepack pin what actually exists.

Expected: `package.json` gains a `"packageManager": "pnpm@11.x.y+sha512..."` field.

pnpm 11 requires Node.js >= 22.13, which the pinned Node 24 satisfies.

- [ ] **Step 4: Define workspace members**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 5: Add gitignore**

Create `.gitignore`:

```text
node_modules/
dist/
.next/
coverage/
*.tsbuildinfo
.env
.env.local
.DS_Store
```

- [ ] **Step 6: Verify the toolchain**

Run: `node -v && pnpm -v`
Expected: `v24.x.y` and `10.x.y`. If node reports v20, stop and complete the Prerequisites section.

- [ ] **Step 7: Commit**

```bash
git add .nvmrc package.json pnpm-workspace.yaml .gitignore
git commit -m "chore: pin Node 24 and pnpm 11, add workspace root"
```

---

## Task 2: License and free-core statement

**Files:**
- Create: `LICENSE`, `NOTICE`
- Modify: `README.md`

- [ ] **Step 1: Add the Apache-2.0 license**

Run: `curl -sSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE`

Expected: `LICENSE` is roughly 11 KB and begins with "Apache License". Verify with `head -3 LICENSE`.

- [ ] **Step 2: Add NOTICE**

Create `NOTICE`:

```text
Flight Recorder
Copyright 2026 Jorge Polanco

This product includes software developed as part of the Flight Recorder
project (https://gitlab.com/jojithedev/flight-recorder).

Licensed under the Apache License, Version 2.0. You may obtain a copy of
the License at http://www.apache.org/licenses/LICENSE-2.0
```

- [ ] **Step 3: State the license in the README**

In `README.md`, replace the `## Status` section heading block by inserting a new section immediately before `## Core product promise`:

```markdown
## License

Apache-2.0. The self-hosted core is free to use and always will be: event
ingestion, entity and alias search, journey timelines, transformation diffs,
error and retry inspection, development replay, and retention controls require
no payment and no hosted Flight Recorder account.

See [Product principles and non-negotiables](docs/PRODUCT_PRINCIPLES.md) and
ADR-011 and ADR-014 in [the decision log](docs/DECISIONS.md).

```

- [ ] **Step 4: Commit**

```bash
git add LICENSE NOTICE README.md
git commit -m "docs: adopt Apache-2.0 and state the free-core commitment"
```

---

## Task 3: Record ADR-014 through ADR-026

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Append the decision records**

Append to `docs/DECISIONS.md`, preserving the existing `---` separator style:

```markdown

---

## ADR-014: License the project under Apache-2.0

**Status:** Accepted

### Context

The project targets adoption by individual developers and small teams. The SDK is
embedded directly into other organizations' applications, which makes license choice
an adoption factor rather than a formality. Relicensing later requires consent from
every contributor.

### Decision

All packages are licensed Apache-2.0, with a NOTICE file.

### Consequences

- The SDK can be embedded without legal review friction.
- A split license reserving copyleft for the server was considered and rejected as
  contributor friction that does not serve an adoption goal.
- Commercial optionality is reduced; future revenue must come from hosting, support,
  or operational convenience rather than license terms.

---

## ADR-015: Use ElasticMQ for the demo queue

**Status:** Accepted

### Context

The SDK specification and Epic 11 are SQS-specific, but no Compose service provided a
queue, and ADR-012 requires PostgreSQL to be the only required backing service.

### Decision

The demo Compose profile provides ElasticMQ, an SQS-compatible server distributed as a
roughly 40 MB native image. The core `compose.yaml` continues to require only
PostgreSQL. SDK queue helpers target the SQS message-attribute contract.

### Consequences

- Code proven against ElasticMQ works unchanged against AWS SQS.
- The core installation footprint is unchanged.
- The demo profile is heavier than the core profile, which is acceptable because the
  demo is opt-in.
- LocalStack was rejected as roughly 1 GB in the onboarding path; a PostgreSQL-backed
  queue was rejected because it leaves SQS propagation untested.

---

## ADR-016: Authenticate the web interface with a single admin token

**Status:** Accepted

### Context

The interface displays captured customer data including names, phone numbers, and
email addresses. A published self-hostable tool will be exposed to networks its
authors did not anticipate.

### Decision

The web interface authenticates against a single admin token supplied by environment
variable, exchanged for a session cookie. The local seed generates and prints one.
Compose binds published ports to `127.0.0.1` by default.

Implementation lands in Phase 2 with the first data-bearing interface. Phase 0 defines
the environment variable and the Compose binding.

### Consequences

- Onboarding cost is roughly one environment variable.
- V0 has no multi-user model; V1's OIDC support supersedes this.
- Project API keys remain scoped to SDK ingestion and are not reused for the
  interface, so a browser session carries no ingestion rights.

---

## ADR-017: Pin Node.js 24 and pnpm 11

**Status:** Accepted

### Context

The documents required "Node.js active LTS, pinned" without naming a version.
Node.js 20 reached end of life in April 2026. At the time of writing, the current
stable pnpm is 11.x; 10.x is superseded.

### Decision

Node.js 24.x, pinned through `.nvmrc` and `engines`. pnpm 11.x, pinned through
`packageManager` and resolved by corepack. pnpm 11 requires Node.js >= 22.13, which
Node 24 satisfies.

### Consequences

- Contributors need Node 24; the README states this.
- Version bumps are explicit repository changes.

---

## ADR-018: Capture-mode names use the protocol form

**Status:** Accepted

### Context

`DATABASE_SCHEMA.md` used `metadata`, `allowlist`, `redacted`, and `full`, while the
protocol, security, and SDK documents used the hyphenated long forms.

### Decision

The canonical values are `metadata-only`, `allowlisted-fields`, `redacted-payload`,
and `full-payload`, used in the protocol, the SDK configuration surface, the API, and
the `environments.capture_mode` check constraint.

### Consequences

- The source-of-truth order in `AGENTS.md` is honored: contracts outrank the schema.
- These strings already appear in public SDK configuration, so no consumer changes.

---

## ADR-019: Replay destinations store an origin and base path

**Status:** Accepted

### Context

`API_SPEC.md` created destinations with a full URL including a path, conflicting with
the `base_url` column in the schema and the separate `path` field in
`CreateReplayRequest`.

### Decision

A destination stores `base_url`: scheme, host, port, and optional base path. A replay
request supplies a relative `path`, appended to the base. Path traversal, absolute
URLs, and protocol-relative URLs are rejected.

### Consequences

- SSRF validation operates against a fixed origin approved at destination-creation
  time rather than a per-request URL.
- Redirect, userinfo, and DNS-rebinding bypasses have a smaller surface.
- Destinations are less flexible; one destination per origin.

---

## ADR-020: Composite primary keys on journeys and events

**Status:** Accepted

### Context

The schema specified "primary key or unique `(project_id, id)`" without resolving
which, leaving foreign key shapes undefined.

### Decision

`journeys` and `journey_events` use `(project_id, id)` as the primary key.
`entity_aliases` references journeys through the composite foreign key
`(project_id, journey_id)`.

### Consequences

- No redundant surrogate key index.
- Cross-project joins are structurally impossible, supporting the isolation tests
  required by `SECURITY.md` section 8.
- Composite foreign keys are more verbose in Knex.

---

## ADR-021: Conflicting duplicate event IDs are rejected

**Status:** Accepted

### Context

`TESTING_STRATEGY.md` required this policy to be decided explicitly.

### Decision

Each event row stores a `content_hash` derived from a canonical serialization. An
event whose `(project_id, id)` exists with a differing hash is rejected with `409` and
code `event_id_conflict`; in a batch it is reported as `rejected` while other events
proceed. Identical resubmissions remain idempotent.

### Consequences

- An SDK defect that reuses event IDs surfaces instead of silently discarding
  evidence.
- Requires canonical JSON serialization with sorted keys and stable number
  formatting.
- Adds one column and one hash computation per ingested event.

---

## ADR-022: Failed delivery uses the attempt's own operation

**Status:** Accepted

### Context

`EVENT_PROTOCOL.md` required the choice between `delivered`-with-error and a separate
`failed` event to be consistent, without making it.

### Decision

A failed attempt emits `delivered`, or `retried` for subsequent attempts, with `error`
populated and the HTTP status in `metadata`. `failed` is reserved for terminal journey
or branch failure such as a dead-letter transition.

### Consequences

- Matches the expected timeline in `DEMO_SCENARIO.md` section 6.
- Duration, input, and output stay attached to the attempt rather than being split
  across two events.

---

## ADR-023: identify() emits a dedicated event

**Status:** Accepted

### Context

The SDK specification left alias emission dependent on "the final protocol decision."

### Decision

`identified` is added to the `JourneyOperation` enum. `journey.identify()` emits a
dedicated event carrying the new aliases. The `aliases` field remains available on
every event for callers preferring inline identity.

### Consequences

- Aliases are not lost if the process terminates before the next event.
- Identity mapping gets a first-class operation, consistent with ADR-013.
- Adds one event per identify call; adding an operation is a compatible protocol
  change under `EVENT_PROTOCOL.md` section 11.

---

## ADR-024: Payload diffs are computed at ingestion and stored

**Status:** Accepted

### Context

The task list deferred this to "the performance decision."

### Decision

The structural diff is computed during ingestion and written to
`journey_events.payload_diff`.

### Consequences

- The timeline performance target of p95 under 500 ms for 500 events is achievable.
- Events are immutable, so a stored diff never goes stale.
- Changing the diff algorithm requires a backfill migration.

---

## ADR-025: Array diffs compare by index

**Status:** Accepted

### Context

The task list required "documented policy" for array comparison.

### Decision

Arrays are compared element-wise by index, with length differences reported as added
or removed entries. No longest-common-subsequence matching and no move detection in
V0.

### Consequences

- Diff cost stays linear, satisfying the required complexity limits.
- A reordered array is reported as broadly changed; this is documented in user-facing
  diff documentation.

---

## ADR-026: Retention cleanup runs in the API process

**Status:** Accepted

### Context

Epic 14 specified retention behavior without specifying how it is triggered.

### Decision

Retention runs on an interval inside the API process, guarded by
`pg_try_advisory_lock`, deleting in bounded batches.

### Consequences

- No additional container, preserving ADR-012.
- Multiple API replicas do not delete concurrently.
- Retention stops when the API is down, which is acceptable for a cleanup job.
```

- [ ] **Step 2: Verify the file parses as expected**

Run: `grep -c '^## ADR-' docs/DECISIONS.md`
Expected: `26`

- [ ] **Step 3: Commit**

```bash
git add docs/DECISIONS.md
git commit -m "docs(decisions): record ADR-014 through ADR-026"
```

---

## Task 4: Apply the six document corrections

**Files:**
- Modify: `docs/DATABASE_SCHEMA.md`, `docs/API_SPEC.md`, `docs/EVENT_PROTOCOL.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/TASKS.md`, `README.md`

- [ ] **Step 1: Correct capture-mode values (ADR-018)**

In `docs/DATABASE_SCHEMA.md`, in the `environments` table, change the `capture_mode` row's Notes cell from:

```text
| `capture_mode` | text | metadata, allowlist, redacted, full |
```

to:

```text
| `capture_mode` | text | `metadata-only`, `allowlisted-fields`, `redacted-payload`, `full-payload` |
```

- [ ] **Step 2: Correct the replay destination example (ADR-019)**

In `docs/API_SPEC.md` section 9, replace the request body:

```json
{
  "name": "Local integration API",
  "baseUrl": "http://host.docker.internal:3200",
  "environmentType": "development",
  "headers": {
    "x-replay-key": "configured-secret"
  }
}
```

Then add immediately below that JSON block:

```markdown
`baseUrl` is an origin with an optional base path. The relative `path` supplied on a
replay request is appended to it. Path traversal, absolute URLs, and protocol-relative
URLs are rejected. See ADR-019.
```

This also corrects the port: `3000` is the web application per `LOCAL_DEVELOPMENT.md`
section 4; demo-integration is `3200`.

- [ ] **Step 3: Make key definitions explicit and add content_hash (ADR-020, ADR-021)**

In `docs/DATABASE_SCHEMA.md`, in the `journeys` constraints list, replace:

```text
- primary key or unique `(project_id, id)`
```

with:

```text
- composite primary key `(project_id, id)`
```

In the `journey_events` table, add this row immediately after the `protocol_version` row:

```text
| `content_hash` | text | Canonical hash for duplicate-conflict detection |
```

In the `journey_events` constraints list, replace:

```text
- unique `(project_id, id)` for idempotency
```

with:

```text
- composite primary key `(project_id, id)`, which provides idempotency
```

In the `entity_aliases` table, change the `journey_id` row's Notes cell from
`FK relationship` to:

```text
| `journey_id` | text | Composite FK `(project_id, journey_id)` to journeys |
```

- [ ] **Step 4: Add the identified operation and resolve delivery semantics (ADR-022, ADR-023)**

In `docs/EVENT_PROTOCOL.md` section 3, add `"identified"` to the `JourneyOperation`
union immediately after `"received"`:

```typescript
type JourneyOperation =
  | "received"
  | "identified"
  | "transformed"
  | "validated"
  | "persisted"
  | "published"
  | "consumed"
  | "delivered"
  | "failed"
  | "retried"
  | "completed";
```

In section 5, add a subsection immediately after the `received` subsection:

```markdown
### `identified`

New aliases were associated with the entity. Emitted by `journey.identify()`.
```

In the same section, replace the `delivered` paragraph reading "A failed delivery
should still use `delivered` with an error or emit a separate `failed` event according
to the SDK helper design. The choice must remain consistent." with:

```markdown
A failed delivery attempt uses `delivered` — or `retried` for subsequent attempts —
with `error` populated and the HTTP status in `metadata`. The `failed` operation is
reserved for terminal journey or branch failure, such as a dead-letter transition.
See ADR-022.
```

- [ ] **Step 5: Add demo-worker to both layout diagrams**

In `README.md` and in `docs/IMPLEMENTATION_PLAN.md`, in the repository layout code
blocks, add `demo-worker` between `demo-integration` and `demo-target`:

```text
├── apps/
│   ├── api/
│   ├── web/
│   ├── demo-source/
│   ├── demo-integration/
│   ├── demo-worker/
│   └── demo-target/
```

- [ ] **Step 6: Move the time-to-first-journey measurement**

In `docs/TASKS.md`, remove this line from Epic 0:

```text
- [ ] Record time to first useful journey.
```

Add to the end of Epic 12:

```text
- [ ] Record time to first useful journey on a clean machine.
```

- [ ] **Step 7: Verify no stale values remain**

Run: `grep -rn 'metadata, allowlist, redacted, full' docs/ ; grep -rn 'replay/customer' docs/API_SPEC.md`
Expected: no output from either. Any output means a correction was missed.

- [ ] **Step 8: Commit**

```bash
git add docs/ README.md
git commit -m "docs: resolve cross-document contradictions per ADR-018 through ADR-023"
```

---

## Task 5: Shared TypeScript configuration

**Files:**
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create the base config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are deliberately on. This
codebase parses untrusted payloads, and both catch a class of bug that unit tests
tend to miss.

- [ ] **Step 2: Install TypeScript at the root**

Run: `pnpm add -Dw typescript@^5`

- [ ] **Step 3: Commit**

```bash
git add tsconfig.base.json package.json pnpm-lock.yaml
git commit -m "chore: add shared TypeScript configuration"
```

---

## Task 6: Lint and format configuration

**Files:**
- Create: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`

- [ ] **Step 1: Install tooling**

Run:

```bash
pnpm add -Dw eslint@^9 typescript-eslint@^8 @eslint/js@^9 prettier@^3 eslint-config-prettier@^9
```

- [ ] **Step 2: Create the flat ESLint config**

Create `eslint.config.js`:

```javascript
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.config.js"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true }
      ]
    }
  },
  prettier
);
```

`no-floating-promises` and `no-misused-promises` are the reason this project uses
type-aware ESLint rather than a faster non-type-aware linter. ADR-007 guarantees that
recorder failure never breaks the host application, and an unawaited promise in the
SDK breaks that guarantee silently.

- [ ] **Step 3: Create Prettier config**

Create `.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "none",
  "printWidth": 100
}
```

Create `.prettierignore`:

```text
node_modules/
dist/
.next/
coverage/
pnpm-lock.yaml
LICENSE
```

- [ ] **Step 4: Verify both run clean**

Run: `pnpm format:check && pnpm lint`
Expected: both exit 0. If Prettier reports files needing formatting, run
`pnpm format` and re-check.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore package.json pnpm-lock.yaml
git commit -m "chore: add ESLint flat config with type-aware rules and Prettier"
```

---

## Task 7: Vitest configuration

**Files:**
- Create: `vitest.config.ts`, `vitest.integration.config.ts`

- [ ] **Step 1: Install Vitest**

Run: `pnpm add -Dw vitest@^3`

- [ ] **Step 2: Create the unit test config**

Create `vitest.config.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database"),
      "@flight-recorder/protocol": packageSource("protocol"),
      "@flight-recorder/payload-security": packageSource("payload-security"),
      "@flight-recorder/payload-diff": packageSource("payload-diff")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 10_000
  }
});
```

Those aliases matter. Workspace packages resolve through `main`/`exports` to `dist/`,
which does not exist until something runs a build. Without the aliases,
`apps/api`'s tests fail to resolve `@flight-recorder/database` on a clean checkout,
and CI would require a build before the unit stage.

- [ ] **Step 3: Create the integration test config**

Create `vitest.integration.config.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flight-recorder/config": packageSource("config"),
      "@flight-recorder/database": packageSource("database")
    }
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
});
```

Integration tests start real PostgreSQL containers. The long timeouts cover first-run
image pulls, and `fileParallelism: false` avoids several suites racing to start
containers at once.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts vitest.integration.config.ts package.json pnpm-lock.yaml
git commit -m "chore: add Vitest unit and integration configurations"
```

---

## Task 8: packages/config — environment parsing

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/index.ts`, `packages/config/src/schema.ts`, `packages/config/src/load.ts`
- Test: `packages/config/src/load.test.ts`
- Create: `.env.example`

- [ ] **Step 1: Create the package manifest**

Create `packages/config/package.json`:

```json
{
  "name": "@flight-recorder/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^4"
  }
}
```

Create `packages/config/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/config/src/load.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ConfigError, loadServerEnv } from "./load.js";

const validEnv = {
  DATABASE_URL: "postgresql://flight:flight@localhost:5432/flight",
  APP_URL: "http://localhost:3000",
  API_URL: "http://localhost:8080",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
  ADMIN_TOKEN: "fedcba9876543210fedcba9876543210",
  REPLAY_ALLOWED_HOSTS: "localhost,host.docker.internal"
};

describe("loadServerEnv", () => {
  it("parses a valid environment", () => {
    const config = loadServerEnv(validEnv);
    expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(config.REPLAY_ALLOWED_HOSTS).toEqual(["localhost", "host.docker.internal"]);
  });

  it("applies documented defaults", () => {
    const config = loadServerEnv(validEnv);
    expect(config.DEFAULT_RETENTION_DAYS).toBe(7);
    expect(config.MAX_EVENT_PAYLOAD_BYTES).toBe(262_144);
    expect(config.ALLOW_FULL_PAYLOAD_CAPTURE).toBe(false);
    expect(config.PORT).toBe(8080);
  });

  it("names the missing variable when one is absent", () => {
    const { DATABASE_URL: _omitted, ...withoutDatabaseUrl } = validEnv;
    expect(() => loadServerEnv(withoutDatabaseUrl)).toThrow(ConfigError);
    expect(() => loadServerEnv(withoutDatabaseUrl)).toThrow(/DATABASE_URL/);
  });

  it("rejects an encryption key that is too short", () => {
    expect(() => loadServerEnv({ ...validEnv, ENCRYPTION_KEY: "short" })).toThrow(
      /ENCRYPTION_KEY/
    );
  });

  it("rejects a malformed database URL", () => {
    expect(() => loadServerEnv({ ...validEnv, DATABASE_URL: "not-a-url" })).toThrow(
      /DATABASE_URL/
    );
  });

  it("rejects an empty replay host allowlist", () => {
    expect(() => loadServerEnv({ ...validEnv, REPLAY_ALLOWED_HOSTS: "" })).toThrow(
      /REPLAY_ALLOWED_HOSTS/
    );
  });

  it("returns a frozen object", () => {
    const config = loadServerEnv(validEnv);
    expect(Object.isFrozen(config)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/config`
Expected: FAIL — cannot resolve `./load.js`.

- [ ] **Step 4: Write the schema**

Create `packages/config/src/schema.ts`:

```typescript
import { z } from "zod";

export const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  APP_URL: z.url(),
  API_URL: z.url(),
  ENCRYPTION_KEY: z.string().min(32),
  ADMIN_TOKEN: z.string().min(32),
  DEFAULT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  MAX_EVENT_PAYLOAD_BYTES: z.coerce.number().int().positive().default(262_144),
  ALLOW_FULL_PAYLOAD_CAPTURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REPLAY_ALLOWED_HOSTS: z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0)
    )
    .pipe(z.array(z.string()).min(1)),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info")
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
```

`ALLOW_FULL_PAYLOAD_CAPTURE` defaults to `false`. `LOCAL_DEVELOPMENT.md` sets it
`true` for local work, but the safe default belongs in code — `SECURITY.md` section 1
requires capture to be opt-in.

- [ ] **Step 5: Write the loader**

Create `packages/config/src/load.ts`:

```typescript
import { serverEnvSchema, type ServerEnv } from "./schema.js";

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

export function loadServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data);
}
```

The error names every failing variable at once rather than stopping at the first, so
a misconfigured deployment is fixed in one pass.

Create `packages/config/src/index.ts`:

```typescript
export { ConfigError, loadServerEnv } from "./load.js";
export { serverEnvSchema, type ServerEnv } from "./schema.js";
```

- [ ] **Step 6: Install and run the tests**

Run: `pnpm install && pnpm vitest run packages/config`
Expected: PASS, 7 tests.

- [ ] **Step 7: Create the example environment file**

Create `.env.example`:

```env
# Server
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight
APP_URL=http://localhost:3000
API_URL=http://localhost:8080
PORT=8080
LOG_LEVEL=info

# Security — replace both before any non-local use.
# Generate with: openssl rand -hex 32
ENCRYPTION_KEY=replace-for-local-development-0000
ADMIN_TOKEN=replace-for-local-development-0000

# Capture and retention
DEFAULT_RETENTION_DAYS=7
MAX_EVENT_PAYLOAD_BYTES=262144
ALLOW_FULL_PAYLOAD_CAPTURE=false

# Replay
REPLAY_ALLOWED_HOSTS=localhost,host.docker.internal,demo-integration
```

- [ ] **Step 8: Commit**

```bash
git add packages/config .env.example pnpm-lock.yaml
git commit -m "feat(config): add fail-fast environment parsing"
```

---

## Task 9: packages/database — Knex, first migration, schema currency

**Files:**
- Create: `packages/database/package.json`, `packages/database/tsconfig.json`, `packages/database/knexfile.ts`, `packages/database/src/index.ts`, `packages/database/src/migrations.ts`, `packages/database/migrations/001_projects.ts`
- Test: `packages/database/src/migrations.integration.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `packages/database/package.json`:

```json
{
  "name": "@flight-recorder/database",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "migrate": "tsx src/cli.ts migrate",
    "rollback": "tsx src/cli.ts rollback",
    "seed": "tsx src/cli.ts seed"
  },
  "dependencies": {
    "knex": "^3",
    "pg": "^8"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^11",
    "@types/pg": "^8",
    "tsx": "^4"
  }
}
```

Create `packages/database/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "migrations/**/*.ts", "knexfile.ts"],
  "exclude": ["src/**/*.test.ts", "src/**/*.integration.test.ts"]
}
```

- [ ] **Step 2: Create the Knex configuration**

Create `packages/database/knexfile.ts`:

```typescript
import type { Knex } from "knex";

const config: Knex.Config = {
  client: "pg",
  connection: process.env["DATABASE_URL"],
  migrations: {
    directory: "./migrations",
    extension: "ts",
    loadExtensions: [".ts", ".js"]
  },
  seeds: {
    directory: "./seeds"
  },
  pool: { min: 0, max: 10 }
};

export default config;
```

- [ ] **Step 3: Write the first migration**

Create `packages/database/migrations/001_projects.ts`:

```typescript
import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.raw('create extension if not exists "pgcrypto"');

  await knex.schema.createTable("projects", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("name").notNullable();
    table.text("slug").notNullable().unique();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("projects");
}
```

The remaining nine tables land in Phase 1. This one exists so the migration harness,
the `/ready` schema check, and the integration test have something real to exercise.

- [ ] **Step 4: Write the failing integration test**

Create `packages/database/src/migrations.integration.test.ts`:

```typescript
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer
} from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingMigrationCount } from "./migrations.js";

describe("migrations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex({
      client: "pg",
      connection: container.getConnectionUri(),
      migrations: {
        directory: new URL("../migrations", import.meta.url).pathname,
        extension: "ts",
        loadExtensions: [".ts"]
      }
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("reports pending migrations before running them", async () => {
    expect(await pendingMigrationCount(db)).toBeGreaterThan(0);
  });

  it("applies migrations and creates the projects table", async () => {
    await db.migrate.latest();
    expect(await db.schema.hasTable("projects")).toBe(true);
  });

  it("reports zero pending migrations once current", async () => {
    expect(await pendingMigrationCount(db)).toBe(0);
  });

  it("is idempotent on re-run", async () => {
    await db.migrate.latest();
    expect(await pendingMigrationCount(db)).toBe(0);
  });

  it("enforces the unique slug constraint", async () => {
    await db("projects").insert({ name: "First", slug: "duplicate-slug" });
    await expect(
      db("projects").insert({ name: "Second", slug: "duplicate-slug" })
    ).rejects.toThrow();
  });

  it("rolls back cleanly", async () => {
    await db.migrate.rollback();
    expect(await db.schema.hasTable("projects")).toBe(false);
  });
});
```

Tests run in file order and share one container, so ordering is intentional: the
rollback test runs last because it destroys the schema.

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm install && pnpm vitest run --config vitest.integration.config.ts`
Expected: FAIL — cannot resolve `./migrations.js`.

- [ ] **Step 6: Implement the schema-currency check**

Create `packages/database/src/migrations.ts`:

```typescript
import type { Knex } from "knex";

/**
 * Number of migrations that exist on disk but have not been applied.
 *
 * `/ready` uses this: a process serving against a schema older than the one
 * its build expects must not report ready.
 */
export async function pendingMigrationCount(db: Knex): Promise<number> {
  const [, pending] = (await db.migrate.list()) as [unknown[], unknown[]];
  return pending.length;
}
```

Create `packages/database/src/index.ts`:

```typescript
export { pendingMigrationCount } from "./migrations.js";
```

- [ ] **Step 7: Add the migration CLI**

Create `packages/database/src/cli.ts`:

```typescript
import knex from "knex";
import config from "../knexfile.js";

const command = process.argv[2];
const db = knex(config);

try {
  switch (command) {
    case "migrate":
      await db.migrate.latest();
      break;
    case "rollback":
      await db.migrate.rollback();
      break;
    case "seed":
      await db.seed.run();
      break;
    default:
      console.error(`Unknown command: ${command ?? "(none)"}`);
      console.error("Usage: tsx src/cli.ts <migrate|rollback|seed>");
      process.exit(1);
  }
} finally {
  await db.destroy();
}
```

This replaces invoking the `knex` CLI directly. The CLI cannot load a TypeScript
knexfile without a registered loader, and wiring tsx into it is more fragile than a
twelve-line script that does the same thing.

- [ ] **Step 8: Run the integration tests**

Run: `pnpm vitest run --config vitest.integration.config.ts`
Expected: PASS, 6 tests. Docker must be running. First run pulls
`postgres:17-alpine` and may take a minute.

- [ ] **Step 9: Commit**

```bash
git add packages/database pnpm-lock.yaml
git commit -m "feat(database): add Knex harness, projects migration, schema currency check"
```

---

## Task 10: Scaffold the four deferred packages

**Files:**
- Create: `packages/{protocol,sdk-node,payload-security,payload-diff}/package.json`, `.../tsconfig.json`, `.../src/index.ts`

- [ ] **Step 1: Create each package**

For each of `protocol`, `sdk-node`, `payload-security`, `payload-diff`, create
`packages/<name>/package.json` — substituting the name and the phase noted below:

```json
{
  "name": "@flight-recorder/<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

And `packages/<name>/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: Add the placeholder entrypoints**

Create `packages/protocol/src/index.ts`:

```typescript
/**
 * Public event schemas and protocol types.
 *
 * Implemented in Phase 1. See docs/EVENT_PROTOCOL.md.
 */
export const PACKAGE_NAME = "@flight-recorder/protocol";
```

Create `packages/sdk-node/src/index.ts`:

```typescript
/**
 * Node.js recorder SDK.
 *
 * Implemented in Phase 3. See docs/NODE_SDK_SPEC.md.
 */
export const PACKAGE_NAME = "@flight-recorder/sdk-node";
```

Create `packages/payload-security/src/index.ts`:

```typescript
/**
 * Redaction, hashing, and size enforcement.
 *
 * Implemented in Phase 1. See docs/SECURITY.md.
 */
export const PACKAGE_NAME = "@flight-recorder/payload-security";
```

Create `packages/payload-diff/src/index.ts`:

```typescript
/**
 * Structural JSON comparison.
 *
 * Implemented in Phase 2. Array comparison is index-based per ADR-025.
 */
export const PACKAGE_NAME = "@flight-recorder/payload-diff";
```

- [ ] **Step 3: Verify the workspace resolves**

Run: `pnpm install && pnpm typecheck`
Expected: exit 0, six packages type checked.

- [ ] **Step 4: Commit**

```bash
git add packages pnpm-lock.yaml
git commit -m "chore: scaffold protocol, sdk-node, payload-security, payload-diff"
```

---

## Task 11: apps/api — /health

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/app.ts`, `apps/api/src/routes/health.ts`
- Test: `apps/api/src/routes/health.test.ts`

- [ ] **Step 1: Create the package manifest**

Create `apps/api/package.json`:

```json
{
  "name": "@flight-recorder/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@flight-recorder/config": "workspace:*",
    "@flight-recorder/database": "workspace:*",
    "fastify": "^5",
    "knex": "^3",
    "pg": "^8"
  },
  "devDependencies": {
    "tsx": "^4"
  }
}
```

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/health.test.ts`:

```typescript
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

function fakeDb(): Knex {
  return {
    raw: () => Promise.resolve({ rows: [{ "?column?": 1 }] }),
    migrate: { list: () => Promise.resolve([[], []]) }
  } as unknown as Knex;
}

describe("GET /health", () => {
  it("returns 200 while the process is serving", async () => {
    const app = buildApp({ db: fakeDb(), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("does not touch the database", async () => {
    let dbWasCalled = false;
    const db = {
      raw: () => {
        dbWasCalled = true;
        return Promise.resolve({});
      },
      migrate: { list: () => Promise.resolve([[], []]) }
    } as unknown as Knex;

    const app = buildApp({ db, logLevel: "silent" });
    await app.inject({ method: "GET", url: "/health" });

    expect(dbWasCalled).toBe(false);

    await app.close();
  });
});
```

The second test encodes the distinction that matters: `/health` is liveness only. If
it checked the database, an orchestrator would restart a healthy process during a
transient database blip.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/api`
Expected: FAIL — cannot resolve `../app.js`.

- [ ] **Step 4: Implement the app factory and route**

Create `apps/api/src/app.ts`:

```typescript
import Fastify, { type FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { registerHealthRoutes } from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
  }
}

export interface BuildAppOptions {
  db: Knex;
  logLevel?: string;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" }
  });

  app.decorate("db", options.db);
  registerHealthRoutes(app);

  return app;
}
```

Create `apps/api/src/routes/health.ts`:

```typescript
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", () => ({ status: "ok" }));
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm install && pnpm vitest run apps/api`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): add Fastify app factory and /health liveness endpoint"
```

---

## Task 12: apps/api — /ready and the server entrypoint

**Files:**
- Modify: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/server.ts`
- Test: `apps/api/src/routes/ready.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/ready.test.ts`:

```typescript
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

interface FakeDbOptions {
  reachable?: boolean;
  pendingMigrations?: number;
}

function fakeDb({ reachable = true, pendingMigrations = 0 }: FakeDbOptions = {}): Knex {
  return {
    raw: () =>
      reachable
        ? Promise.resolve({ rows: [{ "?column?": 1 }] })
        : Promise.reject(new Error("ECONNREFUSED")),
    migrate: {
      list: () =>
        Promise.resolve([[], Array.from({ length: pendingMigrations }, (_, i) => `${i}.ts`)])
    }
  } as unknown as Knex;
}

describe("GET /ready", () => {
  it("returns 200 when the database is reachable and the schema is current", async () => {
    const app = buildApp({ db: fakeDb(), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });

    await app.close();
  });

  it("returns 503 with a reason when the database is unreachable", async () => {
    const app = buildApp({ db: fakeDb({ reachable: false }), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "database_unreachable"
    });

    await app.close();
  });

  it("returns 503 when migrations are pending", async () => {
    const app = buildApp({ db: fakeDb({ pendingMigrations: 3 }), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "migrations_pending",
      pendingCount: 3
    });

    await app.close();
  });

  it("reports database_unreachable rather than leaking the driver error", async () => {
    const app = buildApp({ db: fakeDb({ reachable: false }), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.body).not.toContain("ECONNREFUSED");

    await app.close();
  });
});
```

The last test matters for a reason beyond tidiness: `/ready` is often the one endpoint
exposed to a load balancer, and driver errors can carry connection strings.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api`
Expected: FAIL — `/ready` returns 404.

- [ ] **Step 3: Implement /ready**

Replace `apps/api/src/routes/health.ts` entirely:

```typescript
import { pendingMigrationCount } from "@flight-recorder/database";
import type { FastifyInstance } from "fastify";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await app.db.raw("select 1");
    } catch (error) {
      app.log.error({ err: error }, "readiness check: database unreachable");
      return reply.code(503).send({
        status: "not_ready",
        reason: "database_unreachable"
      });
    }

    const pendingCount = await pendingMigrationCount(app.db);
    if (pendingCount > 0) {
      return reply.code(503).send({
        status: "not_ready",
        reason: "migrations_pending",
        pendingCount
      });
    }

    return { status: "ready" };
  });
}
```

The driver error goes to the log, never to the response body.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run apps/api`
Expected: PASS, 6 tests across both files.

- [ ] **Step 5: Add the process entrypoint**

Create `apps/api/src/server.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { loadServerEnv } from "@flight-recorder/config";
import knex from "knex";
import { buildApp } from "./app.js";

const env = loadServerEnv(process.env);

const db = knex({
  client: "pg",
  connection: env.DATABASE_URL,
  migrations: {
    directory: fileURLToPath(
      new URL("../../../packages/database/dist/migrations", import.meta.url)
    ),
    loadExtensions: [".js"]
  },
  pool: { min: 0, max: 10 }
});

const app = buildApp({ db, logLevel: env.LOG_LEVEL });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.destroy();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}
```

`loadServerEnv` runs before anything else, so a misconfigured process fails at start
with a message naming the variable.

Binding `0.0.0.0` is correct here because the process runs inside a container; Compose
restricts exposure by binding published ports to `127.0.0.1` on the host.

The running server reads migrations from `packages/database/dist/migrations` with
`loadExtensions: [".js"]` — the compiled output, not the TypeScript sources. The
runtime image has no TypeScript loader, so pointing at `.ts` files would make
`/ready` throw on every request. The `database` package's `tsconfig.json` uses
`rootDir: "."` specifically so `tsc` emits `dist/migrations/*.js`.

- [ ] **Step 6: Verify it type checks**

Run: `pnpm typecheck && pnpm lint`
Expected: exit 0 from both.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): add /ready dependency check and server entrypoint"
```

---

## Task 13: apps/web — Next.js shell

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`

- [ ] **Step 1: Create the package manifest**

Create `apps/web/package.json`:

```json
{
  "name": "@flight-recorder/web",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "next build",
    "dev": "next dev --port 3000",
    "start": "next start --port 3000",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@types/react": "^19",
    "@types/react-dom": "^19"
  }
}
```

Create `apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Next.js requires bundler resolution and JSX settings that differ from the Node
packages, so this config overrides several base options rather than inheriting them.

Create `apps/web/next.config.ts`:

```typescript
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone"
};

export default config;
```

- [ ] **Step 2: Create the shell**

Create `apps/web/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";

export const metadata = {
  title: "Flight Recorder",
  description: "Record-level debugging for distributed workflows"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

Create `apps/web/app/page.tsx`:

```tsx
export default function HomePage() {
  return (
    <main>
      <h1>Flight Recorder</h1>
      <p>
        Entity search and journey timelines arrive in Phase 2. This shell exists to
        confirm the application builds, starts, and is wired into the workspace.
      </p>
    </main>
  );
}
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm install && pnpm --filter @flight-recorder/web build`
Expected: Next.js reports a successful production build.

- [ ] **Step 4: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add Next.js application shell"
```

---

## Task 14: Compose — core stack

**Files:**
- Create: `infrastructure/compose.yaml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`

- [ ] **Step 1: Add the API Dockerfile**

Create `apps/api/Dockerfile`:

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY . .
RUN pnpm --filter @flight-recorder/api... build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
```

- [ ] **Step 2: Add the web Dockerfile**

Create `apps/web/Dockerfile`:

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN pnpm --filter @flight-recorder/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["pnpm", "--filter", "@flight-recorder/web", "start"]
```

- [ ] **Step 3: Create the core Compose file**

Create `infrastructure/compose.yaml`:

```yaml
name: flight-recorder

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: flight
      POSTGRES_PASSWORD: flight
      POSTGRES_DB: flight
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U flight -d flight"]
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build:
      context: ..
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: postgresql://flight:flight@postgres:5432/flight
      APP_URL: http://localhost:3000
      API_URL: http://localhost:8080
      PORT: "8080"
      LOG_LEVEL: info
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:-replace-for-local-development-0000}
      ADMIN_TOKEN: ${ADMIN_TOKEN:-replace-for-local-development-0000}
      DEFAULT_RETENTION_DAYS: "7"
      MAX_EVENT_PAYLOAD_BYTES: "262144"
      ALLOW_FULL_PAYLOAD_CAPTURE: "false"
      REPLAY_ALLOWED_HOSTS: localhost,host.docker.internal,demo-integration
    ports:
      - "127.0.0.1:8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8080/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

  web:
    build:
      context: ..
      dockerfile: apps/web/Dockerfile
    environment:
      NEXT_PUBLIC_API_URL: http://localhost:8080
    ports:
      - "127.0.0.1:3000:3000"
    depends_on:
      api:
        condition: service_started

volumes:
  postgres-data:
```

Every published port binds to `127.0.0.1`, so a default `up` on a cloud host does not
expose the stack. This is the Compose half of ADR-016.

- [ ] **Step 4: Verify the stack starts**

Run: `docker compose -f infrastructure/compose.yaml up --build -d`

Then: `curl -s localhost:8080/health`
Expected: `{"status":"ok"}`

Then: `curl -s -o /dev/null -w '%{http_code}' localhost:8080/ready`
Expected: `503` — migrations have not run yet. This is the correct answer and
confirms the readiness check works.

- [ ] **Step 5: Run migrations and confirm readiness flips**

Run: `DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate`

Then: `curl -s localhost:8080/ready`
Expected: `{"status":"ready"}`

- [ ] **Step 6: Tear down**

Run: `docker compose -f infrastructure/compose.yaml down`

- [ ] **Step 7: Commit**

```bash
git add infrastructure/compose.yaml apps/api/Dockerfile apps/web/Dockerfile
git commit -m "feat(infrastructure): add core Compose stack with localhost-bound ports"
```

---

## Task 15: Compose — demo profile skeleton

**Files:**
- Create: `infrastructure/compose.demo.yaml`

- [ ] **Step 1: Create the demo overlay**

Create `infrastructure/compose.demo.yaml`:

```yaml
# Demo profile. Adds the SQS-compatible queue and the four demo services that
# prove the reference journey. Layer it over the core stack:
#
#   docker compose -f infrastructure/compose.yaml \
#                  -f infrastructure/compose.demo.yaml up --build
#
# The demo services are implemented in Phase 5 (see docs/DEMO_SCENARIO.md).
# ElasticMQ is defined now because ADR-015 settles the queue choice, and the
# core compose.yaml must keep PostgreSQL as its only backing service.

name: flight-recorder

services:
  elasticmq:
    image: softwaremill/elasticmq-native:latest
    ports:
      - "127.0.0.1:9324:9324"
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:9324/?Action=ListQueues || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10
  # demo-source:       Phase 5 — simulates a Salesforce account webhook
  # demo-integration:  Phase 5 — receives, transforms, persists, publishes
  # demo-worker:       Phase 5 — consumes the queue, delivers to the target
  # demo-target:       Phase 5 — simulates HubSpot, rejects a missing phone
```

- [ ] **Step 2: Verify the overlay is valid and adds no core dependency**

Run: `docker compose -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml config --services`
Expected: `postgres`, `api`, `web`, `elasticmq`.

Run: `docker compose -f infrastructure/compose.yaml config --services`
Expected: `postgres`, `api`, `web` only — confirming the core stack still requires
PostgreSQL alone, per ADR-012.

- [ ] **Step 3: Commit**

```bash
git add infrastructure/compose.demo.yaml
git commit -m "feat(infrastructure): add demo profile with ElasticMQ"
```

---

## Task 16: GitLab CI and contribution templates

**Files:**
- Create: `.gitlab-ci.yml`, `.gitlab/issue_templates/bug.md`, `.gitlab/issue_templates/feature.md`, `.gitlab/merge_request_templates/default.md`

- [ ] **Step 1: Create the pipeline**

Create `.gitlab-ci.yml`:

```yaml
default:
  image: node:24-alpine
  before_script:
    - corepack enable
    - pnpm install --frozen-lockfile
  cache:
    key:
      files:
        - pnpm-lock.yaml
    paths:
      - .pnpm-store

variables:
  PNPM_HOME: "$CI_PROJECT_DIR/.pnpm-store"

stages:
  - verify
  - test
  - integration
  - build

format:
  stage: verify
  script:
    - pnpm format:check

lint:
  stage: verify
  script:
    - pnpm lint

typecheck:
  stage: verify
  script:
    - pnpm typecheck

unit:
  stage: test
  script:
    - pnpm test

database:
  stage: integration
  image: node:24
  services:
    - docker:dind
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
    TESTCONTAINERS_HOST_OVERRIDE: docker
  script:
    - pnpm test:integration

build:
  stage: build
  script:
    - pnpm build
```

The integration job uses the full `node:24` image rather than Alpine because
Testcontainers needs a Docker client, and runs against docker-in-docker.

Browser and E2E stages are intentionally absent rather than stubbed-and-skipped:
GitLab treats an empty job as a failure, so they are added in Phase 2 and Phase 5 when
they have something to run.

- [ ] **Step 2: Add issue templates**

Create `.gitlab/issue_templates/bug.md`:

```markdown
## What happened

## What you expected

## Reproduction steps

1.

## Environment

- Flight Recorder version:
- Node.js version:
- Deployment: Docker Compose / other

## Relevant logs

<!-- Redact API keys, tokens, and customer data before pasting. -->
```

Create `.gitlab/issue_templates/feature.md`:

```markdown
## Problem

<!-- What debugging or investigation task is hard today? -->

## Proposed behavior

## Product principle check

See docs/PRODUCT_PRINCIPLES.md section 5.

- [ ] Preserves a free and useful self-hosted core
- [ ] Keeps the minimum installation lightweight
- [ ] Does not increase time to first useful journey
- [ ] Makes the product clearer
- [ ] Strengthens record-first debugging, identity mapping, transformation diffs,
      existing-architecture support, or safe replay
- [ ] Can remain optional if it adds infrastructure
```

Create `.gitlab/merge_request_templates/default.md`:

```markdown
## Problem

## Approach

## Changed public contracts

<!-- Event protocol, API endpoints, SDK surface, database schema, configuration. -->

## Security implications

## Migrations

## Tests

## Documentation

## Deliberately deferred

## Checklist

- [ ] An architecture decision was added or updated if this changes technology
      choices, package boundaries, protocol semantics, authentication, encryption,
      replay policy, retention, storage, or compatibility guarantees
- [ ] Tests cover failure and abuse cases, not only valid input
- [ ] No real customer payloads, credentials, or production logs are included
```

- [ ] **Step 3: Verify the pipeline locally**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all five exit 0. This is every CI stage except the integration job.

- [ ] **Step 4: Commit**

```bash
git add .gitlab-ci.yml .gitlab
git commit -m "ci: add GitLab pipeline and contribution templates"
```

---

## Task 17: Update the local development documentation

**Files:**
- Modify: `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Replace the pre-implementation checklist**

`docs/LOCAL_DEVELOPMENT.md` section 10 is a checklist of decisions to make before the
first commit. Every item is now resolved, so replace the whole of section 10 with:

```markdown
## 10. Resolved before implementation

| Decision | Outcome | Record |
|---|---|---|
| Node.js version | 24.x active LTS | ADR-017 |
| pnpm version | 10.x via corepack | ADR-017 |
| License | Apache-2.0 | ADR-014 |
| Free self-hosted core | Confirmed | ADR-011, ADR-014 |
| Queue technology | ElasticMQ, demo profile only | ADR-015 |
| Web interface authentication | Single admin token | ADR-016 |

The time-to-first-journey target is measured in Epic 12, once the demo workflow makes
it a real number.
```

- [ ] **Step 2: Correct the setup commands**

In section 2, replace the command block with:

```bash
git clone <repository-url>
cd flight-recorder
nvm use            # Node 24, per .nvmrc
corepack enable
pnpm install
cp .env.example .env
docker compose -f infrastructure/compose.yaml up -d
pnpm db:migrate
```

Then remove the sentence "These commands are targets for the implementation. Update
this file when actual commands exist." — they are now the real commands.

- [ ] **Step 3: Add the queue to the service table**

In section 3, add a row after `postgres`:

```text
| `elasticmq` | SQS-compatible queue, demo profile only |
```

- [ ] **Step 4: Add the admin token to the environment variables**

In section 5, add to the server variables block:

```env
ADMIN_TOKEN=generated-local-admin-token
```

And change `ALLOW_FULL_PAYLOAD_CAPTURE=true` to `ALLOW_FULL_PAYLOAD_CAPTURE=false`,
matching the safe default the code enforces.

- [ ] **Step 5: Verify the documented commands actually work**

Run each command in section 2 against a clean clone in a temporary directory.
Expected: the stack comes up and `curl -s localhost:8080/ready` returns
`{"status":"ready"}`.

- [ ] **Step 6: Commit**

```bash
git add docs/LOCAL_DEVELOPMENT.md
git commit -m "docs(local-development): replace planning checklist with resolved decisions"
```

---

## Task 18: Verify Phase 0 acceptance criteria

**Files:** none — this task only verifies.

- [ ] **Step 1: Verify a clean install**

```bash
cd "$(mktemp -d)" && git clone /Users/jorgepolanco/workspace/flight-recorder fr-clean && cd fr-clean
pnpm install
```

Expected: exit 0.

- [ ] **Step 2: Verify the full local pipeline**

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Expected: all exit 0.

- [ ] **Step 3: Verify integration tests**

Run: `pnpm test:integration`
Expected: PASS, 6 tests. Docker must be running.

- [ ] **Step 4: Verify the Compose stack end to end**

```bash
cp .env.example .env
docker compose -f infrastructure/compose.yaml up --build -d
curl -s localhost:8080/health
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/ready
DATABASE_URL=postgresql://flight:flight@localhost:5432/flight pnpm db:migrate
curl -s localhost:8080/ready
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000
```

Expected in order: `{"status":"ok"}`, `503`, migrations apply,
`{"status":"ready"}`, `200`.

- [ ] **Step 5: Verify PostgreSQL is the only required service**

Run: `docker compose -f infrastructure/compose.yaml config --services`
Expected: `postgres`, `api`, `web` — no queue, no cache, no third-party service.

- [ ] **Step 6: Verify the decision records and corrections**

```bash
grep -c '^## ADR-' docs/DECISIONS.md
grep -rn 'metadata, allowlist, redacted, full' docs/ || echo "capture modes corrected"
grep -n 'demo-worker' README.md docs/IMPLEMENTATION_PLAN.md
grep -n 'identified' docs/EVENT_PROTOCOL.md
head -3 LICENSE
```

Expected: `26`; "capture modes corrected"; `demo-worker` present in both layouts;
`identified` present in the protocol; LICENSE beginning "Apache License".

- [ ] **Step 7: Tear down and clean up**

```bash
docker compose -f infrastructure/compose.yaml down -v
cd / && rm -rf "$(dirname "$PWD")/fr-clean"
```

- [ ] **Step 8: Tag the phase**

```bash
cd /Users/jorgepolanco/workspace/flight-recorder
git tag -a phase-0-complete -m "Phase 0: repository foundation"
```

---

## Definition of done

Phase 0 is complete when every checkbox above is checked and Task 18 passes in full.
At that point the repository installs, type checks, lints, tests, builds, starts under
Compose, answers `/health` and `/ready` correctly, records ADR-014 through ADR-026,
and carries no known contradictions between its planning documents.

**Not in this phase**, each with its own design: the event protocol schemas, ingestion,
the remaining nine migrations, search, the timeline interface, the SDK, propagation,
the demo services, replay, retention implementation, and admin-token session handling.
