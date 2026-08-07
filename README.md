# Flight Recorder

> Free, lightweight, self-hosted record-level debugging for APIs, queues, databases, workers, and third-party integrations.

Flight Recorder is an early-stage developer tool for reconstructing what happened to a business entity as it moved through a distributed workflow.

A developer should be able to search for a customer, order, invoice, claim, or other entity and answer:

- Where did this record come from?
- Which services processed it?
- Where did its data change?
- Which step failed?
- Was it retried, duplicated, or dropped?
- What happened downstream?
- Can the original input be tested again safely?

## Status

**Planning and initial implementation.**

The first release is intentionally narrow:

- Node.js and TypeScript applications
- HTTP APIs and webhooks
- PostgreSQL
- queue-based asynchronous processing
- third-party HTTP APIs
- deterministic event correlation
- field-level payload diffs
- development-only replay

There are **no AI capabilities in V0**. A future bring-your-own-key intelligence layer may be added as an optional, disabled-by-default module.

## License

Apache-2.0. The self-hosted core is free to use and always will be: event
ingestion, entity and alias search, journey timelines, transformation diffs,
error and retry inspection, development replay, and retention controls require
no payment and no hosted Flight Recorder account.

See [Product principles and non-negotiables](docs/PRODUCT_PRINCIPLES.md) and
ADR-011 and ADR-014 in [the decision log](docs/DECISIONS.md).

## Core product promise

> Find where a record was changed, lost, duplicated, delayed, or rejected across a distributed workflow.

## Product commitment

Flight Recorder is intended to be a tool that any developer or development team can adopt without purchasing or operating a large observability stack.

The self-hosted core will be:

- **Free:** the complete core debugging workflow is available without payment.
- **Lightweight:** Docker Compose, bundled PostgreSQL, and an application SDK are sufficient.
- **Easy to implement:** the target is a first useful journey within approximately 15 minutes.
- **Clear:** the interface centers on entities, journeys, transformations, failures, and replay rather than observability jargon.
- **Private by default:** no captured data is sent to an external service.

The complete product principles and release gates are defined in [Product principles and non-negotiables](docs/PRODUCT_PRINCIPLES.md).

## What Flight Recorder is not

Flight Recorder is not:

- an application performance monitoring platform
- a log aggregator
- a workflow engine
- an integration builder
- a replacement for OpenTelemetry
- a data warehouse lineage platform
- a production event replay system
- an AI incident agent

It observes workflows that already exist.

## V0 reference journey

```text
Simulated Salesforce
        ↓
Webhook API
        ↓
Customer transformation
        ↓
PostgreSQL
        ↓
Queue
        ↓
Background worker
        ↓
Simulated HubSpot
```

A deliberate defect changes:

```json
{
  "phone": "+1 919 555 1234"
}
```

to:

```json
{
  "phone": null
}
```

The target API rejects the record. Flight Recorder must reveal the exact transformation that introduced the invalid value and show all downstream consequences.

## Planned technology stack

- TypeScript
- Node.js active LTS, pinned in the repository
- pnpm workspaces
- Fastify
- Next.js
- PostgreSQL
- Knex
- Zod
- Vitest
- Playwright
- Docker Compose

## Documentation

| Document | Purpose |
|---|---|
| [Product specification](docs/PRODUCT_SPEC.md) | Problem, users, requirements, and V0 boundaries |
| [Product principles and non-negotiables](docs/PRODUCT_PRINCIPLES.md) | Free, lightweight, easy, clear, and differentiated product constraints |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | Ordered build phases and acceptance criteria |
| [Architecture](docs/ARCHITECTURE.md) | Components, flows, boundaries, and scaling path |
| [Event protocol](docs/EVENT_PROTOCOL.md) | Journey event contract and propagation |
| [API specification](docs/API_SPEC.md) | Initial HTTP API contracts |
| [Database schema](docs/DATABASE_SCHEMA.md) | Tables, indexes, constraints, and retention |
| [Node SDK specification](docs/NODE_SDK_SPEC.md) | Initial SDK surface and reliability rules |
| [Security](docs/SECURITY.md) | Threat model and data-handling requirements |
| [Replay specification](docs/REPLAY_SPEC.md) | Development replay rules and safeguards |
| [Demo scenario](docs/DEMO_SCENARIO.md) | End-to-end acceptance workflow |
| [Testing strategy](docs/TESTING_STRATEGY.md) | Unit, integration, contract, and E2E testing |
| [Local development](docs/LOCAL_DEVELOPMENT.md) | Intended setup and commands |
| [Decision log](docs/DECISIONS.md) | Architecture decisions and rationale |
| [Task list](docs/TASKS.md) | Build-ready implementation checklist |
| [Roadmap](docs/ROADMAP.md) | Growth path beyond the first release |
| [Glossary](docs/GLOSSARY.md) | Shared terminology |
| [Agent instructions](AGENTS.md) | Rules for coding agents and LLMs |
| [Contributing](CONTRIBUTING.md) | Contribution and pull-request expectations |

## Planned repository layout

```text
flight-recorder/
├── apps/
│   ├── api/
│   ├── web/
│   ├── demo-source/
│   ├── demo-integration/
│   ├── demo-worker/
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
├── pnpm-workspace.yaml
└── README.md
```

## V0 definition of done

Flight Recorder V0 is complete when:

> A developer can instrument an existing Node.js integration, search for one customer, reconstruct its journey across an API, database, queue, worker, and external service, see exactly where its data changed, understand the recorded failure, and safely rerun the original input against a development endpoint.

Anything not required to make that statement true should be postponed.

The release must also remain free to self-host, require no paid or hosted account, use PostgreSQL as its only required backing service, and let a new developer record a first useful journey in approximately 15 minutes.
