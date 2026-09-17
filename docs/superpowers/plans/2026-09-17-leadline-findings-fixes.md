# Leadline Findings Fix Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what Leadline's first dogfood run found, in one pass, so the second run
tests the fixes rather than the same gaps.

**Architecture:** Four independent batches, each on its own branch: the Node SDK, the
server and its API, the CLI and the install paths, and documentation. Each batch is
test-first. Two findings need a decision recorded as an ADR before their code changes.

**Tech Stack:** TypeScript pnpm monorepo on Node 24, Fastify, Next.js, Knex, Vitest,
Playwright, Docker Compose, Helm, GitLab CI.

**Source:** `/Users/jorgepolanco/workspace/leadline/.claude/worktrees/step-2-wayscribe/FINDINGS.md`,
F-001 to F-028, written while instrumenting and running Leadline against Wayscribe
`27f4d64`. Read the entry before changing anything it names: each one states what was
seen, what was expected, and what Leadline did instead.

---

## Ground rules for every batch

- Work in the branch worktree the controller gives you. Verify with
  `git rev-parse --show-toplevel` and `git branch --show-current` before anything.
- Prefix shell commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- Never print secrets; never `cat` `.env` files, `~/.npmrc` or credential files.
- No em dashes. A test enforces this for every published document.
- Test first: a failing test that states the finding, then the fix, then the test passes.
- The SDK's public surface is settled for the first release (ADR-056). Every addition
  here is additive and optional, and each one is listed in ADR-060 (Task 1). Nothing
  already released changes shape.
- Docker: unique compose project names, unused ports, never 8080, never the `frdogfood`
  or `leadline` stacks or the volume `frdogfood_postgres-data`.
- Commit per task, message ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Do not push or merge.

## Batch A: decisions (do first, everything else cites them)

### Task 1: ADR-060, the SDK gains what the dogfood run needed

**Files:** Modify `docs/DECISIONS.md`, `AGENTS.md` if a rule changes.

- [ ] **Step 1: Write ADR-060** in the file's existing format (read ADR-056 and ADR-059
  for the shape). It covers the additive SDK options this plan adds, each with the
  finding that asked for it:
  - `identify(values, { name })`, so two services identifying one record do not both
    record a step called `identify` (F-001).
  - `deployment: { version?, gitCommit?, image? }` on the recorder, applied to every
    event, because the wire protocol carries it and no Node service could set it (F-002).
  - `metadataFrom: (result) => Record<string, unknown>` on the wrappers, because
    `metadata` is fixed before the callback runs, so an HTTP status or `Retry-After`
    cannot be metadata (F-003).
  - `isFailure` may return a reason (`{ message, code }` or `string`), so a failed
    result does not always record the same generic error (F-004).
  - `continueJourney` derives the journey id from the entity when a secret is
    configured and neither a context nor an id is given (F-005).
  - A no-context payload envelope type the SDK itself satisfies without a cast (F-014).
  - Wrapper call signatures a second implementation can satisfy without a cast (F-021).
  State plainly that these are additions, that no existing call changes meaning, and
  that the surface is settled again once they land.
- [ ] **Step 2: Run** `pnpm exec vitest run tests` (the ADR count and format tests).
  Expected: PASS after updating the README's ADR count.
- [ ] **Step 3: Commit** (`docs(adr): ADR-060, the SDK options the dogfood run asked for`).

### Task 2: ADR-061, a retried step that succeeds is a completion

**Files:** Modify `docs/DECISIONS.md`.

- [ ] **Step 1: Read F-008 and the code it names:**
  `packages/database/src/repositories/journeys.ts` (the status case around lines 220 to
  224 and `deriveStatus` around 257 to 261), and `packages/sdk-node/src/recorder.ts`'s
  `wrap()` (ADR-022, the `attempt` rename around lines 1282 to 1287).
- [ ] **Step 2: Write ADR-061.** The decision: a `retried` event that carries no error
  counts as a completion for journey status, the same way `completed` does, so a step
  that fails and then succeeds no longer leaves the journey failed until `finish()`
  lands. The event keeps the operation `retried`, because that is what happened
  (ADR-022 is unchanged). Record the alternative rejected: renaming a successful retry
  to `completed`, which would lose the fact that it was a retry.
  Consequences: `deriveStatus` and the status case both change, the ordering rules do
  not, and a journey whose last event is a failed retry is still failed.
