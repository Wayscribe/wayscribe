# Product Principles and Non-Negotiables

> **Written before implementation, and kept as the original plan.**
>
> Where this and [the decision log](DECISIONS.md) disagree, the decision log
> wins — that is the precedence `AGENTS.md` already sets, and it records what
> was actually built, including the decisions that reversed something here.
>
> Kept rather than rewritten: what was planned and what was learned are more
> useful side by side than a plan quietly edited to match the outcome.

This document is a source of truth for product and implementation decisions.

Flight Recorder should be useful to an individual developer, a small team, or a larger engineering organization without requiring a paid service, an existing observability platform, or a large infrastructure commitment.

When a proposed feature, dependency, or architecture decision conflicts with these principles, preserve the principles unless an explicit architecture decision explains why the product can no longer meet them.

## 1. Adoption and experience non-negotiables

### Free core product

The self-hosted community edition must be free to use.

The complete core debugging workflow must remain available without payment:

- ingesting journey events
- searching by entity or technical identifier
- entity alias mapping
- journey timelines
- transformation diffs
- error and retry inspection
- development-only replay
- local retention controls

Future monetization may focus on a hosted service, managed upgrades, support, enterprise authentication, governance, or other operational conveniences. It must not make the core self-hosted debugging experience unusable.

The project should use an established open-source license. The exact license must be selected before the first implementation release.

### Lightweight

A useful local installation must require only:

- Docker with Docker Compose
- the Flight Recorder SDK in the observed application
- network access to the recorder

PostgreSQL may be bundled. No other database, message broker, telemetry platform, cloud account, or model provider is required.

Do not require:

- Kubernetes
- Kafka
- Elasticsearch
- ClickHouse
- Grafana
- Prometheus
- Datadog
- an OpenTelemetry deployment
- an AI provider
- a Flight Recorder cloud account

Additional infrastructure may be supported later as optional integrations.

### Easy to implement

A developer should be able to record a first useful journey within approximately 15 minutes.

The default path should be:

1. Start Flight Recorder with Docker Compose.
2. Install one SDK package.
3. Configure the recorder URL and API key.
4. Wrap or record one meaningful operation.
5. Trigger the workflow and view the journey.

The SDK should provide progressive adoption. A team must not need to instrument every service before receiving value.

### Clear

The product should favor explicit terminology and visible evidence over abstract observability language.

The primary concepts are:

- entity
- journey
- event
- alias
- transformation
- replay

The interface should answer concrete questions without requiring the user to understand tracing systems:

- What happened to this record?
- Where did it change?
- What failed next?
- Which identifiers refer to the same entity?
- Can this input be tested safely against current development code?

Error messages, installation instructions, SDK behavior, and security settings must be understandable without reading the implementation.

### Self-hosted and private by default

Users control the deployment, credentials, retention, and captured data.

No event, payload, alias, or diagnostic data may be sent to a third party by default. Optional future BYOK AI features must be disabled by default and require explicit selection of the data being shared.

The running services send no telemetry. Telemetry a dependency would send is switched off, as it is for Next.js in the web image and the web package's scripts. Building the images downloads base images, Alpine packages and npm packages; that is the only network access a build needs.

## 2. Product differentiation non-negotiables

### Record-first navigation

The primary navigation object is a business entity or workflow instance, such as:

```text
customer:18492
order:ORD-48291
invoice:INV-1004
```

Services, traces, queues, and endpoints are supporting evidence. They are not the main product object.

### Entity identity mapping

The product must make it clear that different identifiers can represent the same logical entity.

```text
Internal ID:       18492
Salesforce ID:     0018Z...
HubSpot ID:        9182736
External ref:      CUST-8841
```

Aliases must be searchable, secure, and first-class in the event protocol, database, SDK, API, and UI.

### Transformation diffs

The product must show what changed between meaningful processing steps.

```diff
- phone: "+1 919 555 1234"
+ phone: null
```

A timeline without transformation evidence is not sufficient to differentiate Flight Recorder from conventional tracing or business-flow monitoring.

### Existing-architecture support

Flight Recorder observes workflows that already exist.

Developers must not need to rebuild their workflows inside Flight Recorder or adopt a specific workflow engine, integration platform, message broker, cloud provider, tracing vendor, or gateway.

### Journey-linked safe replay

Replay must remain attached to the recorded journey and original event evidence.

The initial replay promise is:

> Run an exact historical input against approved development code and compare the new result with the original result.

V0 must not provide unrestricted production replay or reuse captured production credentials.

## 3. Engineering non-negotiables

1. Recorder failure must not break the host application.
2. Journey events are append-only and immutable.
3. SDK-generated event IDs make ingestion idempotent.
4. The event protocol is versioned and separate from database models.
5. Sensitive values are redacted before persistence.
6. Full payload capture is opt-in.
7. Correlation is deterministic in V0.
8. Every replay attempt is audited.
9. PostgreSQL is the only required store until measured usage proves otherwise.
10. AI is not required for any core workflow.

## 4. V0 release gate

V0 should not be considered complete unless all of the following are true:

- A developer can start the local system with one documented Docker Compose command.
- No paid account or external hosted service is required.
- A new developer can record a first useful journey in approximately 15 minutes.
- Search begins with an entity or one of its aliases.
- One journey can span an API, database, queue, worker, and external service.
- The interface identifies the exact transformation where a field changed.
- The same entity can be found through multiple identifiers.
- A historical input can be replayed only to an approved development destination.
- The host application continues working when Flight Recorder is unavailable.
- The documentation explains the happy path without assuming observability expertise.

## 5. Decision test

Before adding a dependency or feature, ask:

1. Does it preserve a free and useful self-hosted core?
2. Does it keep the minimum installation lightweight?
3. Does it reduce or increase time to first useful journey?
4. Does it make the product clearer?
5. Does it strengthen record-first debugging, identity mapping, transformation diffs, existing-architecture support, or safe replay?
6. Can it remain optional if it adds infrastructure or operational complexity?

A feature that fails these tests should usually be deferred or redesigned.
