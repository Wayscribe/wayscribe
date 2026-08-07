# Implementation Tasks

This checklist is ordered to produce a working vertical slice early.

## Product gates applied to every epic

- [ ] Preserve the free, fully useful self-hosted core.
- [ ] Keep PostgreSQL as the only required backing service.
- [ ] Do not add a mandatory external account, cloud service, observability platform, or AI provider.
- [ ] Keep the default path understandable to a developer without tracing expertise.
- [ ] Measure impact on the approximately 15-minute time-to-first-journey target.
- [ ] Preserve record-first navigation, aliases, transformation diffs, existing-architecture support, and journey-linked safe replay.

## Epic 0: Repository foundation

- [ ] Create repository.
- [ ] Select and add an established open-source license.
- [ ] Document that the self-hosted core is free to use.
- [ ] Pin Node.js active LTS.
- [ ] Pin pnpm version.
- [ ] Create pnpm workspace.
- [ ] Add root scripts.
- [ ] Add shared TypeScript config.
- [ ] Add lint and formatting config.
- [ ] Create `apps/api`.
- [ ] Create `apps/web`.
- [ ] Create package directories.
- [ ] Add PostgreSQL Compose service.
- [ ] Confirm PostgreSQL is the only required backing service.
- [ ] Add one-command local Compose startup.
- [ ] Add API and web Compose services.
- [ ] Add `/health`.
- [ ] Add `/ready`.
- [ ] Add CI for format, lint, type check, and unit tests.
- [ ] Run a clean-machine onboarding check.

## Epic 1: Protocol

- [ ] Create `protocolVersion` constant.
- [ ] Define operation enum.
- [ ] Define entity schema.
- [ ] Define alias schema.
- [ ] Define error schema.
- [ ] Define runtime metadata schema.
- [ ] Define deployment metadata schema.
- [ ] Define journey event schema.
- [ ] Define envelope schema.
- [ ] Add valid minimal fixture.
- [ ] Add valid complete fixture.
- [ ] Add invalid fixtures.
- [ ] Add protocol tests.
- [ ] Document compatibility rules.

## Epic 2: Database

- [ ] Configure Knex.
- [ ] Add projects migration.
- [ ] Add environments migration.
- [ ] Add API keys migration.
- [ ] Add journeys migration.
- [ ] Add entity aliases migration.
- [ ] Add journey events migration.
- [ ] Add replay destinations migration.
- [ ] Add replay runs migration.
- [ ] Add audit events migration.
- [ ] Add indexes.
- [ ] Add local project and environment seed.
- [ ] Add migration integration tests.
- [ ] Add reset script.

## Epic 3: Security primitives

- [ ] Define capture modes.
- [ ] Implement payload size calculator.
- [ ] Implement JSON depth and key limits.
- [ ] Implement path-based redaction.
- [ ] Add default secret paths.
- [ ] Implement alias normalization.
- [ ] Implement HMAC search token.
- [ ] Implement API-key generation.
- [ ] Implement API-key verification.
- [ ] Add security tests.
- [ ] Ensure logs omit secrets.

## Epic 4: Event ingestion

- [ ] Add API-key authentication hook.
- [ ] Implement `POST /v1/events`.
- [ ] Validate protocol version.
- [ ] Enforce project and environment.
- [ ] Enforce request limits.
- [ ] Apply server redaction.
- [ ] Insert event transactionally.
- [ ] Create journey if missing.
- [ ] Update journey summary.
- [ ] Upsert aliases.
- [ ] Return idempotent duplicate result.
- [ ] Implement conflicting duplicate policy.
- [ ] Implement `POST /v1/events/batch`.
- [ ] Return per-event batch results.
- [ ] Add ingestion tests.

## Epic 5: Query API

- [ ] Implement journey repository.
- [ ] Implement event repository.
- [ ] Implement alias search.
- [ ] Implement technical ID search.
- [ ] Add `GET /v1/search`.
- [ ] Add `GET /v1/journeys/:id`.
- [ ] Add `GET /v1/journeys/:id/events`.
- [ ] Add `GET /v1/events/:id`.
- [ ] Add cursor pagination.
- [ ] Add project-isolation tests.
- [ ] Add deterministic ordering tests.

## Epic 6: Payload diff

