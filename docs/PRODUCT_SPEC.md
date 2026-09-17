# Product Specification

> **Written before implementation, and kept as the original plan.**
>
> Where this and [the decision log](DECISIONS.md) disagree, the decision log
> wins — that is the precedence `AGENTS.md` already sets, and it records what
> was actually built, including the decisions that reversed something here.
>
> Kept rather than rewritten: what was planned and what was learned are more
> useful side by side than a plan quietly edited to match the outcome.

## 1. Product summary

Wayscribe is a free, lightweight, self-hosted developer tool that reconstructs the history of a business entity across a distributed workflow.

It records explicit, versioned journey events emitted by instrumented applications. Those events are correlated into a chronological timeline with payload diffs, errors, deployment metadata, aliases, queue identifiers, and trace identifiers.

## 2. Problem

Developers debugging integrations and asynchronous workflows often have enough logs to know that something failed, but not enough connected context to understand the complete history of one affected record.

Investigations commonly require searching:

- API logs
- worker logs
- queue consoles
- dead-letter queues
- database rows
- external SaaS systems
- distributed traces
- deployment history
- source code

The information is organized by service and infrastructure component rather than by the customer, order, invoice, or claim the developer is investigating.

## 3. Core promise

> Find where a record was changed, lost, duplicated, delayed, or rejected across a distributed workflow.

## 4. Initial target user

The initial user is a developer or small engineering team maintaining workflows that involve:

- webhooks
- REST APIs
- transformations
- PostgreSQL
- asynchronous workers
- message queues
- external SaaS or internal APIs

Typical teams include CRM synchronization, billing, ecommerce, healthcare integration, logistics, payroll, and embedded-integration products.

## 5. Jobs to be done

When an operational record is incorrect or missing, the developer wants to:

1. Search by any identifier they have.
2. Reconstruct all processing steps in order.
3. See where the payload changed.
4. Identify the first failure.
5. See retries, duplicate processing, and downstream effects.
6. associate the event with code and deployment versions.
7. test the original input against corrected development code.
8. produce a reliable investigation record without manually assembling evidence.

## 6. Product principles

The detailed source of truth is [Product Principles and Non-Negotiables](PRODUCT_PRINCIPLES.md). These principles are product constraints and release requirements, not optional aspirations.

### Free core product

The self-hosted community edition must provide the complete core debugging workflow without payment or a hosted Wayscribe account.

### Lightweight

Docker Compose, a PostgreSQL database, and an application SDK must be sufficient for the default installation. All other infrastructure is optional.

*(ADR-037 settled which database: the operator's own, with a bundled one available as an overlay for evaluation. The principle — no heavy infrastructure — is unchanged.)*

### Easy to implement

A developer should be able to record a first useful journey within approximately 15 minutes and gain value before instrumenting every service.

### Clear

The product should use concrete entity, journey, event, alias, transformation, and replay concepts instead of requiring observability expertise.

### Entity-first

The primary object is the business entity or workflow journey, not the service, log line, or trace.

### Deterministic before intelligent

V0 derives results from recorded evidence, explicit correlation, and structural diffs. No AI is required.

### Self-hosted by default

Users control the deployment and captured data.

### Safe observer

Wayscribe must never become a reason the host application fails.

### Useful with a small stack

A developer should not need Grafana, Kafka, Kubernetes, Elasticsearch, or an LLM provider.

### Narrow first release

The first release proves one complete record journey. Breadth comes later.

## 7. Differentiation non-negotiables

V0 must include the following as a coherent product experience:

1. **Record-first navigation:** search and investigation begin with an entity or workflow instance.
2. **Entity identity mapping:** multiple internal and external identifiers map to the same logical entity.
3. **Transformation diffs:** the interface shows exactly where meaningful fields changed.
4. **Existing-architecture support:** teams instrument workflows they already have instead of rebuilding them inside Wayscribe.
5. **Journey-linked safe replay:** historical inputs can be tested against approved development code and compared with original results.

A release containing only SDK events and a timeline is not sufficient.

## 8. V0 functional requirements

### Installation

- The complete local system starts with Docker Compose.
- PostgreSQL is bundled for local use.
- The web and API services expose health checks.
- The Node SDK can connect with an environment URL and API key.

### Event ingestion

- Accept one event or a batch.
- Authenticate project and environment.
- Validate the protocol version and schema.
- enforce payload limits.
- Apply redaction before persistence.
- Ignore duplicate event IDs idempotently.
- Create or update the matching journey.
- Store aliases and event relationships.

### Search

Search must support:

- journey ID
- primary entity ID
- entity alias
- trace ID
- span ID
- message ID
- correlation ID

### Journey timeline

The UI must display:

- chronological events
- service and operation
- event status
- duration
- retries and failures
- deployment metadata
- relationships to parent events

### Event details

The UI must display:

- input and output payloads when captured
- field-level differences
- error data
- trace and message identifiers
- aliases added by the event
- custom metadata

### SDK

The Node SDK must support:

- recorder initialization
- starting and continuing journeys
- adding aliases
- manual events
- transformation wrappers
- persistence wrappers
- queue publication and consumption
- external delivery wrappers
- batching
- transport retries
- bounded buffering
- failure isolation
- graceful shutdown

### Replay

V0 replay must:

- target explicitly configured development destinations
- remove unsafe historical headers
- allow payload editing before send
- record the request and result
- create an audit event
- compare the replay result with the original event result

## 9. V0 non-functional requirements

### Reliability

- SDK transport failures do not fail host application work.
- Duplicate event delivery does not duplicate stored events.
- Event ordering is stable by timestamp with deterministic tie-breaking.
- Partial batch errors are reported per event.

### Security

- Full payload capture is opt-in.
- Client-side and server-side redaction are supported.
- API keys are stored as hashes.
- Aliases may be hashed for search.
- Replay destinations are restricted.
- Sensitive headers are never copied automatically.
- Events are append-only.

### Performance targets for development

These are initial engineering targets, not public service guarantees:

- Ingestion API p95 under 250 ms for a batch of 20 small events on a local development machine.
- Search p95 under 500 ms for the reference dataset.
- Timeline load p95 under 500 ms for journeys with up to 500 events.
- SDK overhead outside transport should remain small relative to wrapped work.
- The SDK should not hold unbounded event data in memory.

## 10. Reference acceptance scenario

The demo must show a customer moving through:

```text
Webhook API
  → transformation
  → database
  → queue
  → worker
  → external API
```

A transformation converts a valid phone number to `null`. The external target rejects the record. The developer searches for the customer and sees:

- the original phone value
- the transformation that removed it
- the database operation
- queue publication and consumption
- the external rejection
- retry behavior
- the final dead-letter state
- a replay against corrected development code

## 11. Explicit V0 non-goals

- AI analysis
- AI-generated summaries
- BYOK provider configuration
- multiple SDK languages
- automatic database change-data capture
- production replay
- workflow execution
- integration building
- log aggregation
- metrics dashboards
- anomaly detection
- enterprise identity management
- hosted multi-tenant SaaS
- Kubernetes packaging
- Kafka support
- codebase indexing
- architecture discovery

## 12. Future AI boundary

A future optional module may use customer-provided model credentials to summarize or analyze sanitized journey context.

The core system must remain fully functional without it.

Any future AI feature must be:

- disabled by default
- explicitly enabled per project
- configured with user-owned credentials
- auditable
- redacted before transmission
- limited to user-selected fields
- clearly labeled as inference rather than recorded fact
