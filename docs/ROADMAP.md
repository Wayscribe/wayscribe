# Roadmap

## Product guardrail

Every roadmap item must preserve the free, lightweight, easy-to-implement, clear, and private-by-default community experience documented in [Product Principles and Non-Negotiables](PRODUCT_PRINCIPLES.md).

Paid hosting or enterprise conveniences may be added later, but the core record-first debugging workflow must remain available in the self-hosted community edition.


The roadmap describes direction, not commitments. V0 scope is controlled by the product specification and task list.

## V0: Core integration flight recorder

### Goal

Prove that record-level timelines and payload diffs reduce integration debugging time.

### Scope

- self-hosted Docker Compose deployment
- Node.js SDK
- explicit instrumentation
- HTTP and SQS context propagation
- PostgreSQL
- entity and alias search
- journey timeline
- input/output diffs
- failures and retries
- development-only HTTP replay
- reference Salesforce-to-HubSpot-style demo
- no AI

## V0.2: Developer experience

Potential additions after the core proof:

- Fastify adapter
- Express adapter
- native fetch and Axios helpers
- Prisma or Knex persistence helpers
- improved SDK diagnostics
- importable replay fixtures
- richer filtering
- better masking and capture-policy UI
- install health checks
- local payload file export

## V0.3: More asynchronous workflows

Potential:

- RabbitMQ adapter
- generic message-envelope helper
- scheduled job and batch identifiers
- dead-letter queue import helpers
- long-running journey visualization
- branch and fan-out relationships

## V1: Team-ready self-hosting

Potential:

- OIDC
- team roles
- external PostgreSQL
- S3-compatible payload storage
- backups and restore tools
- stronger encryption
- audit-log UI
- Helm chart
- high-availability deployment
- retention and legal-hold controls

## V1.x: Broader provenance features

Potential:

- Python SDK
- Go SDK
- migration and backfill mode
- support-investigation view
- document processing journeys
- payment reconciliation views
- automatic alias suggestions
- contract drift detection
- code-location association
- OpenTelemetry Collector adapter
- OTLP-derived enrichment

## Future: BYOK intelligence

Potential optional capabilities:

- journey summary
- likely failure-point suggestion
- similar historical journeys
- transformation explanation
- incident report drafting
- natural-language search assistance

Requirements:

- user-owned model credentials
- disabled by default
- field-selection preview
- redaction before transmission
- provider-neutral interface
- complete audit trail
- no dependency from core product
- deterministic evidence remains the source of truth

## Not planned as core product

Flight Recorder should avoid becoming:

- a general log platform
- an APM vendor
- a workflow engine
- an integration builder
- a full data warehouse lineage catalog
- an autonomous production remediation agent
