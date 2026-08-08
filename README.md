# Flight Recorder

[![pipeline](https://gitlab.com/jojithedev/flight-recorder/badges/main/pipeline.svg)](https://gitlab.com/jojithedev/flight-recorder/-/pipelines)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-24-brightgreen.svg)](.nvmrc)

**Find out what happened to one customer record as it crossed your services — and
where its data changed.**

Free, self-hosted, and small enough to run on a laptop. No account, no hosted
service, nothing captured leaves your machine.

---

## The problem

A customer calls. Their phone number is missing in your CRM.

That record arrived through a webhook, went through a transformation, landed in
PostgreSQL, went onto a queue, was picked up by a worker, and was pushed to a
third-party API. Six services. Somewhere in there the phone number became
`null`.

You have logs. They are in six places, keyed by request ID, and none of them
knows that customer by name. You may have traces — spans and latencies, which
tell you the call succeeded and nothing about what it carried.

So you start grepping.

**Flight Recorder is built for that exact half hour.** Search the customer. Read
the timeline. Look at the step where the value changed.

---

## What you actually get

Search `0018Z00002ABC` and you get one record's history, in order, across every
service that touched it:

```text
received      receive-salesforce-webhook     integration-api
transformed   transform-salesforce-account   integration-api
persisted     persist-customer               integration-api
identified    identify                       integration-api
published     publish-customer-updated       integration-api
consumed      consume-customer-updated       sync-worker
delivered     deliver-customer-to-target     sync-worker      422
retried       retry-customer-delivery        sync-worker      422
retried       retry-customer-delivery        sync-worker      422
failed        move-message-to-dead-letter    sync-worker
```

Open the transformation and you get a **field-level diff** of what that step
received against what it produced:

| Field | Before | After |
| --- | --- | --- |
| `Id` | `"0018Z00002ABC"` | — |
| `Name` | `"Jorge Polanco"` | — |
| `Phone` | `"+1 919 555 1234"` | — |
| `Status__c` | `"Active"` | — |
| `externalId` | — | `"0018Z00002ABC"` |
| `name` | — | `"Jorge Polanco"` |
| `phone` | — | **`null`** |
| `status` | — | `"active"` |

There it is. `Phone` went in carrying a value and `phone` came out `null`, while
every other field arrived intact. That pair is the bug — a mapping reading
`Phone__c` from a payload that carries `Phone`.

Then **replay the original input** against your corrected code and compare:

| Field | Before | After |
| --- | --- | --- |
| `phone` | `null` | `"+1 919 555 1234"` |

One changed field. The fix works, tested against the input that actually failed.

That is the whole loop: **find where the value was lost, then prove the fix.**

---

## Try it

One command, and it brings its own broken integration to investigate:

```bash
docker compose -f infrastructure/compose.yaml \
               -f infrastructure/compose.demo.yaml up --build
```

```bash
pnpm demo:trigger
```

Four demo services move a Salesforce account through a webhook, a
transformation, PostgreSQL, a queue, a worker, and a third-party API. The
transformation contains a real defect, the queue really retries, and the target
really rejects the result with a 422. The trigger prints a link; about ten
seconds later the journey shows you everything above.

The interface is at `http://localhost:3000` and asks for `ADMIN_TOKEN`. Set your
own before this holds anything real:

```bash
cp .env.example .env && printf 'ENCRYPTION_KEY=%s\nADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

The API logs a warning at every boot while the published development defaults
are still in use.

---

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

// A journey is one record's history. The entity is what you will search for.
const journey = recorder.startJourney({
  entity: { type: "customer", id: account.Id }
});

// Each wrapper runs your code, returns its value unchanged, and records what
// went in and what came out. The difference between those two is the point.
const customer = await journey.transform("map-account", account, () =>
  toCustomer(account)
);

const id = await journey.persist("save-customer", customer, () =>
  db.customers.insert(customer)
);

// Aliases are the other identifiers this record answers to. Now a colleague who
// only has the internal ID can still find this journey.
journey.identify({ internalCustomerId: String(id) });
```

Then search for `account.Id`. Or the internal ID. Or any other identifier you
attached.

[`examples/instrument-a-service`](examples/instrument-a-service) is a standalone
project that does this end to end in about thirty lines, including the part
where a value goes missing.

### The SDK cannot break your application

An observability library that takes down the service it observes is worse than
no library. This one is built so that cannot happen:

- **No runtime dependencies.** It brings nothing with it.
- Every entry point is wrapped. A recorder failure increments a counter and
  returns; it never reaches your code.
- Wrappers rethrow your **exact** error object, so `instanceof` checks and
  custom properties on your errors keep working.
- The event queue is bounded, and drops oldest under backpressure rather than
  growing without limit.
- The transport retries behind a circuit breaker and gives up rather than piling
  up.
- `shutdown()` races the final flush against a timeout and never hangs.
- Nothing is written to your console unless you ask for it.

---

## Why this is not tracing

Tracing answers *"which call was slow, and did it succeed?"* Flight Recorder
answers *"what happened to this record, and where did its data change?"* Both
are useful. They are not the same question.

| | Flight Recorder | APM / tracing |
| --- | --- | --- |
| You search by | a customer, order, or invoice ID | a trace ID or a service |
| The unit is | one record's journey | one request's spans |
| It shows you | what the payload **was**, field by field | latency, status, structure |
| Correlation is | deterministic, by entity and alias | by propagated trace context |
| It answers | "where did this value change?" | "which call was slow?" |

Five things this does that a tracing tool does not:

1. **Record-first navigation.** You search for a customer, not a trace.
2. **Identity mapping.** One record is a Salesforce ID here, an internal ID
   there, a queue message ID in between. Search any of them and get the same
   journey.
3. **Field-level transformation diffs.** Structural rather than textual —
   `{path, kind, before, after}` — because input and output routinely use
   different field names, and a unified `−/+` view would have to pick one and
   mislead about the other.
4. **Works with the architecture you already have.** Webhooks, PostgreSQL,
   queues, workers, third-party APIs. No rewrite, no service mesh, no agent.
5. **Journey-linked safe replay.** Rerun the exact recorded input against a
   development destination and diff the result.

**It is not a replacement for OpenTelemetry.** When OTel is present, the SDK
reads the active trace and span IDs onto each event so you can pivot between the
two. It does not write `traceparent` — OTel owns that header.

---

## How it works

```text
your services ──SDK──▶  API  ──▶  PostgreSQL
                         │
                         └──▶  web interface
```

That is the entire architecture. **PostgreSQL is the only required backing
service** — no Kafka, no Elasticsearch, no object store, no sidecar, no agent.

- Events are captured **synchronously**, so the recorded payload is what the
  step actually saw, then batched and sent in the background.
- Payloads are **redacted inside your process**, before they leave it, against a
  built-in list of secret-looking paths. Paths you add are appended to that
  list rather than replacing it, so adding one cannot silently disable the rest.
- Payload fields and entity identifiers are **encrypted at rest**.
- Search uses HMAC tokens, so an identifier is findable without being stored in
  the clear.
- Cross-project isolation is **structural**: composite primary and foreign keys
  make one project's key reaching another project's data unrepresentable, rather
  than something every query has to remember to check.
- Replay resolves a hostname once and connects to **that address**, so a name
  that passes the allowlist cannot answer differently a moment later.
- Retention sweeps per environment, on an interval, inside the API process.

Every non-obvious decision is written down with its reasoning in
[the decision log](docs/DECISIONS.md) — 33 ADRs, including the several that were
wrong the first time and say so.

---

## Status

**Working, pre-release. Not yet published.**

Ingestion, search, journey timelines, field-level diffs, the Node SDK,
cross-process propagation, retention, the demo, and development replay are built,
tested, and running. Container images and the npm package are **not published
yet**, so today you install by cloning this repository.

Put plainly: the software works and the distribution does not exist yet.
[CHANGELOG.md](CHANGELOG.md) lists what is done and what is known to be missing.

The install that replaces the clone is already written and waiting on that
publish — [`infrastructure/compose.published.yaml`](infrastructure/compose.published.yaml),
which pulls images, migrates on first boot, and needs no checkout:

```bash
curl -O https://gitlab.com/jojithedev/flight-recorder/-/raw/main/infrastructure/compose.published.yaml && docker compose -f compose.published.yaml up -d
```

**No AI features in V0.** A future bring-your-own-key layer may be added as an
optional, disabled-by-default module. It will never be required, and nothing
will be sent anywhere by default.

### What "done" means for the first release

> A developer can instrument an existing Node.js integration, search for one
> customer, reconstruct its journey across an API, database, queue, worker, and
> external service, see exactly where its data changed, understand the recorded
> failure, and safely rerun the original input against a development endpoint.

Anything not required to make that sentence true is postponed.

The promise this is built toward is *find where a record was changed, lost,
duplicated, delayed, or rejected.* Of those five, **changed** and **rejected**
are demonstrated end to end today, and delay is visible in the timeline as
recorded durations and gaps. Duplication and loss are not yet first-class.

---

## What Flight Recorder is not

- an application performance monitoring platform
- a log aggregator
- a workflow engine
- an integration builder
- a replacement for OpenTelemetry
- a data warehouse lineage platform
- a production event replay system
- an AI incident agent

It observes workflows that already exist.

**One caution worth reading.** Flight Recorder records the contents of your
integration payloads. Treat its database as holding whatever your workflows
carry. If that includes regulated data, review `captureMode` first —
`metadata-only` records the shape of a journey without storing payloads at all.

---

## Free, and staying that way

Apache-2.0. The self-hosted core is free and always will be: event ingestion,
entity and alias search, journey timelines, transformation diffs, error and
retry inspection, development replay, and retention controls require no payment
and no hosted account.

**Private by default.** No captured data is sent to an external service. There
is no telemetry, no analytics, and no outbound connection other than the ones
your own configuration creates.

The reasoning is recorded in [product
principles](docs/PRODUCT_PRINCIPLES.md) and in ADR-011 and ADR-014 of
[the decision log](docs/DECISIONS.md).

---

## Documentation

| Document | Purpose |
| --- | --- |
| [Local development](docs/LOCAL_DEVELOPMENT.md) | Setup, commands, keys, troubleshooting |
| [Operations](docs/OPERATIONS.md) | Backup, restore, upgrade, key rotation, retention |
| [Node SDK](packages/sdk-node/README.md) | The SDK's full surface |
| [Demo scenario](docs/DEMO_SCENARIO.md) | The reference journey, end to end |
| [Architecture](docs/ARCHITECTURE.md) | Components, flows, boundaries, scaling path |
| [Event protocol](docs/EVENT_PROTOCOL.md) | The journey event contract |
| [API specification](docs/API_SPEC.md) | HTTP API contracts |
| [Database schema](docs/DATABASE_SCHEMA.md) | Tables, indexes, constraints, retention |
| [Replay specification](docs/REPLAY_SPEC.md) | Replay rules and safeguards |
| [Security](docs/SECURITY.md) | Threat model and data handling |
| [Security policy](SECURITY.md) | Reporting a vulnerability, and what is in scope |
| [Decision log](docs/DECISIONS.md) | Every architectural decision, and why |
| [Product principles](docs/PRODUCT_PRINCIPLES.md) | The non-negotiables |
| [Product specification](docs/PRODUCT_SPEC.md) | Problem, users, requirements, V0 boundaries |
| [Testing strategy](docs/TESTING_STRATEGY.md) | Unit, integration, browser, acceptance |
| [Task list](docs/TASKS.md) | Implementation checklist and current state |
| [Roadmap](docs/ROADMAP.md) | Beyond the first release |
| [Changelog](CHANGELOG.md) | What changed, and what does not work yet |
| [Contributing](CONTRIBUTING.md) | How to help |
| [Glossary](docs/GLOSSARY.md) | Shared terminology |

---

## Built with

TypeScript · Node 24 · pnpm workspaces · Fastify · Next.js · PostgreSQL 17 ·
Knex · Zod · Vitest · Playwright · Docker Compose

```text
apps/
  api/                  ingestion, query, and replay API
  web/                  developer interface
  demo/                 the reference journey, five entry points in one image
packages/
  protocol/             event schema and version
  sdk-node/             published as @flight-recorder/node
  database/             migrations, repositories, CLI
  payload-security/     redaction, encryption, keys, search tokens
  payload-diff/         structural field-level diffs
  config/               environment parsing
examples/
  instrument-a-service/ standalone; the smallest real instrumentation
infrastructure/         Compose files and queue configuration
```

---

## Contributing

Issues and merge requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the expectations; the short version is that this codebase explains **why**
rather than what, and a change that alters a decision should update
[the decision log](docs/DECISIONS.md) alongside the code.

Security issues go through [SECURITY.md](SECURITY.md) rather than a public
issue.
