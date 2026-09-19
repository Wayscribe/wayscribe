# Per-record timing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the remaining per-record timing features and validate them in Leadline before release preparation.
**Architecture:** Interpret optional redacted metadata, add bounded list predicates, and render existing timestamps without inventing missing measurements.
**Tech Stack:** TypeScript, existing protocol/SDK, Fastify, Knex/PostgreSQL, Next.js, Vitest/Playwright.
**Spec:** `docs/superpowers/specs/2026-09-18-record-timing-design.md`

## Global Constraints

- Unknown is never zero; a measured zero stays zero.
- No new dependency/service, no production replay, no protocol version bump, no mutation of original events, no unredacted metadata path.
- Timestamp is operation start; journey span is lastEventAt minus startedAt.
- Retry waits need explicit readiness, retries need explicit grouping, and cross-clock elapsed values are qualified.
- Preserve caller attempt/status behavior, authorization scope, bounded pagination, no-JS navigation and host failure isolation.
- Only edit the timing worktree. Leadline changes belong to Task 4 after checking its instructions and state. No public release. No broad Docker cleanup. Disk is constrained; reuse installed packages and existing images.
- Follow TDD for meaningful behavior. Record red/green commands/results, run focused checks, commit exact changed files, and produce a report. Implementers do not spawn agents; the controller owns reviews.

## Task 1: Metadata contract and SDK helpers

**Files:** create `packages/protocol/src/timing-context.ts` and tests; update its index; create `packages/sdk-node/src/timing-metadata.ts` and tests; update SDK public exports and packed export tests as needed; update `docs/DECISIONS.md` (ADR-064), `docs/EVENT_PROTOCOL.md`, `docs/SDK_SPEC.md`, `docs/NODE_SDK_SPEC.md`, SDK README as appropriate.

- [ ] Read the spec's vocabulary and SDK helper sections, relevant current contracts and export/test conventions.
- [ ] Write failing tests for the parser: recognized fields, zero, bounds, invalid/redacted values, queueWaitBasis/attempt consistency, each-field independence, bounded host and retry identity. Implement the exported `TimingContext` and `timingContext(metadata)` parser (object containing only valid fields). Keep metadata wire acceptance unchanged; this is a presentation convention, not ingestion refusal. Any output schema artifacts must be generated, not hand-edited.
- [ ] Write failing tests and implement public `queueMetadata(job, options?)` and `httpMetadata(response, options?)` per spec, including throwing getters/proxies and field-local failure. Export structural types. `queueMetadata` derives collision-safe retryGroup from queueName/id if both fit; current attempt from attemptsMade+1. `httpMetadata` takes `response` with status and headers.get and options `{ targetUrl?, now? }`. Both return ordinary metadata compatible with current SDK calls.
- [ ] Document helper signatures, stable names and limitations; preserve wrapper-owned attempt precedence. Add contract/conformance coverage appropriate to metadata remaining arbitrary and ensure packaging exports work in ESM/CJS.
- [ ] Run focused protocol/SDK tests, typecheck and lint for changes. Self-review and commit. Report exact exports and test evidence for downstream tasks.

## Task 2: API timing projection and journey filters

**Files:** `packages/database/src/repositories/event-reads.ts`, `journey-list.ts`, corresponding integration tests; `apps/api/src/routes/journey-list-query.ts`, presenters/routes and tests; stored-response schemas/tests if affected; `docs/API_SPEC.md`, query sizing notes.

