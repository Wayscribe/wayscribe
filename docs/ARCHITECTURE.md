# Architecture

> **Written before implementation, and kept as the original plan.**
>
> Where this and [the decision log](DECISIONS.md) disagree, the decision log
> wins — that is the precedence `AGENTS.md` already sets, and it records what
> was actually built, including the decisions that reversed something here.
>
> Kept rather than rewritten: what was planned and what was learned are more
> useful side by side than a plan quietly edited to match the outcome.

## 1. System context

Wayscribe observes applications that already exist.

```text
External system
      │
      ▼
Application / integration services
      │
      ├── Wayscribe Node SDK
      │         │
      │         ▼
      │   Ingestion API
      │         │
      │         ▼
      │     PostgreSQL
      │         │
      │   ┌─────┴─────┐
      │   ▼           ▼
      │ Query API   Replay service
      │   │           │
      │   ▼           ▼
      └─ Web UI    Development endpoint
```

The host application should continue functioning if every Wayscribe service is unavailable.

## 2. Core architectural idea

A distributed trace usually follows a request. Wayscribe follows a **journey**, which may span multiple independent traces, processes, queues, retries, scheduled jobs, and external systems.

```text
Webhook trace
    ↓
Queue consumer trace
    ↓
Scheduled retry trace
    ↓
Reconciliation trace
```

All belong to one entity journey.

## 3. Components

### Node SDK

Responsibilities:

- create and continue journey context
- emit versioned events
- capture explicit input and output
- compute or request payload diffs
- add trace and deployment metadata
- propagate journey context over HTTP and queues
- batch and transmit events
- isolate host application from recorder failures
- apply client-side redaction

The SDK is not responsible for durable storage or authoritative security enforcement.

### Ingestion API

Responsibilities:

- authenticate project API keys
- validate event protocol versions
- enforce payload limits
- apply server-side redaction
- ensure event idempotency
- persist events transactionally
- create or update journeys
- register entity aliases
- update derived journey summaries
- return per-event results

### Correlation engine

V0 correlation is deterministic.

An event belongs to a journey through:

- explicit `journeyId`
- continuation context
- alias linked to an existing journey
- carefully defined server rules

Heuristic or AI correlation is out of scope.

### Query API

Responsibilities:

- search entity and technical identifiers
- return journey summaries
- paginate journey events
- return event details
- expose replay history
- enforce project isolation

### Web interface

Responsibilities:

- entity-first search
- chronological journey timeline
- event detail inspection
- payload diff rendering
- error and retry visibility
- replay preparation and result comparison
- project settings needed for V0

The web application must not connect directly to PostgreSQL.

### PostgreSQL

PostgreSQL stores:

- projects
- environments
- API-key hashes
- journey summaries
- entity aliases
- journey events
- replay destinations
- replay runs
- audit events

PostgreSQL is the only required storage system in V0.

### Replay service

Replay may initially live inside the API process.

Responsibilities:

- validate an approved destination
- filter unsafe headers
- enforce request size and timeout
- send the edited historical input
- record request and response
- audit the action
- compare replay output with the original event result

## 4. Event ingestion flow

```text
SDK creates event ID
      ↓
SDK applies client redaction
      ↓
SDK queues event in bounded memory
      ↓
SDK sends batch
      ↓
API authenticates key
      ↓
API validates envelope and version
      ↓
API enforces size and server redaction
      ↓
Transaction:
  insert event if new
  create/update journey
  upsert aliases
  update summary
      ↓
API returns per-event result
```

## 5. Query flow

```text
User enters identifier
      ↓
Web calls search API
      ↓
Search hashes normalized alias query where needed
      ↓
API searches project-scoped indexes
      ↓
User opens journey
      ↓
API returns summary and paginated events
      ↓
Web renders timeline and diffs
```

## 6. Replay flow

```text
User selects event
      ↓
Web loads original captured input
      ↓
User selects approved development destination
      ↓
User reviews and edits payload
      ↓
API removes blocked headers
      ↓
API validates destination and policy
      ↓
API sends request with strict timeout
      ↓
API stores response and audit event
      ↓
Web compares original and replay results
```

## 7. Design principles

### Append-only evidence

Original events are immutable. Derived summaries may change.

### Protocol independence

Public event envelopes are not database row shapes.

### Explicit correlation

V0 requires a journey ID or explicit alias relationship.

### Failure isolation

Recorder transport errors never fail application work by default.

### Defense in depth

Redaction runs in the SDK and again on the server.

### Measured scaling

Do not introduce ClickHouse, Kafka, or object storage until PostgreSQL limitations are measured.

### Extension through adapters

Future storage, SDK, and intelligence providers should sit behind narrow interfaces.

## 8. Transaction boundaries

For each accepted event, the ingestion transaction should:

1. insert the event with a uniqueness constraint
2. create the journey if missing
3. update journey summary fields
4. add aliases
5. commit

If the event already exists, return an idempotent accepted result without repeating derived updates.

## 9. Event ordering

Events are sorted by:

1. event timestamp
2. server receive timestamp
3. event ID

The UI should visually indicate when event timestamps appear inconsistent or arrive late.

## 10. OpenTelemetry relationship

Wayscribe should read active trace and span IDs when OpenTelemetry is already present.

It should not require OpenTelemetry in V0 and should not implement a full OTLP receiver initially.

Future flow:

```text
Existing application telemetry
      ↓ OTLP
OpenTelemetry Collector
      ↓ adapter
Wayscribe
```

Journey identity remains a Wayscribe concept even when trace context comes from OpenTelemetry.

## 11. Deployment profiles

### Local

- Docker Compose
- bundled PostgreSQL
- local account or development-only access
- short retention
- payload storage in PostgreSQL

### Team

Partly built:

- external PostgreSQL — **shipped**, and now the default rather than an option
  (ADR-037)
- TLS
- external identity
- S3-compatible payload storage
- longer retention
- multiple API replicas

### Mature environment

Future profile:

- existing OpenTelemetry Collector
- external database and object storage
- OIDC
- Kubernetes
- horizontal ingestion workers

## 12. Future BYOK architecture

AI is not part of V0.

A future intelligence module should consume sanitized data through the query layer:

```text
Recorded evidence
      ↓
Query API
      ↓
Sanitization and field selection
      ↓
Provider-neutral intelligence interface
      ↓
User-configured model provider
```

The intelligence module must not be embedded into ingestion or required for core functionality.
