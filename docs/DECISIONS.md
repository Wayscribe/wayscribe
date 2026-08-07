# Architecture Decision Log

This file records decisions that constrain implementation.

Each accepted change should include date, status, context, decision, and consequences.

---

## ADR-001: Build an integration-focused flight recorder first

**Status:** Accepted

### Context

The underlying journey model could support many workflows, but a universal workflow-observability product would be difficult to explain and validate.

### Decision

V0 will focus on record-level debugging for integrations involving APIs, PostgreSQL, queues, workers, and external HTTP systems.

### Consequences

- The core model remains generic.
- Product language and demo remain integration-specific.
- Other use cases are deferred until the initial workflow proves valuable.

---

## ADR-002: No AI in V0

**Status:** Accepted

### Context

Recorded evidence, correlation, and payload diffs provide value without model inference. AI would increase security, cost, and scope.

### Decision

V0 will contain no AI capabilities or model-provider dependencies.

A future optional BYOK module may consume sanitized journey data through the query layer.

### Consequences

- Core behavior is deterministic.
- No provider credentials are needed.
- AI extension points must not shape ingestion implementation prematurely.

---

## ADR-003: Use TypeScript across V0

**Status:** Accepted

### Context

The initial SDK targets Node.js, and a single language simplifies shared schemas, onboarding, and testing.

### Decision

Use TypeScript for the API, web interface, protocol package, SDK, demo services, and utilities.

### Consequences

- Shared Zod schemas and types are practical.
- Python support is deferred to a later SDK.
- Language-neutral protocol design is still required.

---

## ADR-004: Use PostgreSQL as the only required store

**Status:** Accepted

### Context

The expected V0 workload does not justify multiple storage systems.

### Decision

Store configuration, journeys, events, aliases, diffs, replays, and audits in PostgreSQL.

### Consequences

- Local installation remains simple.
- Payload and event scaling will be measured.
- Object storage or ClickHouse may be introduced later behind stable interfaces.

---

## ADR-005: Use an explicit versioned event protocol

**Status:** Accepted

### Context

The SDK and server need a stable boundary that is not tied to database models.

### Decision

Every event uses a versioned envelope and client-generated event ID.

### Consequences

- Ingestion can reject unsupported versions.
- SDK retries are idempotent.
- Breaking contract changes require a new protocol version.

---

## ADR-006: Prefer explicit instrumentation before automatic instrumentation

**Status:** Accepted

### Context

Automatic instrumentation is broad and may not expose business-level transformation semantics.

### Decision

V0 SDK helpers will explicitly wrap transformations, persistence, publication, consumption, and delivery.

### Consequences

- Developers add some instrumentation.
- Recorded events are understandable and intentional.
- Framework adapters can be added after the core product works.

---

## ADR-007: Recorder failure cannot fail host application work

**Status:** Accepted

### Context

An observability tool must not become a critical dependency for the workflow it observes.

### Decision

The SDK uses asynchronous bounded buffering, short timeouts, capped retries, and failure suppression. Recorder transport errors do not escape into application logic by default.

### Consequences

- Some recorder events may be dropped during outages.
- The SDK requires internal diagnostics for dropped events.
- Host safety is prioritized over perfect telemetry delivery.

---

## ADR-008: V0 replay is development-only

**Status:** Accepted

### Context

Production replay can cause duplicate and irreversible side effects.

### Decision

V0 supports replay only to configured local, development, or test destinations.

### Consequences

- Historical authorization is never reused.
- Every replay is audited.
- Production replay approval workflows are deferred.

---

## ADR-009: Correlation is deterministic in V0

**Status:** Accepted

### Context

Automatic correlation across changing identifiers is valuable but complex and potentially incorrect.

### Decision

Events must carry a journey ID or an explicit alias relationship.

### Consequences

- SDK propagation is important.
- Automatic alias discovery is deferred.
- The UI can trust the recorded relationships.

---

## ADR-010: OpenTelemetry is optional interoperability

**Status:** Accepted

### Context

OpenTelemetry provides trace context and instrumentation primitives, but Flight Recorder focuses on long-lived entity journeys.

### Decision

The Node SDK may read active trace IDs when OpenTelemetry is present. V0 will not require OpenTelemetry or implement a full OTLP receiver.

### Consequences

- Existing traces enrich journeys.
- The product remains easy to install.
- OTLP ingestion can be added later through an adapter.

---

## ADR-011: Keep the self-hosted core free and open source

**Status:** Accepted

### Context

The target users include individual developers and small teams that may not have observability budgets. The product also handles sensitive operational data, so inspectability and local control improve trust and adoption.

### Decision

The self-hosted community edition will be free to use and released under an established open-source license selected before the first implementation release.

The core journey workflow—ingestion, entity search, identity mapping, timelines, transformation diffs, investigation, and development replay—must not require payment.

### Consequences

- No hosted account or license server is required for the community edition.
- Future revenue may come from hosting, support, enterprise administration, governance, or operational convenience.
- Core differentiation cannot be reserved only for a paid edition.

---

## ADR-012: Optimize the default path for lightweight adoption

**Status:** Accepted

### Context

Requiring a large observability stack would prevent the broad adoption the product is intended to achieve.

### Decision

The default installation requires Docker Compose, bundled PostgreSQL, and an application SDK. A developer should be able to record a first useful journey within approximately 15 minutes.

All other infrastructure and integrations remain optional.

### Consequences

- PostgreSQL is the only required backing service in V0.
- Kubernetes, Kafka, ClickHouse, Elasticsearch, OpenTelemetry, Grafana, and AI providers cannot become default dependencies.
- Onboarding time and clean-machine setup become release metrics.

---

## ADR-013: Preserve five product differentiation requirements

**Status:** Accepted

### Context

A generic SDK event timeline has many substitutes in tracing, business-flow monitoring, and workflow products.

### Decision

Flight Recorder V0 must provide a coherent experience containing:

1. record-first navigation
2. entity identity mapping
3. transformation diffs
4. existing-architecture support
5. journey-linked safe development replay

### Consequences

- Scope cuts may simplify implementation but must not remove these capabilities.
- A timeline-only release is not considered a valid product proof.
- Product and acceptance tests must verify the five capabilities together.