- [ ] Read the spec and Task 1 interfaces. Write failing tests for `minDurationMs`, `minStepDurationMs`, `inactiveBefore`, strict comparisons, invalid/repeated query values, contradictory status, boundary instants, zero/unknown durations, scope and pagination. Thresholds are integers 0..2,147,483,647.
- [ ] Implement bounded SQL predicates using existing summary timestamps and a project/journey-scoped event EXISTS. Keep required since and existing filters. inactiveBefore implies active and rejects a non-active explicit status or future cutoff.
- [ ] Add optional/additive `timingContext` and `recordedHost` to timeline rows and event details. Use Task 1 parser on already-redacted metadata. Project known JSON keys in SQL for lists rather than all arbitrary metadata. recordedHost is bounded redacted runtime.hostname. Do not expose payloads or other metadata on rows. Preserve existing detail customMetadata.
- [ ] Update public stored/read schemas and regenerate artifacts as needed, fixtures/presenters/tests/docs together. Compatibility: older clients ignore extra response fields, newer web treats missing fields as absent.
- [ ] Run focused unit and real PostgreSQL integration tests, query-plan measurements on representative data, typecheck/lint. Add an index only if measurements justify it. Do not change user's running databases; use session test resources. Self-review, commit, and report API shapes/evidence.

## Task 3: Journey and timeline timing UI

**Files:** `apps/web/src/lib/api.ts`, `event-display.ts`, `journey-filters.ts`, new timing presentation helpers/tests, journey pages, timeline/detail and journey-list components, CSS, component/e2e tests, user-facing documentation.

- [ ] Read the spec, existing SSR/client split and Task 2 response shapes. Add failing tests for duration span, true zero, missing duration, overlap, different/unknown clocks, explicit retry grouping, skipped/duplicate attempt numbers, partial pages and filtered timeline adjacency.
- [ ] Implement pure bounded presentation helpers and integrate timeline gap labels, measured queue context, attempt outcome/delays and per-step retry view. Base adjacency on the full loaded unfiltered timeline. Show loaded-scope limitations, preserve selection and keyboard/no-JS links. Handle old APIs without context.
- [ ] Add labelled operational context to event detail while retaining arbitrary metadata. Distinguish requested Retry-After from observed retry delay and first enqueue waits from retry readiness waits.
- [ ] Display recorded journey span on detail and Journeys table with explanatory wording.
- [ ] Extend GET filters with duration thresholds and active inactivity threshold; validate units/limits consistently, freeze inactiveBefore cutoff across page links, preserve filters through project/back/clear controls and describe filters in results/empty states. Warn invalid values instead of silently showing a seemingly filtered list.
- [ ] Run focused component/unit tests and browser tests (desktop, mobile, keyboard, no JS, pagination) against a local test stack, plus typecheck/lint. Self-review and commit. Record screenshots/evidence and docs changed.

## Task 4: Leadline dogfood and release integration

**Files:** Leadline recording timing helpers, metadata call sites, manifest timing summary/tests, scenario checks and FINDINGS/WAYSCRIBE_FIXES; Wayscribe roadmap/review report and release docs as evidence warrants.

- [ ] Inspect Leadline AGENTS, worktrees and git state. Use isolated work if required; never overwrite unrelated work.
- [ ] Repin/build the new SDK and adopt helpers/standard metadata in Leadline. Record HTTP status and Retry-After via metadataFrom, queue context via queueMetadata, explicit attempt/retryGroup identity. Make the manifest comparison obey the same unknown/first-attempt rules without using Wayscribe as its own oracle.
- [ ] Exercise happy path, backlog, retry/rate limit, slow step and active idle paths; add controlled invalid/missing broker timestamp coverage. Compare recorded evidence to source manifest and verify every new filter and UI presentation. Record measured zeros separately from unknowns and retries without readiness.
- [ ] Address findings through reviewed fixes. Run full appropriate regression tests, packed SDK Node versions, docs/site checks. Refresh release-readiness report and mark only verified roadmap items complete.
- [ ] Address the broker-redelivery finding from preparation: explicitly reported deliveryCount above 1 rules out an initial-enqueue wait even when attemptsMade is still zero. Update SDK/protocol interpretation and regression tests plus ADR/contracts, adopt BullMQ's actual attemptsStarted counter as caller-supplied deliveryCount in Leadline, and verify a controlled stalled delivery independently. UI must obey the same updated spec. Re-run covering SDK/runtime checks after the fix.
- [ ] Final whole-branch review, integrate verified work locally, then continue authorized delivery/CI, claims and demo assets. Keep public publication and genuinely human/account-only gates for Jorge. Do not claim a release or fresh verification that has not run on the resulting commit.
