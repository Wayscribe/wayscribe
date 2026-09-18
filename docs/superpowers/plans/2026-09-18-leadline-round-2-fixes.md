# Leadline Round 2 Fix Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix what Leadline's second dogfood run found (F-029 to F-045), and remove the
flaky tests that cost the last pass twice.

**Architecture:** Six batches on their own branches. A decision record first, then the
SDK, the server and API, the CLI, the web app, and the test suite's stability. The web
batch builds on the API batch's new response fields, and the stability batch runs after
the SDK batch, because both touch SDK tests.

**Tech Stack:** TypeScript pnpm monorepo on Node 24, Fastify, Next.js 15, Knex,
Vitest, Playwright, Testcontainers, Docker Compose, GitLab CI.

**Source:** Leadline's `FINDINGS.md` on its published main,
`git -C ~/workspace/leadline show origin/main:FINDINGS.md`, F-029 to F-045, written
against Wayscribe `dcd4fea`. Read an entry before changing anything it names: each one
states what was measured, what was expected, and what Leadline did instead. F-044 and
F-045 were confirmed by Jorge in the web app by hand.

---

## Ground rules for every batch

- Work in the worktree the controller gives you. Verify with
  `git rev-parse --show-toplevel` and `git branch --show-current` before anything.
- Prefix shell commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- Never print secrets; never `cat` `.env` files, `~/.npmrc` or credential files.
- No em dashes. A test enforces this for every published document.
- Test first, and prove the test: after it passes, break the code it covers in a scratch
  copy and confirm the test fails for the reason its name gives. The dominant defect
  class this project keeps finding is a test that cannot fail for its stated reason.
- **Every doc comment and document you touch is checked against the code it describes.**
  Four of these findings (F-037, F-039, F-040, F-041) are sentences the last pass wrote
  that the code contradicts. Reviewers verify prose as rigorously as code.
- Docker: unique compose project names, unused ports, never 8080, never the `frdogfood`,
  `frleadline` or `leadline` stacks, never the volume `frdogfood_postgres-data`. Stop
  only processes you started. Docker builds from an agent shell can hang on the
  credential helper: use a `DOCKER_CONFIG` directory holding `{}` in `config.json` that
  links the `docker-buildx` and `docker-compose` plugins from
  `/Applications/Docker.app/Contents/Resources/cli-plugins/`.
- Stage by explicit path, never `git add -A`, and never run `pnpm -w format`, which
  rewrites another agent's work.
- Commit per task, message ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Do not push or merge.

## Batch A: the decision record

### Task 1: ADR-062, what the second run changed in the SDK's surface

**Files:** `docs/DECISIONS.md`, `README.md` (ADR count).

- [ ] Write ADR-062 in the file's format, covering these changes to the public surface
  before the first release, each with its finding:
  - `rejectedSettings` names the field that was refused, as a dotted path such as
    `deployment.version`, so a partial refusal and a total one differ (F-031). Whether
    the whole setting was dropped is readable without parsing prose.
  - Settings refused when the recorder is created are kept apart from options refused
    on a later call, so a correctly configured process never ends with a setting
    problem it did not have (F-038). Decide the shape (two lists, or a second counter)
    in the ADR and say why.
  - `deployment`: a whitespace-only field is refused as empty, and an empty
    `deployment` object is reported rather than accepted in silence (F-031).
  - `hasJourney` accepts `unknown` (F-034), matching what its documentation and its
    implementation already do.
  - A failure message that looks like personal data raises the same once-per-process
    warning a label or a displayable alias does (F-041), following ADR-055's pattern:
    warn, never alter the value.
- [ ] Run `pnpm exec vitest run tests` and `cd site && pnpm build`. Commit.

## Batch B: the Node SDK

### Task 2: `rejectedSettings` names the field, and creation stays apart from calls (F-031, F-038)

- [ ] Failing tests for every row of F-031's table and F-038's sequence, then implement
  ADR-062's shape. The whitespace-only `gitCommit` and the empty `deployment` cases are
  included.

### Task 3: `hasJourney(value: unknown)` (F-034)

- [ ] A type test that a body typed `unknown` compiles with no cast and narrows to
  `ContextEnvelope<T>`, and the existing runtime tests still pass. Document plainly that
  `false` covers both "not an envelope" and "an envelope with no journey", since F-034
  shows a caller needs to know that.

### Task 4: The documentation the last pass got wrong (F-037, F-039, F-040, F-041)

