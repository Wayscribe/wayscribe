# Implementation Tasks

This checklist is ordered to produce a working vertical slice early.

**State as of 2026-08-07.** Epics 0 through 12 are complete and merged; the boxes
below were audited against the code rather than ticked from memory. What remains
for V0 is Epic 13 (replay), Epic 14 (retention and operations), and Epic 15
(release readiness), plus the handful of items left open inside earlier epics.

## Product gates applied to every epic

Standing constraints, re-checked as each epic lands, rather than work that is
ever finished.

- [x] Preserve the free, fully useful self-hosted core.
- [x] Keep PostgreSQL as the only required backing service. ElasticMQ is demo-only
      and lives in a separate Compose file (ADR-015).
- [x] Do not add a mandatory external account, cloud service, observability platform, or AI provider.
- [x] Keep the default path understandable to a developer without tracing expertise.
- [ ] Measure impact on the approximately 15-minute time-to-first-journey target.
      Not measurable until images are published; see Epic 15.
- [x] Preserve record-first navigation, aliases, transformation diffs, and
      existing-architecture support. Journey-linked safe replay is Epic 13.

## Epic 0: Repository foundation

- [x] Create repository.
- [x] Select and add an established open-source license.
- [x] Document that the self-hosted core is free to use.
- [x] Pin Node.js active LTS.
- [x] Pin pnpm version.
- [x] Create pnpm workspace.
- [x] Add root scripts.
- [x] Add shared TypeScript config.
- [x] Add lint and formatting config.
- [x] Create `apps/api`.
- [x] Create `apps/web`.
- [x] Create package directories.
- [x] Add PostgreSQL Compose service.
- [x] Confirm PostgreSQL is the only required backing service.
- [x] Add one-command local Compose startup.
- [x] Add API and web Compose services.
- [x] Add `/health`.
- [x] Add `/ready`.
- [x] Add CI for format, lint, type check, and unit tests.
- [ ] Run a clean-machine onboarding check.

## Epic 1: Protocol

- [x] Create `protocolVersion` constant.
- [x] Define operation enum.
- [x] Define entity schema.
- [x] Define alias schema.
- [x] Define error schema.
- [x] Define runtime metadata schema.
- [x] Define deployment metadata schema.
- [x] Define journey event schema.
- [x] Define envelope schema.
- [x] Add valid minimal fixture.
- [x] Add valid complete fixture.
- [x] Add invalid fixtures.
- [x] Add protocol tests.
- [x] Document compatibility rules.

## Epic 2: Database

- [x] Configure Knex.
- [x] Add projects migration.
- [x] Add environments migration.
- [x] Add API keys migration.
- [x] Add journeys migration.
- [x] Add entity aliases migration.
- [x] Add journey events migration.
- [x] Add replay destinations migration.
- [x] Add replay runs migration.
- [x] Add audit events migration.
- [x] Add indexes.
- [x] Add local project and environment seed.
- [x] Add migration integration tests.
- [x] Add reset script.

## Epic 3: Security primitives

- [x] Define capture modes.
- [x] Implement payload size calculator.
- [x] Implement JSON depth and key limits.
- [x] Implement path-based redaction.
- [x] Add default secret paths.
- [x] Implement alias normalization.
- [x] Implement HMAC search token.
- [x] Implement API-key generation.
- [x] Implement API-key verification.
- [x] Add security tests.
- [x] Ensure logs omit secrets.

## Epic 4: Event ingestion

- [x] Add API-key authentication hook.
- [x] Implement `POST /v1/events`.
- [x] Validate protocol version.
- [x] Enforce project and environment.
- [x] Enforce request limits.
- [x] Apply server redaction.
- [x] Insert event transactionally.
- [x] Create journey if missing.
- [x] Update journey summary.
- [x] Upsert aliases.
- [x] Return idempotent duplicate result.
- [x] Implement conflicting duplicate policy.
- [x] Implement `POST /v1/events/batch`.
- [x] Return per-event batch results.
- [x] Add ingestion tests.

## Epic 5: Query API

- [x] Implement journey repository.
- [x] Implement event repository.
- [x] Implement alias search.
- [x] Implement technical ID search.
- [x] Add `GET /v1/search`.
- [x] Add `GET /v1/journeys/:id`.
- [x] Add `GET /v1/journeys/:id/events`.
- [x] Add `GET /v1/events/:id`.
- [x] Add cursor pagination.
- [x] Add project-isolation tests.
- [x] Add deterministic ordering tests.

## Epic 6: Payload diff

- [x] Define diff output schema.
- [x] Compare primitive values.
- [x] Compare objects.
- [x] Compare arrays with documented policy.
- [x] Mark added fields.
- [x] Mark removed fields.
- [x] Mark changed fields.
- [x] Support ignored paths.
- [x] Handle redacted values.
- [x] Enforce complexity limits.
- [x] Add comprehensive tests.
- [x] Store or derive diff according to performance decision.

## Epic 7: Web UI

- [x] Add application shell.
- [x] Add entity-first search page.
- [x] Ensure primary search does not require trace terminology.
- [x] Add search results.
- [x] Add journey header.
- [x] Add chronological timeline.
- [x] Add operation and status display.
- [x] Add event detail panel or page.
- [x] Add payload JSON viewer.
- [x] Add transformation-focused diff viewer.
- [x] Add error display.
- [x] Add alias display and identity-map summary.
- [ ] Add loading and empty states.
- [ ] Add plain-language explanations for journey, alias, transformation, and replay.
- [x] Add browser tests.

