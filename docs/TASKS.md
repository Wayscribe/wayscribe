# Implementation Tasks

This checklist is ordered to produce a working vertical slice early.

**State as of 2026-09-20.** Epics 0 through 14 are implemented and merged; the
boxes below were audited against the code and committed review evidence rather
than ticked from memory. The 0.1.0 preview is published. What remains for V0 is
the human evidence for clean-machine onboarding, time to first journey,
first-contact clarity and outside-pilot feedback.

## Product gates applied to every epic

Standing constraints, re-checked as each epic lands, rather than work that is
ever finished.

- [x] Preserve the free, fully useful self-hosted core.
- [x] Keep PostgreSQL as the only required backing service. ElasticMQ is demo-only
      and lives in a separate Compose file (ADR-015).
- [x] Do not add a mandatory external account, cloud service, observability platform, or AI provider.
- [x] Keep the default path understandable to a developer without tracing expertise.
- [ ] Measure impact on the approximately 15-minute time-to-first-journey target.
      The automated public install took 35 seconds on an existing prepared host,
      which is not an unaided human timing trial; see Epic 15.
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
- [x] Add empty states.
- [x] Add loading feedback for sent forms and followed links (needs JavaScript; pages are not streamed, so they work without it).
- [x] Add plain-language explanations for journey, alias, transformation, and replay.
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

- [x] Implement replay destination repository.
- [x] Implement destination API.
- [x] Implement hostname allowlist.
- [x] Implement URL resolution checks.
- [x] Implement blocked-header filter.
- [x] Implement request timeout.
- [x] Implement response size limit.
- [x] Implement replay creation API.
- [x] Store sanitized request and response.
- [x] Create audit event.
- [x] Build replay preparation UI.
- [x] Build replay result UI.
- [x] Add original-versus-replay diff.
- [x] Add SSRF and redirect tests.
- [x] Add corrected demo endpoint.

## Epic 14: Retention and operations

- [x] Implement retention selection.
- [x] Implement bounded deletion.
- [x] Add cleanup metrics. One structured log line per sweep (ADR-026), and the
      `wayscribe_retention_*` counters and last-success timestamp on
      `/metrics` (ADR-047).
- [x] Add backup documentation.
- [x] Add restore documentation.
- [x] Add structured logs.
- [x] Add basic internal metrics endpoint or diagnostics. `/health`, `/ready`,
      the retention log line, the SDK's shutdown counters, and a Prometheus
      `/metrics` listener on its own port when `METRICS_PORT` is set (ADR-047,
      `docs/OPERATIONS.md` §13).
- [x] Add readiness dependency checks.

## Epic 15: Release readiness

- [x] Complete the source quick start. The README's current path starts from a
      clone; the published checkout-free path is documented separately.
- [x] Complete SDK docs.
- [x] Complete API docs.
- [x] Complete security docs.
- [x] Add contribution guide.
- [x] Add issue templates.
- [x] Add release workflow.
- [x] Publish `api` and `web` images to a container registry. The signed
      multi-platform `v0.1.0` indexes contain linux/amd64 and linux/arm64, with a
      verified CycloneDX SBOM attestation on every platform manifest
      ([release verification](reviews/2026-09-20-release-verification.md)).
- [x] Publish `@wayscribe/node` to npm. `@wayscribe/node@0.1.0` installed into
      an empty Node 24 consumer; registry signatures and provenance verified,
      and the provenance names the release commit and `publish-sdk` job
      ([release verification](reviews/2026-09-20-release-verification.md)).
- [x] Add the checkout-free quick start that will pull published images rather
      than build from source. The README downloads both Compose files from the
      immutable `v0.1.0` tag and pins `WAYSCRIBE_VERSION=v0.1.0`.
- [x] Run security review. The pre-release review and release-readiness review
      are committed under `docs/reviews/`, and `docs/SECURITY_REVIEW.md` carries
      their findings and limits for a pilot reviewer.
- [x] Run full E2E test.
- [ ] Test clean-machine installation. The automated public-artifact test ran in
      an isolated directory on an existing ARM64 macOS Docker host, not a clean
      machine.
- [x] Verify no paid account or external hosted service is required. The source
      and Compose paths use self-hosted Wayscribe services and PostgreSQL. The
      public-artifact test installed from tagged Compose files, public images
      and npm without a Wayscribe account or hosted dependency.
- [ ] Verify first useful journey can be recorded in approximately 15 minutes,
      in an unaided human trial. The automated existing-host run completed in 35
      seconds, but it does not measure first-time comprehension or clean-machine
      setup.
- [x] Verify record-first search, identity mapping, transformation diff,
      existing-architecture flow, and safe replay together. The release demo and
      public-artifact install exercised the complete reference journey, alias
      search, masked alias display, field diff, recorded failure and development
      replay as one flow.
- [ ] Conduct a clarity review with a developer unfamiliar with tracing tools.
- [ ] Obtain feedback from an outside pilot team.
- [x] Tag first development release. Protected annotated tag `v0.1.0` points to
      `f6707c66ea2697a199871a4ef4263e52aa34c11c`; its release pipeline passed.

## Epic 16: Approved post-release SDK and self-hosting expansion

- [x] Freeze HTTP, SQS/SNS, and payload propagation in
      `docs/PROPAGATION_SPEC.md` and versioned language-neutral vectors; run the
      released Node behavior against them (ADR-065).
- [ ] Build the Python SDK against the event, ingestion, SDK, and propagation
      contracts; run its applicable fixtures through the real local dry run and
      dogfood it in Leadline.
- [ ] Build the native Go SDK with the same fixture and dry-run gates, idiomatic
      context and cancellation, concurrency safety, and race tests.
- [ ] Exercise one Node → Python → Go journey with identity, transformation,
      retry/failure, and HTTP or queue-style propagation.
- [ ] Add an explicit setup check and secret-masked redaction preview over the
      dry-run contract without silently storing journey events.
- [ ] Add optional OTLP logs over HTTP, disabled by default, after the native
      SDKs. Traces, metrics, gRPC, and a required Collector stay out of scope.
- [ ] Add PostgreSQL backup and isolated-restore helpers with separate key
      custody and no overwrite of an existing database.
- [ ] Add bounded per-project ingestion controls shared by native and OTLP
      paths, with honest process and replica scope.
- [ ] Add a project-scoped view-only capability for journey status and
      timelines, excluding payloads, replay, deletion, and administration.

## Explicitly deferred

- [ ] Native SDKs after the approved Python and Go sequence, by pilot demand
- [ ] automatic PostgreSQL CDC
- [ ] Kafka
- [x] Kubernetes: a Helm chart for a local single-node cluster, `deploy/helm`
      (ADR-042). Managed clusters remain untested.
- [ ] OTLP traces, metrics, and gRPC
- [ ] S3 payload storage
- [ ] ClickHouse
- [ ] production replay
- [ ] automatic alias discovery
- [ ] contract drift detection
- [ ] MCP
- [ ] BYOK AI
