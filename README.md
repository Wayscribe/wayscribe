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

## Try it

```bash
docker compose -f infrastructure/compose.yaml \
               -f infrastructure/compose.demo.yaml up --build
```

```bash
pnpm demo:trigger
```

Four demo services move a Salesforce account through a webhook, a
transformation, PostgreSQL, a queue, a worker, and a third-party API — and the
transformation contains a real defect. The trigger prints a link to the journey;
about ten seconds later it shows you the step where the customer's phone number
became null, and the 422 that followed.

Nothing to instrument, no account, no telemetry leaving the machine. See
[docs/DEMO_SCENARIO.md](docs/DEMO_SCENARIO.md).

The interface is at `http://localhost:3000`. It asks for an admin token, which
is `ADMIN_TOKEN` from your environment — a development default until you set
your own:

```bash
cp .env.example .env && printf 'ENCRYPTION_KEY=%s\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

The API logs a warning at every boot while the published defaults are in use.

## Instrument your own service

```bash
npm install @flight-recorder/node
```

```typescript
import { createRecorder } from "@flight-recorder/node";

const recorder = createRecorder({
  endpoint: "http://localhost:8080",
  apiKey: process.env.FLIGHT_RECORDER_API_KEY,
  serviceName: "billing-api",
  environment: "development"
});

const journey = recorder.startJourney({
  entity: { type: "customer", id: account.Id }
});

const customer = await journey.transform("map-account", account, () =>
  toCustomer(account)
);
```

Then search for `account.Id`.

`examples/instrument-a-service` is a standalone project that does this end to
end in about thirty lines, including the part where a value goes missing. The
SDK has **no runtime dependencies** and is built so that a recorder failure
cannot break the application it is recording — see
[its README](packages/sdk-node/README.md).

## Status

**Working, pre-release. Not yet published.**

Ingestion, search, journey timelines, field-level diffs, the Node SDK,
cross-process propagation, and the demo are built, tested, and running. Replay
is specified but not yet implemented, and no images or packages are published
yet, so today you install by cloning this repository.

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

Of those five, **changed** and **rejected** are demonstrated end to end today —
the demo finds the transformation that dropped a phone number and the 422 that
followed. Delay is visible in the timeline as recorded durations and gaps.
Duplication and loss are not yet first-class: ingestion deduplicates SDK
retries, which is not the same as telling you a record was processed twice.

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

## Technology stack

- TypeScript
- Node.js 24, pinned in `.nvmrc`
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
| [Local development](docs/LOCAL_DEVELOPMENT.md) | Setup, commands, keys, and troubleshooting |
| [Decision log](docs/DECISIONS.md) | Architecture decisions and rationale |
| [Task list](docs/TASKS.md) | Implementation checklist and current state |
| [Roadmap](docs/ROADMAP.md) | Growth path beyond the first release |
| [Glossary](docs/GLOSSARY.md) | Shared terminology |
| [Agent instructions](AGENTS.md) | Rules for coding agents and LLMs |
| [Contributing](CONTRIBUTING.md) | Contribution and pull-request expectations |

## Repository layout

```text
flight-recorder/
├── apps/
│   ├── api/                  ingestion, query, and replay API
│   ├── web/                  developer interface
│   └── demo/                 five entry points, one image (see docs/DEMO_SCENARIO.md)
├── packages/
│   ├── protocol/             event schema and version
│   ├── sdk-node/             published as @flight-recorder/node
│   ├── database/             migrations, repositories, CLI
│   ├── payload-security/     redaction, encryption, keys, search tokens
│   ├── payload-diff/         structural field-level diffs
│   └── config/               environment parsing
├── examples/
│   └── instrument-a-service/ standalone; the smallest real instrumentation
├── infrastructure/           Compose files and queue configuration
├── docs/
├── AGENTS.md
├── CONTRIBUTING.md
├── pnpm-workspace.yaml
└── README.md
```

The four demo services are five entry points in one `apps/demo` package rather
than four directories: they share the fixture, the queue helpers, and the
recorder setup, and Compose runs the one image with different commands.

## V0 definition of done

Flight Recorder V0 is complete when:

> A developer can instrument an existing Node.js integration, search for one customer, reconstruct its journey across an API, database, queue, worker, and external service, see exactly where its data changed, understand the recorded failure, and safely rerun the original input against a development endpoint.

Anything not required to make that statement true should be postponed.

The release must also remain free to self-host, require no paid or hosted account, use PostgreSQL as its only required backing service, and let a new developer record a first useful journey in approximately 15 minutes.