- [ ] **Step 3: Commit** (`docs(adr): ADR-061, a successful retry completes a journey`).

## Batch B: the Node SDK

Each task is a failing test, then the change, then the test passes. Read the finding
first. The SDK's README documents every new option in the section that already covers
its neighbour.

### Task 3: A rejected setting is never silent (F-010)

**Files:** `packages/sdk-node/src/config.ts`, `recorder.ts`, `diagnostics.ts`, their tests.

- [ ] **Step 1: Failing test.** With `logDiagnostics: false` and no `onDiagnostic`, a
  rejected non-required setting prints exactly one console line naming the setting, and
  `counters()` reports which settings were rejected (a list of names, not only a count).
- [ ] **Step 2: Implement.** `problem()` stops gating the one-line print on `required`;
  `counters()` gains the rejected setting names. Keep the once-per-process rule.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/sdk-node`. Expected: PASS.
- [ ] **Step 4: Commit.**

### Task 4: Naming an identify step, and a deployment on every event (F-001, F-002)

**Files:** `packages/sdk-node/src/types.ts`, `recorder.ts`, `config.ts`, their tests,
`packages/sdk-node/README.md`.

- [ ] **Step 1: Failing tests.** `identify(values, { name: "identify-crm" })` records a
  step with that name, and the default stays `identify`. A recorder configured with
  `deployment: { version, gitCommit }` sends it on every event, and the server stores it
  (check `packages/protocol` for the field's shape and validation first).
- [ ] **Step 2: Implement**, then document both in the README.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/sdk-node packages/protocol`.
- [ ] **Step 4: Commit.**

### Task 5: Metadata from a result, and a reason on a failed result (F-003, F-004)

**Files:** `packages/sdk-node/src/recorder.ts`, `types.ts`, tests, README.