- [ ] Define diff output schema.
- [ ] Compare primitive values.
- [ ] Compare objects.
- [ ] Compare arrays with documented policy.
- [ ] Mark added fields.
- [ ] Mark removed fields.
- [ ] Mark changed fields.
- [ ] Support ignored paths.
- [ ] Handle redacted values.
- [ ] Enforce complexity limits.
- [ ] Add comprehensive tests.
- [ ] Store or derive diff according to performance decision.

## Epic 7: Web UI

- [ ] Add application shell.
- [ ] Add entity-first search page.
- [ ] Ensure primary search does not require trace terminology.
- [ ] Add search results.
- [ ] Add journey header.
- [ ] Add chronological timeline.
- [ ] Add operation and status display.
- [ ] Add event detail panel or page.
- [ ] Add payload JSON viewer.
- [ ] Add transformation-focused diff viewer.
- [ ] Add error display.
- [ ] Add alias display and identity-map summary.
- [ ] Add loading and empty states.
- [ ] Add plain-language explanations for journey, alias, transformation, and replay.
- [ ] Add browser tests.

## Epic 8: Node SDK foundation

- [ ] Create public package exports.
- [ ] Define recorder config.
- [ ] Define journey context.
- [ ] Implement event ID generation.
- [ ] Implement journey ID generation.
- [ ] Implement `createRecorder`.
- [ ] Implement `startJourney`.
- [ ] Implement `continueJourney`.
- [ ] Implement `record`.
- [ ] Implement `identify`.
- [ ] Implement client redaction.
- [ ] Implement safe serialization.
- [ ] Add SDK unit tests.
- [ ] Create a minimal quick-start example requiring only initialization and one recorded operation.
- [ ] Verify useful partial instrumentation before every service is instrumented.

## Epic 9: Node SDK wrappers

- [ ] Implement `transform`.
- [ ] Implement `persist`.
- [ ] Implement `publish`.
- [ ] Implement `consume`.
- [ ] Implement `deliver`.
- [ ] Implement `fail`.
- [ ] Implement `finish`.
- [ ] Preserve callback return values.
- [ ] Preserve callback errors.
- [ ] Capture duration.
- [ ] Capture optional active trace context.
- [ ] Add wrapper tests.

## Epic 10: SDK transport reliability

- [ ] Implement bounded queue.
- [ ] Implement batch flush.
- [ ] Implement interval flush.
- [ ] Implement explicit flush.
- [ ] Implement transport timeout.
- [ ] Implement capped retry.
- [ ] Add jitter.
- [ ] Implement circuit breaker.
- [ ] Add dropped-event diagnostics.
- [ ] Implement graceful shutdown.
- [ ] Test recorder outage.
- [ ] Test full buffer.
- [ ] Test shutdown timeout.

## Epic 11: Propagation

- [ ] Define HTTP header names.
- [ ] Implement HTTP injection.
- [ ] Implement HTTP extraction.
- [ ] Define SQS attribute names.
- [ ] Implement SQS injection.
- [ ] Implement SQS extraction.
- [ ] Add optional payload envelope.
- [ ] Ensure aliases are not propagated.
- [ ] Add round-trip tests.
- [ ] Add tampered-context tests.

## Epic 12: Demo workflow

- [ ] Build source webhook simulator.
- [ ] Build integration API.
- [ ] Add customer table.
- [ ] Implement defective transformation.
- [ ] Persist customer.
- [ ] Publish queue message.
- [ ] Build worker.
- [ ] Build target API.
- [ ] Reject missing phone.
- [ ] Add retry behavior.
- [ ] Add dead-letter behavior.
- [ ] Instrument all steps.
- [ ] Add trigger script.
- [ ] Verify search and timeline manually.
- [ ] Record time to first useful journey on a clean machine.

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

- [ ] Implement retention selection.
- [ ] Implement bounded deletion.
- [ ] Add cleanup metrics.
- [ ] Add backup documentation.
- [ ] Add restore documentation.
- [ ] Add structured logs.
- [ ] Add basic internal metrics endpoint or diagnostics.
- [ ] Add readiness dependency checks.

## Epic 15: Release readiness

- [ ] Complete quick start.
- [ ] Complete SDK docs.
- [ ] Complete API docs.
- [ ] Complete security docs.
- [ ] Add contribution guide.
- [ ] Add issue templates.
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
