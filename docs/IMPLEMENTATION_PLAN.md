# Implementation Plan

## Objective

Build the smallest complete version of Flight Recorder that proves record-level debugging is useful.

The implementation should progress vertically:

```text
SDK event
  → ingestion
  → correlation
  → persistence
  → query
  → timeline
  → payload diff
  → safe development replay
```

Do not optimize for every framework or deployment environment before the reference journey works end to end.

## Product constraints for every phase

All phases must preserve the requirements in [Product Principles and Non-Negotiables](PRODUCT_PRINCIPLES.md):

- free self-hosted core
- lightweight default installation
- first useful journey in approximately 15 minutes
- clear entity-first developer experience
- no mandatory external account or platform
- record-first navigation
- identity mapping
- transformation diffs
- existing-architecture support
- journey-linked safe replay

Features that add operational complexity must remain optional and must not appear in the default quick start.

---

## Phase 0: Repository foundation

### Deliverables

- pnpm workspace
- TypeScript base configuration
- lint and formatting configuration
- Fastify API application
- Next.js web application
- shared config package
- PostgreSQL container
- Docker Compose
- migration command
- CI workflow
- established open-source license selected
- one-command local startup path documented
- dependency budget documented: PostgreSQL is the only required backing service
- health and readiness endpoints

### Planned repository layout

```text
flight-recorder/
├── apps/
│   ├── api/
│   ├── web/
│   ├── demo-source/
│   ├── demo-integration/
│   └── demo-target/
├── packages/
│   ├── protocol/
│   ├── sdk-node/
│   ├── database/
│   ├── payload-security/
│   ├── payload-diff/
│   └── config/
├── infrastructure/
├── docs/
├── AGENTS.md
├── CONTRIBUTING.md
├── package.json
└── pnpm-workspace.yaml
```

### Acceptance criteria

- `pnpm install` succeeds.
- Repository type checks.
- API starts locally.
- Web starts locally.
- PostgreSQL starts through Compose.
- `/health` reports process health.
- `/ready` verifies database connectivity.
- CI runs formatting check, lint, type check, and unit tests.
- No paid account, cloud account, telemetry platform, or model provider is required.
- The default clean-machine startup uses one documented Compose command.
- PostgreSQL is the only required backing service.

---

## Phase 1: Protocol and persistence

### Deliverables

- protocol version constant
- Zod event envelope schema
- TypeScript event types
- stable error codes
- initial database migrations
- Knex database package
- project and environment seeds for local development
- API-key hashing and validation
- `POST /v1/events`
- `POST /v1/events/batch`
- idempotent event insertion
- journey creation and summary updates
- alias storage
- client and server payload-size enforcement
- initial redaction engine

### Acceptance criteria

- A valid event creates a journey and event.
- The same event ID sent twice creates one stored event.
- An invalid event returns a stable machine-readable error.
- An unsupported protocol version is rejected clearly.
- An API key cannot access another project.
- Sensitive configured paths are redacted before database storage.
- A batch returns per-event accepted or rejected results.

---

## Phase 2: Query and timeline

### Deliverables

- `GET /v1/search`
- `GET /v1/journeys/:journeyId`
- `GET /v1/journeys/:journeyId/events`
- `GET /v1/events/:eventId`
- search by entity and technical identifiers
- web search page
- search result list
- journey header
- chronological timeline
- event detail panel
- payload JSON viewer
- structural diff renderer
- error display

### Acceptance criteria

- A journey is searchable by primary entity ID.
- A journey is searchable by alias.
- A journey is searchable by trace ID and message ID.
- Events render in deterministic chronological order.
- A transformation event shows added, removed, and changed fields.
- Redacted fields are clearly marked.
- Large payloads do not freeze the interface.

---

## Phase 3: Node.js SDK

### Deliverables

- `createRecorder`
- `startJourney`
- `continueJourney`
- `identify`
- `record`
- `transform`
- `persist`
- `publish`
- `consume`
- `deliver`
- `fail`
- `finish`
- client-generated event IDs
- batching
- flush intervals
- retry with backoff and jitter
- bounded in-memory queue
- short transport timeouts
- circuit-breaking behavior
- graceful shutdown flush
- optional debug logs
- active OpenTelemetry trace context lookup when available

### Acceptance criteria

- A sample Node application records a journey.
- A wrapped function records duration and errors.
- Transformation input and output are captured according to policy.
- Recorder unavailability does not fail the wrapped application operation.
- The SDK stops retrying aggressively after repeated failures.
- The SDK does not grow memory without a configured bound.
- Shutdown flush behavior is tested.

---

## Phase 4: Cross-process propagation

### Deliverables

- serialized journey context
- HTTP header injection and extraction
- SQS message-attribute injection and extraction
- optional reserved payload envelope
- parent event linkage
- worker continuation helpers
- reference multi-service demo

### Acceptance criteria

One journey spans:

- webhook receipt
- transformation
- PostgreSQL persistence
- queue publication
- queue consumption
- external HTTP delivery

All events appear in one timeline with correct service names and relationships.

---

## Phase 5: Reference failure scenario

### Deliverables

- simulated source service
- demo integration API
- customer table
- queue or local queue-compatible development service
- demo worker
- simulated target API
- intentional phone-field transformation defect
- retries
- dead-letter behavior
- automated seed and trigger commands

### Acceptance criteria

Searching the demo customer reveals:

- original source payload
- phone field changed to `null`
- persistence step
- queue identifiers
- target rejection
- retry attempts
- final failed state

This is the central V0 product proof.

---

## Phase 6: Development replay

### Deliverables

- replay destination table and API
- development-host allowlist
- blocked-header filtering
- payload editor
- custom safe headers
- replay execution
- timeout and size limits
- response storage
- result comparison
- audit events
- demo corrected transformation endpoint

### Acceptance criteria

- A historical input can be replayed to an approved development endpoint.
- Authorization headers and cookies are not copied.
- A disallowed host is rejected.
- Replay output is compared with the original output.
- Every replay attempt is auditable.
- No production replay path exists.

---

## Phase 7: Hardening and initial release

### Deliverables

- retention cleanup job
- security review
- migration tests
- project-isolation tests
- complete quick start
- SDK reference
- configuration reference
- backup and restore guidance
- error troubleshooting
- Playwright end-to-end test
- release workflow
- contribution guide
- license and free-core policy verification

### Acceptance criteria

A new developer can:

1. Clone the repository.
2. Start the system with one documented Compose command.
3. Run the demo without creating a paid or hosted account.
4. Record and find a first useful journey within approximately 15 minutes.
5. Search the customer through its primary ID or an alias.
6. Find the faulty transformation through a field-level diff.
7. Follow the journey across the existing demo architecture.
8. Replay the original input only to an approved development endpoint.
9. See the corrected output compared with the original output.
10. Understand the flow without prior tracing or observability experience.

The complete flow must be documented and tested.

---

## Implementation priorities

When forced to choose, prioritize:

1. host-application safety
2. security and privacy
3. lightweight operation
4. time to first useful journey
5. clarity of the investigation experience
6. record-first navigation, identity mapping, and transformation diffs
7. correctness and idempotency
8. deterministic correlation
9. testability
10. extensibility
11. performance optimization

## Deferred until after V0

- additional SDK languages
- automatic instrumentation breadth
- OTLP receiver
- S3 payload storage
- ClickHouse
- Kubernetes
- production replay approvals
- support-user views
- contract drift detection
- automatic alias discovery
- MCP
- BYOK AI