- [ ] **Step 1: Failing tests.** `deliver(name, input, fn, { metadataFrom })` records
  metadata computed from the result, merged over any static `metadata`, and a throwing
  `metadataFrom` cannot break the call (the SDK's failure-isolation rule). `isFailure`
  returning `{ message, code }` puts that message and code on the recorded error, and
  returning `true` keeps today's generic text.
- [ ] **Step 2: Implement.** Keep both options optional and additive.
- [ ] **Step 3: Run** `pnpm exec vitest run packages/sdk-node`.
- [ ] **Step 4: Commit.**

### Task 6: A derived journey id, and types a second implementation can satisfy (F-005, F-014, F-021)

**Files:** `packages/sdk-node/src/recorder.ts`, `propagation.ts`, `types.ts`, tests, README.

- [ ] **Step 1: Failing tests.**
  - `continueJourney({ entity })` with a `journeyIdSecret` configured and no context and
    no id uses `journeyIdFor(entity)` rather than a random id; with no secret it still
    starts a new journey, and that stays documented.
  - The no-context envelope value type-checks against its own type with no cast (a
    type-level test; see how the repo tests types elsewhere, or `expectTypeOf`).
  - A plain, non-overloaded function satisfies each wrapper's type, so a second
    implementation needs no cast. Prove it with a small object that implements
    `JourneyOperations` without casts.
- [ ] **Step 2: Implement.** For the wrappers, prefer one signature over
  `T | PromiseLike<T>` with a conditional return type; if that loses inference for
  callers, export a non-overloaded alias instead and say why in the README.
- [ ] **Step 3: Run** `pnpm typecheck` and `pnpm exec vitest run packages/sdk-node`.
- [ ] **Step 4: Commit.**

### Task 7: Personal data in labels and displayable aliases (F-006, F-012)

**Files:** `packages/sdk-node/src/` (the secret-name warning's neighbourhood),
`packages/payload-security/` if the shape check belongs there, tests, README,
`docs/SDK_SPEC.md`.

- [ ] **Step 1: Read ADR-055** (a secret-looking name is warned about, never redacted on
  a guess) and follow its pattern exactly: warn once per process and value shape, never
  change the value.
- [ ] **Step 2: Failing tests.** A label or a displayable alias that looks like an email
  address or a phone number raises one `personal_data_in_public_value` diagnostic naming
  the field, once per process and kind; a value that looks like neither raises nothing;
  the value is never altered. Keep the false-positive rate honest: match an email shape
  and an international phone shape, nothing cleverer.
- [ ] **Step 3: Implement**, document in the README next to the label rule and in
  `docs/SDK_SPEC.md` as a SHOULD for other implementations.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/sdk-node packages/payload-security`.
- [ ] **Step 5: Commit.**

## Batch C: the server, the API and its documentation

### Task 8: A successful retry completes a journey (F-008, ADR-061)

**Files:** `packages/database/src/repositories/journeys.ts`, its integration tests.

- [ ] **Step 1: Failing integration test.** A journey whose step fails on attempt 1 and
  succeeds as `retried` on attempt 2, with no `finish()`, reads as completed; a journey
  whose retry also fails stays failed; the existing out-of-order failure test still
  passes.
- [ ] **Step 2: Implement** in `deriveStatus` and the status case, citing ADR-061.
- [ ] **Step 3: Run** the database integration tests (Testcontainers).
- [ ] **Step 4: Commit.**

### Task 9: Narrowing a search (F-028)

**Files:** `apps/api/src/routes/` (the search route), `packages/database/src/repositories/`,
`docs/API_SPEC.md`, tests.

- [ ] **Step 1: Read F-028 and `docs/API_SPEC.md` sections 5 and 6.** `/v1/journeys`
  requires `since`; `/v1/search` has no window at all, so a repeated alias value returns
  every journey that ever used it.
- [ ] **Step 2: Failing tests.** `/v1/search` accepts optional `since`, `until` and
  `environment`, refuses unknown keys the way its neighbours do, and returns only
  matches inside the window. Without them it behaves exactly as it does today, so no
  caller breaks.
- [ ] **Step 3: Implement**, including the index question: check the query plan for the
  filtered search on a seeded database and say in the report whether an index is needed
  (do not add one without evidence).
- [ ] **Step 4: Document** in `docs/API_SPEC.md` section 5, and say plainly that without
  a window the search spans the project's whole history.
- [ ] **Step 5: Run** unit and integration tests.
- [ ] **Step 6: Commit.**

### Task 10: The API says what it is running (F-007)

**Files:** `apps/api/src/routes/health.ts`, `apps/api/Dockerfile` or the build, tests,
`docs/API_SPEC.md`, `docs/OPERATIONS.md`.

- [ ] **Step 1: Decide the source of the value.** The image already knows its tag; check
  how `WAYSCRIBE_VERSION` and the build args flow (`scripts/publish-image.sh`, the
  Dockerfiles). Prefer a build arg baked in, falling back to the package version, never
  a runtime shell-out to git.
- [ ] **Step 2: Failing test.** `/ready` reports `version` and, when known, the commit.
  `/health` stays a bare liveness check, because a load balancer hits it often.
- [ ] **Step 3: Implement, document, run the tests.**
- [ ] **Step 4: Commit.**

### Task 11: Where a lone surrogate is repaired (F-024)

**Files:** likely none; a written answer plus one test.

- [ ] **Step 1: Find out** whether the repair happens at ingest (stored already
  repaired) or at read time (a raw lone surrogate could still sit in PostgreSQL). Write
  an integration test that sends one and reads the stored row directly.
- [ ] **Step 2: If the stored value keeps the lone surrogate,** decide with evidence
  whether that is a problem for other readers (psql, a dump, another client) and record
  the answer in `docs/INGESTION_CONTRACT.md`. If the repair happens at ingest, document
  that instead. Either way the behaviour is documented rather than left to be discovered.
- [ ] **Step 3: Keep the test** as the record of what the server does.
- [ ] **Step 4: Commit.**

### Task 12: API documentation corrections (F-013, F-025)

**Files:** `docs/API_SPEC.md`.

- [ ] **Step 1: Section 1** says reads need the admin token; section 6 and
  `apps/api/src/principal.ts` say an API key may read its own environment. Correct
  section 1.
- [ ] **Step 2: Section 8's** example item omits `receivedAt`, which the endpoint always
  sends and which the section's own ordering rule names. Add it.
- [ ] **Step 3: Check every other example in the file** against the route that serves it,
  and report any further gap rather than fixing it silently.
- [ ] **Step 4: Run** `pnpm exec vitest run tests`. Commit.

## Batch D: the CLI, the install paths and the rest of the documentation

### Task 13: doctor reads the key from the environment (F-011)

**Files:** `packages/database/src/doctor.ts`, `cli.ts`, tests, `docs/OPERATIONS.md`.

- [ ] **Step 1: Failing test.** `doctor` takes the key from `WAYSCRIBE_API_KEY` when
  `--api-key` is absent; the flag still works and wins; the usage text says so.
- [ ] **Step 2: Implement**, and add a line to `docs/OPERATIONS.md` section 12 saying a
  key passed as a flag is visible in the container's process list, so the environment
  variable is the safer route.
- [ ] **Step 3: Run** the database tests. Commit.

### Task 14: A machine-readable key (F-016)

**Files:** `packages/database/src/cli.ts`, tests, `docs/OPERATIONS.md`.

- [ ] **Step 1: Failing test.** `key:create --json` prints one JSON object with the key
  and its prefix and nothing else, so a script needs no parsing by position. The human
  form is unchanged without the flag.
- [ ] **Step 2: Implement, document, test.** Commit.

### Task 15: The published stack is configurable and starts cleanly (F-015, F-017, F-022)

**Files:** `infrastructure/compose.published.yaml`, `apps/api/Dockerfile`,
`apps/web/Dockerfile`, `infrastructure/compose*.yaml`, `docs/OPERATIONS.md`, tests.

- [ ] **Step 1: F-015.** `APP_URL` and `API_URL` read from the environment with the same
  localhost defaults, matching every other setting in that file.
- [ ] **Step 2: F-017 and F-022.** Add `--start-interval` to the API's health check, and
  give the web image a real `HEALTHCHECK` so `--wait` means the same thing for both
  containers. Measure a cold `up -d --wait` before and after and report both numbers:
  F-022 could not reproduce F-017's 30 second wait, so say what you actually observe.
- [ ] **Step 3: Test** what can be tested without Docker (the compose files and
  Dockerfiles are already covered by tests; see `tests/`), then run a real cold start
  under a unique project name and report the timings.
- [ ] **Step 4: Commit.**

### Task 16: Secrets in the container's environment (F-023)

**Files:** `docs/OPERATIONS.md`, `docs/SECURITY.md`, possibly
`packages/config/src/schema.ts` and the compose files.

- [ ] **Step 1: Document the trade-off** next to the settings table: with the Compose
  paths, `ENCRYPTION_KEY` and `ADMIN_TOKEN` are ordinary container environment
  variables, so anyone with Docker access to the host can read them, which is equivalent
  to holding the encryption key. Helm already avoids this with `existingSecret`.
- [ ] **Step 2: Then implement `ENCRYPTION_KEY_FILE` and `ADMIN_TOKEN_FILE`**: when set,
  the value is read from that file at startup, the plain variable stays supported, and
  giving both is a refusal. Failing test first (config schema and startup), then the
  code, then document it in the settings table and in `docs/SECURITY.md`.
- [ ] **Step 3: Run** the config and startup tests. Commit.

### Task 17: The rest of the documentation (F-018, F-020, F-026, F-027, F-019)

**Files:** `packages/sdk-node/README.md`, `docs/SECURITY.md`, `docs/ROADMAP.md`.

- [ ] **Step 1: F-018.** The SDK README's `pack:release` example uses `pnpm --silent`, so
  capturing stdout gives the tarball path alone.
- [ ] **Step 2: F-020.** A line next to the redaction rules saying a diff holds a changed
  value twice, before and after, so personal data in a payload appears twice.
- [ ] **Step 3: F-026.** Document in `RecorderConfig`'s options and the README that the
  unredacted-secret-name warning always prints once per process and name, whatever
  `logDiagnostics` and `onDiagnostic` say, and why. Behaviour unchanged.
- [ ] **Step 4: F-027 and F-019.** In the roadmap's metadata vocabulary item, write down
  what is still undecided: a queue wait that cannot be measured must be marked, not
  defaulted to zero, and a retried attempt's wait is not comparable to a first attempt's.
- [ ] **Step 5: Run** `pnpm exec vitest run tests` and the site build. Commit.

## After the batches (controller)

1. Review each batch, merge to main in order A, B, C, D, watch CI including the manual
   e2e, demo and upgrade jobs.
2. Tell the Leadline session which findings are fixed and what changed, so the second
   dogfood run exercises them.
3. Findings deliberately not fixed: F-009 (millisecond ordering, documented and
   reasonable), F-019 and F-027 (the metadata vocabulary itself, which is L20 work),
   F-024 beyond documenting it, and F-028's Leadline-side filter, which is Leadline's.