- [ ] `WrapResult`: say which cast went away (the assignment's) and which remains (the
  implementation's own return) (F-037).
- [ ] `ContinueJourneyOptions`: name all four steps of the id's resolution, the
  derivation included (F-039).
- [ ] `metadataFrom`: runs on the resolved value whether or not `isFailure` calls it a
  failure, and not when the callback throws or rejects; and what "once per journey"
  means under `across()` (F-040).
- [ ] `FailureReason`: masking covers credential shapes and does not remove personal
  data (F-041).
- [ ] Add a test per sentence where the claim is checkable (for example, that
  `metadataFrom` runs on a result `isFailure` rejects), so each statement is pinned to
  behaviour rather than trusted.

### Task 5: The personal-data warning covers failure messages (F-041)

- [ ] Extend the existing check to a `FailureReason` message and an error's message,
  once per process and shape, never altering the value. Follow the label warning's
  code path; do not add a second mechanism.

## Batch C: the server and API

### Task 6: `limit` follows the rules every other parameter follows (F-029)

- [ ] `limit` given twice is refused (`limit may be given once.`), a NUL in it is
  refused, on both `/v1/journeys` and `/v1/search`. Decide, and document, whether a
  nonsense value (`abc`, `0`, `-1`) is refused or keeps clamping to the default: the
  finding argues refusal fits an endpoint that now refuses a misspelt key. Measure
  every row of the finding's table after the change.

### Task 7: A refusal that states the real rule (F-035)

- [ ] The future-`since` message names the 60-second tolerance, in the style of the
  format message. Guard it with a docs-truth or unit test tying the message to the
  constant.

### Task 8: Search rows carry their environment (F-036, API half)

- [ ] `SearchItem` gains `environment`, the way `JourneySummary` has it. Document in
  `docs/API_SPEC.md` section 5, and extend the section's docs-truth guard.

### Task 9: An identified event shows what it identified (F-042)

- [ ] Find where aliases are stored and whether they are linked to the event that
  stated them. If they are, return the aliases an `identified` event stated on
  `GET /v1/events/:id`, masked exactly as the journey detail masks them (displayable
  in full, otherwise masked). If they are not linked, an additive migration is
  allowed, following `docs/DECISIONS.md` and the concurrent-index pattern of migration
  019; say what you chose and why.

### Task 10: The builds behind a journey (F-043)

- [ ] The timeline row (`GET /v1/journeys/:id/events`) carries the event's deployment,
  or the journey detail lists its distinct builds beside `services`. Pick one, measure
  the query cost on a seeded database, and document it.

## Batch D: the CLI

### Task 11: `doctor` says when it did not check the key (F-032)

- [ ] An empty `WAYSCRIBE_API_KEY` produces `SKIP  API key` with a reason naming the
  empty variable, the way other unrunnable checks do, rather than vanishing.

### Task 12: `--help`, and a usage line that names the real invocation (F-033)

- [ ] `--help` for the CLI and for each command, listing flags, including
  `key:create --json` and the four fields it prints. The usage line names the
  invocation that works where it runs (the image runs `node packages/database/dist/cli.js`;
  a checkout runs the package script). Check every documented invocation in
  `docs/OPERATIONS.md` against what the image contains.

## Batch E: the web app

### Task 13: The web app refuses to start misconfigured (F-030)

- [ ] Validate configuration once at startup (Next.js `instrumentation.ts` `register`
  is the natural place; confirm it runs in the standalone image), and exit with the
  existing specific message. The container's health check probes a route that reads
  configuration, so "healthy" means configured. Measure the three cases in F-030's
  table on real containers, before and after.

### Task 14: Event metadata on screen (F-044)

- [ ] The event detail shows `customMetadata`, `deploymentMetadata` and
  `runtimeMetadata` as a plain key and value list, under the existing CSP, escaped as
  text. The API already returns them.

### Task 15: The version on screen (F-045)

- [ ] The web app shows the running version and commit, read from the API's `/ready`,
  and its own version, so a partial upgrade is visible.

### Task 16: Search narrows in the browser (F-036, web half)

- [ ] The search box can narrow by time window and environment using the API's
  `since`, `until` and `environment`, works without JavaScript like the rest of the
  app, and each row shows its environment.

## Batch F: test suite stability

### Task 17: No test fails because the machine is busy

- [ ] Find every wall-clock assertion in unit tests (for example the masking test's
  10 ms bound and the SDK's overhead ratio test) and replace each with something that
  measures the property without depending on load: an operation count, a complexity
  bound over input size, or a relative comparison run enough times to be stable. Keep
  a real performance check, but not one that fails on a loaded runner.
- [ ] The integration suite's Testcontainers startup budget: find where the 10 s
  port-binding timeout comes from and make it tolerant of a loaded host, and consider
  reusing one PostgreSQL container per worker rather than one per file.
- [ ] Prove each change with a stressed run (run the suite while the machine is busy,
  for example alongside a Docker build) and report before and after failure counts.

## After the batches (controller)

1. Review each batch, merge in order A, B, C, D, E, F, watch CI including the manual
   jobs, and gate each push on an explicit pass count rather than a command chain.
2. Write the round 2 hand-off for Leadline, listing each finding's outcome.
3. Tell Jorge the web app changes are ready for his walkthrough.