## Epic 8: Node SDK foundation

- [x] Create public package exports.
- [x] Define recorder config.
- [x] Define journey context.
- [x] Implement event ID generation.
- [x] Implement journey ID generation.
- [x] Implement `createRecorder`.
- [x] Implement `startJourney`.
- [x] Implement `continueJourney`.
- [x] Implement `record`.
- [x] Implement `identify`.
- [x] Implement client redaction.
- [x] Implement safe serialization.
- [x] Add SDK unit tests.
- [x] Create a minimal quick-start example requiring only initialization and one recorded operation.
- [x] Verify useful partial instrumentation before every service is instrumented.

## Epic 9: Node SDK wrappers

- [x] Implement `transform`.
- [x] Implement `persist`.
- [x] Implement `publish`.
- [x] Implement `consume`.
- [x] Implement `deliver`.
- [x] Implement `fail`.
- [x] Implement `finish`.
- [x] Preserve callback return values.
- [x] Preserve callback errors.
- [x] Capture duration.
- [x] Capture optional active trace context.
- [x] Add wrapper tests.

## Epic 10: SDK transport reliability

- [x] Implement bounded queue.
- [x] Implement batch flush.
- [x] Implement interval flush.
- [x] Implement explicit flush.
- [x] Implement transport timeout.
- [x] Implement capped retry.
- [x] Add jitter.
- [x] Implement circuit breaker.
- [x] Add dropped-event diagnostics.
- [x] Implement graceful shutdown.
- [x] Test recorder outage.
- [x] Test full buffer.
- [x] Test shutdown timeout.

## Epic 11: Propagation

- [x] Define HTTP header names.
- [x] Implement HTTP injection.
- [x] Implement HTTP extraction.
- [x] Define SQS attribute names.
- [x] Implement SQS injection.
- [x] Implement SQS extraction.
- [x] Add optional payload envelope.
- [x] Ensure aliases are not propagated.
- [x] Add round-trip tests.
- [x] Add tampered-context tests.

## Epic 12: Demo workflow

- [x] Build source webhook simulator.
- [x] Build integration API.
- [x] Add customer table.
- [x] Implement defective transformation.
- [x] Persist customer.
- [x] Publish queue message.
- [x] Build worker.
- [x] Build target API.
- [x] Reject missing phone.
- [x] Add retry behavior.
- [x] Add dead-letter behavior.
- [x] Instrument all steps.
- [x] Add trigger script.
- [x] Verify search and timeline manually.
- [x] Automate the acceptance test (`pnpm test:demo`).
- [ ] Record time to first useful journey on a clean machine.

Deliberately uninstrumented: `demo-source` and `demo-target`. They stand in for
systems the team does not own, and a timeline covering only your own services is
the honest picture.

## Epic 13: Replay

- [ ] Implement replay destination repository.
- [ ] Implement destination API.
- [ ] Implement hostname allowlist.
- [ ] Implement URL resolution checks.
- [ ] Implement blocked-header filter.
- [ ] Implement request timeout.
- [ ] Implement response size limit.
- [ ] Implement replay creation API.
- [ ] Store sanitized request and response.
- [ ] Create audit event.
- [ ] Build replay preparation UI.
- [ ] Build replay result UI.
- [ ] Add original-versus-replay diff.
- [ ] Add SSRF and redirect tests.
- [ ] Add corrected demo endpoint.

## Epic 14: Retention and operations

- [x] Implement retention selection.
- [x] Implement bounded deletion.
- [x] Add cleanup metrics. One structured log line per sweep; ADR-012 rules out
      a metrics dependency, and the number is read while reading logs anyway.
- [x] Add backup documentation.
- [x] Add restore documentation.
- [x] Add structured logs.
- [x] Add basic internal metrics endpoint or diagnostics. Covered by `/health`,
      `/ready`, the retention log line, and the SDK's shutdown counters. A
      Prometheus endpoint is a V1 item.
- [x] Add readiness dependency checks.

## Epic 15: Release readiness

- [ ] Complete quick start.
- [x] Complete SDK docs.
- [x] Complete API docs.
- [x] Complete security docs.
- [x] Add contribution guide.
- [x] Add issue templates.
- [ ] Add release workflow.
- [ ] Publish `api` and `web` images to a container registry.
- [ ] Publish `@flight-recorder/node` to npm.
- [ ] Change the quick start to pull published images rather than build from source.
- [ ] Run security review.
- [ ] Run full E2E test.
- [ ] Test clean-machine installation.
- [ ] Verify no paid account or external hosted service is required.
- [ ] Verify first useful journey can be recorded in approximately 15 minutes,
      measured from a pulled image rather than a source build. Building two Node
      images consumes a meaningful share of that budget before the user sees
      anything, so the target is only honest against published artifacts.
- [ ] Verify record-first search, identity mapping, transformation diff, existing-architecture flow, and safe replay together.
- [ ] Conduct a clarity review with a developer unfamiliar with tracing tools.
- [ ] Tag first development release.

## Explicitly deferred

- [ ] Python SDK
- [ ] Go SDK
- [ ] automatic PostgreSQL CDC
- [ ] Kafka
- [ ] Kubernetes
- [ ] OTLP receiver
- [ ] S3 payload storage
- [ ] ClickHouse
- [ ] production replay
- [ ] automatic alias discovery
- [ ] contract drift detection
- [ ] MCP
- [ ] BYOK AI
