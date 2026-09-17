# Agent Instructions

This file contains repository-level instructions for coding agents and LLM-assisted development.

## Product

Wayscribe is a self-hosted, record-level debugging tool for distributed workflows.

It records deterministic journey events so developers can reconstruct how one business entity moved across APIs, services, databases, queues, workers, and external systems.

## Current implementation target

Implement **V0 only**.

The target workflow is:

```text
Webhook
  → integration API
  → transformation
  → PostgreSQL
  → queue
  → worker
  → external HTTP API
```

The developer must be able to search for one entity, inspect the complete timeline, identify where a field changed, view the failure, and replay the original payload to a development endpoint.

## Product constraints

Read `docs/PRODUCT_PRINCIPLES.md` before making product, dependency, onboarding, or UX decisions.

The self-hosted core must remain:

- free to use
- lightweight to operate
- easy to add to an existing application
- clear without requiring observability expertise
- private by default

Do not introduce a mandatory paid account, cloud service, AI provider, observability platform, message broker, or second data store. Optional integrations must not complicate the default path.

## Product differentiation requirements

These features must survive scope cuts:

1. Record-first navigation.
2. First-class entity aliases and identity mapping.
3. Field-level transformation diffs.
4. Instrumentation of existing architectures rather than workflow replacement.
5. Journey-linked development replay with original-versus-replay comparison.

A generic event timeline without these capabilities is not an acceptable V0.

## Technology choices

Unless a decision record explicitly changes them, use:

- TypeScript
- Node.js active LTS, pinned in the repository
- pnpm workspaces
- Fastify for the backend API
- Next.js for the web interface
- PostgreSQL
- Knex for migrations and queries
- Zod for runtime validation
- Vitest for unit and integration tests
- Playwright for critical browser flows
- Docker Compose for local deployment

## Do not add during V0

Do not add any of the following without an explicit architecture decision:

- AI or LLM features
- model-provider SDKs
- BYOK configuration
- a native SDK in another language without an architecture decision. Python has
  one: ADR-059 makes it the next recorder, after the first release. Any other
  language still waits for a pilot team that needs it (ADR-049). Whichever it
  is, it is built against `docs/SDK_SPEC.md` and has to pass the conformance
  fixtures
- Kubernetes beyond the local-cluster Helm chart (ADR-042)
- Kafka
- ClickHouse
- Elasticsearch
- automatic database change-data capture
- production replay
- anomaly detection
- architecture diagrams generated from code
- billing
- enterprise SSO
- complex role-based access control
- hosted SaaS infrastructure
- integration-building functionality
- workflow orchestration

Future AI support is documented only as an extension point. The core product must not depend on AI.

## Core invariants

These rules are non-negotiable:

1. **Recorder failure must not break the host application.**
2. **Journey events are append-only and immutable.**
3. **SDK-generated event IDs make ingestion idempotent.**
4. **The event protocol is versioned and separate from database models.**
5. **Sensitive values are redacted before persistence.**
6. **Full payload capture is opt-in.**
7. **Production replay is not supported in V0.**
8. **Every replay attempt is audited.**
9. **Correlation is deterministic in V0.**
10. **PostgreSQL is sufficient until measured usage proves otherwise.**

## Source-of-truth order

When documents conflict, use this order:

1. Accepted architecture decision in `docs/DECISIONS.md`
2. `docs/PRODUCT_PRINCIPLES.md`
3. Event and API contracts
4. Database schema
5. Product specification
6. Implementation plan
7. Roadmap and ideas

Do not silently resolve contradictions. Update the relevant decision record and affected documents.

## Package boundaries

- `packages/protocol` owns public event schemas and protocol types.
- `packages/sdk-node` depends on the protocol package, not API internals.
- `packages/database` owns migrations and repository queries.
- `packages/payload-security` owns redaction, hashing, and size enforcement.
- `packages/payload-diff` owns JSON-compatible structural comparisons.
- `apps/api` owns authentication, ingestion, correlation, querying, and replay orchestration.
- `apps/web` consumes API contracts and must not access PostgreSQL directly.

Avoid circular dependencies.

## Event protocol rules

- Every event must include a client-generated `id`.
- Every event must include `protocolVersion`.
- Every event must include `journeyId`, entity identity, operation, name, service, environment, and timestamp.
- Unknown fields are accepted rather than refused. Ingestion does not store them
  and does not hash them (ADR-049).
- Unknown protocol versions must be rejected with a clear machine-readable error.
- Additive optional fields are preferred over breaking changes.
- Never make the stored database row the public wire contract.

## Database rules

- Use migrations for every schema change.
- Use UTC timestamps.
- Enforce project scoping in every query.
- Prefer explicit indexes justified by actual query paths.
- Add uniqueness constraints for idempotency.
- Original event rows are never updated to rewrite history.
- Derived journey summaries may be updated.
- Retention deletion must remove related payloads and aliases safely.

## SDK reliability rules

- Telemetry calls must be asynchronous.
- Use bounded buffering.
- Use short network timeouts.
- Retry with capped exponential backoff and jitter.
- Provide a circuit breaker or equivalent failure suppression.
- Never throw recorder transport errors into application code by default.
- Support graceful shutdown flushing.
- Prefer dropping recorder events over exhausting host memory.
- Make debug logging opt-in.

## Security rules

- Never log API keys, authorization headers, cookies, tokens, or encryption keys.
- Store only hashes of project API keys.
- Redact on both client and server.
- Server-side redaction is authoritative.
- Treat aliases as potentially sensitive.
- Do not make email addresses searchable in plaintext by default.
- Do not copy historical authorization headers into replay requests.
- Reject or warn on replay destinations outside configured development hosts.

## Testing expectations

Every change should include the appropriate tests:

- protocol schema tests
- ingestion idempotency tests
- project-isolation tests
- redaction tests
- payload-size tests
- SDK failure-isolation tests
- timeline-ordering tests
- replay allowlist tests
- end-to-end tests for the reference workflow

A feature is not complete because the happy path works manually.

## Documentation expectations

Update documentation in the same change when modifying:

- public SDK behavior
- protocol fields
- API endpoints
- database schema
- configuration
- security behavior
- replay behavior
- scope or roadmap

## Coding style

- Prefer small, explicit modules.
- Use descriptive domain names such as `journey`, `event`, `alias`, and `replay`.
- Avoid premature abstraction for multiple languages or storage engines.
- Validate data at process boundaries.
- Return typed errors with stable codes.
- Keep comments focused on intent and constraints.
- Do not add generic helper layers that obscure security or transaction behavior.

## Before implementing a task

Read:

1. `docs/PRODUCT_PRINCIPLES.md`
2. `docs/PRODUCT_SPEC.md`
3. `docs/ARCHITECTURE.md`
4. the contract document related to the task
5. `docs/DECISIONS.md`
6. the relevant section of `docs/TASKS.md`

Then implement the smallest change that satisfies the documented acceptance criteria.
