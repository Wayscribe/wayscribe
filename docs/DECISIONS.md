# Architecture Decision Log

The product was called Flight Recorder until 2026-09-17 (ADR-057). Decisions
before ADR-057 use the old name and are left as written.

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
- Language-neutral protocol design is still required. Satisfied by ADR-049.

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

**Status:** Accepted. ADR-049 amends its wording on OTLP ingestion and not its principle: accepting
OpenTelemetry log records becomes a planned optional path, and no deployment requires
OpenTelemetry.

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

The core journey workflow (ingestion, entity search, identity mapping, timelines, transformation diffs, investigation, and development replay) must not require payment.

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

---

## ADR-014: License the project under Apache-2.0

**Status:** Accepted

### Context

The project targets adoption by individual developers and small teams. The SDK is
embedded directly into other organizations' applications, which makes license choice
an adoption factor rather than a formality. Relicensing later requires consent from
every contributor.

### Decision

All packages are licensed Apache-2.0, with a NOTICE file.

### Consequences

- The SDK can be embedded without legal review friction.
- A split license reserving copyleft for the server was considered and rejected as
  contributor friction that does not serve an adoption goal.
- Commercial optionality is reduced; future revenue must come from hosting, support,
  or operational convenience rather than license terms.

---

## ADR-015: Use ElasticMQ for the demo queue

**Status:** Accepted

### Context

The SDK specification and Epic 11 are SQS-specific, but no Compose service provided a
queue, and ADR-012 requires PostgreSQL to be the only required backing service.

### Decision

The demo Compose profile provides ElasticMQ, an SQS-compatible server distributed as a
roughly 40 MB native image. The core `compose.yaml` continues to require only
PostgreSQL. SDK queue helpers target the SQS message-attribute contract.

### Consequences

- Code proven against ElasticMQ works unchanged against AWS SQS.
- The core installation footprint is unchanged.
- The demo profile is heavier than the core profile, which is acceptable because the
  demo is opt-in.
- LocalStack was rejected as roughly 1 GB in the onboarding path; a PostgreSQL-backed
  queue was rejected because it leaves SQS propagation untested.

---

## ADR-016: Authenticate the web interface with a single admin token

**Status:** Accepted

### Context

The interface displays captured customer data including names, phone numbers, and
email addresses. A published self-hostable tool will be exposed to networks its
authors did not anticipate.

### Decision

The web interface authenticates against a single admin token supplied by environment
variable, exchanged for a session cookie. The local seed generates and prints one.
Compose binds published ports to `127.0.0.1` by default.

Implementation lands in Phase 2 with the first data-bearing interface. Phase 0 defines
the environment variable and the Compose binding.

### Consequences

- Onboarding cost is roughly one environment variable.
- V0 has no multi-user model; V1's OIDC support supersedes this.
- Project API keys remain scoped to SDK ingestion and are not reused for the
  interface, so a browser session carries no ingestion rights.

---

## ADR-017: Pin Node.js 24 and pnpm 11

**Status:** Accepted

### Context

The documents required "Node.js active LTS, pinned" without naming a version.
Node.js 20 reached end of life in April 2026. At the time of writing, the current
stable pnpm is 11.x; 10.x is superseded.

### Decision

Node.js 24.x, pinned through `.nvmrc` and `engines`. pnpm 11.x, pinned through
`packageManager` and resolved by corepack. pnpm 11 requires Node.js >= 22.13, which
Node 24 satisfies.

### Consequences

- Contributors need Node 24; the README states this.
- Version bumps are explicit repository changes.

---

## ADR-018: Capture-mode names use the protocol form

**Status:** Accepted

### Context

`DATABASE_SCHEMA.md` used `metadata`, `allowlist`, `redacted`, and `full`, while the
protocol, security, and SDK documents used the hyphenated long forms.

### Decision

The canonical values are `metadata-only`, `allowlisted-fields`, `redacted-payload`,
and `full-payload`, used in the protocol, the SDK configuration surface, the API, and
the `environments.capture_mode` check constraint.

### Consequences

- The source-of-truth order in `AGENTS.md` is honored: contracts outrank the schema.
- These strings already appear in public SDK configuration, so no consumer changes.

---

## ADR-019: Replay destinations store an origin and base path

**Status:** Accepted

### Context

`API_SPEC.md` created destinations with a full URL including a path, conflicting with
the `base_url` column in the schema and the separate `path` field in
`CreateReplayRequest`.

### Decision

A destination stores `base_url`: scheme, host, port, and optional base path. A replay
request supplies a relative `path`, appended to the base. Path traversal, absolute
URLs, and protocol-relative URLs are rejected.

### Consequences

- SSRF validation operates against a fixed origin approved at destination-creation
  time rather than a per-request URL.
- Redirect, userinfo, and DNS-rebinding bypasses have a smaller surface.
- Destinations are less flexible; one destination per origin.

---

## ADR-020: Composite primary keys on journeys and events

**Status:** Accepted

### Context

The schema specified "primary key or unique `(project_id, id)`" without resolving
which, leaving foreign key shapes undefined.

### Decision

`journeys` and `journey_events` use `(project_id, id)` as the primary key.
`entity_aliases` references journeys through the composite foreign key
`(project_id, journey_id)`.

### Consequences

- No redundant surrogate key index.
- Cross-project joins are structurally impossible, supporting the isolation tests
  required by `SECURITY.md` section 8.
- Composite foreign keys are more verbose in Knex.

---

## ADR-021: Conflicting duplicate event IDs are rejected

**Status:** Accepted. The hash is keyed by ADR-048.

### Context

`TESTING_STRATEGY.md` required this policy to be decided explicitly.

### Decision

Each event row stores a `content_hash` derived from a canonical serialization. An
event whose `(project_id, id)` exists with a differing hash is rejected with `409` and
code `event_id_conflict`; in a batch it is reported as `rejected` while other events
proceed. Identical resubmissions remain idempotent.

### Consequences

- An SDK defect that reuses event IDs surfaces instead of silently discarding
  evidence.
- Requires canonical JSON serialization with sorted keys and stable number
  formatting.
- Adds one column and one hash computation per ingested event.

---

## ADR-022: Failed delivery uses the attempt's own operation

**Status:** Accepted

### Context

`EVENT_PROTOCOL.md` required the choice between `delivered`-with-error and a separate
`failed` event to be consistent, without making it.

### Decision

A failed attempt emits `delivered`, or `retried` for subsequent attempts, with `error`
populated and the HTTP status in `metadata`. `failed` is reserved for terminal journey
or branch failure such as a dead-letter transition.

### Consequences

- Matches the expected timeline in `DEMO_SCENARIO.md` section 6.
- Duration, input, and output stay attached to the attempt rather than being split
  across two events.

---

## ADR-023: identify() emits a dedicated event

**Status:** Accepted

### Context

The SDK specification left alias emission dependent on "the final protocol decision."

### Decision

`identified` is added to the `JourneyOperation` enum. `journey.identify()` emits a
dedicated event carrying the new aliases. The `aliases` field remains available on
every event for callers preferring inline identity.

### Consequences

- Aliases are not lost if the process terminates before the next event.
- Identity mapping gets a first-class operation, consistent with ADR-013.
- Adds one event per identify call; adding an operation is a compatible protocol
  change under `EVENT_PROTOCOL.md` section 11.

---

## ADR-024: Payload diffs are computed at ingestion and stored

**Status:** Accepted

### Context

The task list deferred this to "the performance decision."

### Decision

The structural diff is computed during ingestion and written to
`journey_events.payload_diff`.

### Consequences

- The timeline performance target of p95 under 500 ms for 500 events is achievable.
- Events are immutable, so a stored diff never goes stale.
- Changing the diff algorithm requires a backfill migration.

---

## ADR-025: Array diffs compare by index

**Status:** Accepted

### Context

The task list required "documented policy" for array comparison.

### Decision

Arrays are compared element-wise by index, with length differences reported as added
or removed entries. No longest-common-subsequence matching and no move detection in
V0.

### Consequences

- Diff cost stays linear, satisfying the required complexity limits.
- A reordered array is reported as broadly changed; this is documented in user-facing
  diff documentation.

---

## ADR-026: Retention cleanup runs in the API process

**Status:** Accepted

### Context

Epic 14 specified retention behavior without specifying how it is triggered.

### Decision

Retention runs on an interval inside the API process, guarded by
`pg_try_advisory_lock`, deleting in bounded batches.

### Consequences

- No additional container, preserving ADR-012.
- Multiple API replicas do not delete concurrently.
- Retention stops when the API is down, which is acceptable for a cleanup job.

---

## ADR-027: Migrations are plain JavaScript in a package-root directory

**Status:** Accepted

### Context

Knex records the migration *filename* in the `knex_migrations` table. With
TypeScript migrations compiled to `dist`, the same migration is named
`001_projects.ts` when applied from source through tsx and `001_projects.js` when
the API loads it from compiled output. A database migrated in one context then
reports the migration directory as corrupt in the other.

A related defect appeared first: because `.d.ts` declaration files end in `.ts`, a
`loadExtensions: [".ts", ".js"]` list counted every compiled migration twice, so
`/ready` reported migrations pending forever.

Both are the same underlying problem: migration identity must not depend on how
the process was started.

### Decision

Migrations and seeds are plain ESM JavaScript in `packages/database/migrations` and
`packages/database/seeds`, at the package root rather than under `src`. Knex is
configured with `loadExtensions: [".js"]` only. Knex types are supplied through
JSDoc.

The directories resolve as `../migrations` relative to the Knex configuration
module, which sits at `src/knex-config.ts` in development and `dist/knex-config.js`
in a container, both exactly one level below the package root.

### Consequences

- One migration file has one name in every execution context: tsx, node, Vitest,
  and Docker.
- Migrations are not type checked by `tsc`; JSDoc gives editor support instead.
- Migrations need no build step, so `pnpm db:migrate` works on a fresh clone.
- Schema changes carrying non-trivial logic must be written in JavaScript, which
  is an accepted trade for deterministic migration identity.

---

## ADR-028: Search tokens are type-independent

**Status:** Accepted

### Context

Phase 1a computed search tokens as `HMAC(key, aliasType + ":" + value)`. That makes
value-only lookup impossible: computing the hash requires already knowing the alias
type. The `(project_id, alias_value_hash)` index exists specifically for value-only
lookup and was therefore unusable, and the product's central promise (type an
identifier into a search box and find the record) could not work, because a developer
holding an ID from a log line does not know which alias type it was stored under.

`DATABASE_SCHEMA.md` section 4 says to include the alias type "when appropriate".
Reading that as "always" broke the primary use case.

### Decision

`searchToken(key, value)` hashes the normalized value alone. `alias_type` remains a
plaintext column for display and type-qualified filtering. Migration 011 adds
`(project_id, primary_entity_id_hash)` to `journeys`, which had the same
type-dependency problem for entity search.

### Consequences

- Value-only search works, and both alias indexes become useful.
- Two alias types sharing a value hash identically. That is correct for "find anything
  matching this value"; `alias_type` disambiguates at read time.
- Existing tokens are invalidated. No production data exists, so no backfill is needed;
  the seed and tests regenerate.
- An attacker with the search key can still only confirm guessed values, not enumerate
  them, so the security property HMAC provides is unchanged.

---

## ADR-029: Admin principal is project-wide; API keys stay environment-scoped

**Status:** Accepted

### Context

ADR-016 settled that the web interface authenticates with a single admin token and
deferred implementation. The API accepts only environment-scoped API keys, but a
developer investigating a record should not need to know which environment it landed in
before they can search for it.

### Decision

Authentication resolves to one of two principals. An API key identifies one project and
one environment, unchanged. An admin token identifies the operator and grants reads
across every environment of a named project.

Read scopes become `{ projectId, environmentId? }`, where an absent environment means
every environment of that one project and never more than one project.

An admin principal cannot ingest: ingestion writes into a specific environment and an
admin token names none, so accepting it there would mean guessing.

The web application signs its session cookie with a key derived from `ADMIN_TOKEN`
through HKDF, so it needs one secret rather than two and rotating the token invalidates
sessions.

### Consequences

- The interface can search a project without an environment selector.
- Every read query must still filter on project_id; the optional environment widens one
  dimension only, and tests assert an admin cannot cross projects.
- A single global admin secret is a guessing target, so login is throttled in-process.
  That does not survive horizontal scaling and is documented as a single-instance
  limitation.

---

## ADR-030: Transformation diffs compare input to output, and nothing else

**Status:** Accepted

### Context

`DEMO_SCENARIO.md` section 7 documented an expected transformation diff showing
`phone` changing from a value to `null` with `name` unchanged, both sides using
internal field names.

That diff cannot be produced by the step it describes. The transformation's input is
the Salesforce account (`Name`, `Phone`, `Status__c`) and its output is the internal
customer (`name`, `phone`, `status`), so comparing them renames every field and
yields only removals and additions.

The documented diff was in fact an expected-versus-actual comparison, which is the
replay comparison in `REPLAY_SPEC.md` section 11.

Found by running the interface against real ingested data rather than by reading.

### Decision

A transformation diff compares exactly what a step received against what it
produced. Nothing is inferred about renamed fields.

`DEMO_SCENARIO.md` section 7 is corrected to show the real diff. The defect remains
legible: `Phone` enters with a value and `phone` leaves as `null`, while every other
field arrives intact.

Rename-aware diffing is rejected. Inferring that `Phone` became `phone` is guessing,
and a debugging tool that guesses is worse than one that reports.

### Consequences

- Phase 5's demo acceptance asserts the corrected diff, not the original.
- The differentiator in ADR-013 stands, but its demonstration is two rows rather
  than one, and the documentation says so.
- Comparing an expected shape against an actual one remains available through
  replay, where both sides genuinely share a shape.

## ADR-031: A wrapped event is timestamped when its operation started

**Status:** Accepted

### Context

The SDK wrappers (`transform`, `persist`, `publish`, `deliver`) recorded an event
after their callback resolved, and stamped it with the time of that recording.

Running the Phase 5 demo showed the consequence immediately. `demo-integration`
published to the queue, and `demo-worker` consumed the message, recorded it, and had
it ingested before the publish wrapper had finished stamping its own event. The
timeline read:

```text
consumed     consume-customer-updated    demo-worker
published    publish-customer-updated    demo-integration
```

A step sorted after the work it caused. Ordering is by `(event_timestamp,
received_at, id)`, so nothing downstream could fix it.

This is not specific to a fast local queue. Any step whose recorded duration exceeds
the latency of what it triggers inverts the same way, and those are precisely the
slow steps a developer opens the timeline to investigate.

### Decision

A wrapped event carries the moment its callback started. Duration is already a
separate field, so no information is lost, and the pair states plainly that the
operation began at one time and took a measured span.

This matches how tracing systems order spans, which are ordered by start time for
the same reason.

`record()` and the other unwrapped entry points continue to stamp at call time,
which for them is the same moment.

### Consequences

- The demo's ten-event sequence matches `DEMO_SCENARIO.md` section 6 exactly.
- A step and the work it caused can share a timestamp to the millisecond; the
  `(timestamp, received_at, id)` ordering already tie-breaks.
- `RecordInput` gains an optional `startedAt`, which also gives a caller recording
  historical events a way to say when they happened.

## ADR-032: Replay is an admin capability, and V0 sends the payload as recorded

**Status:** Accepted

### Context

`REPLAY_SPEC.md` specifies replay's safety machinery in detail but leaves two questions
open: who may invoke it, and whether the payload can be edited first.

`apps/api/src/principal.ts` resolves exactly two principals. An API key identifies one
project and one environment and may ingest. An admin token identifies the operator and
reads across a named project. Replay is a third capability and belongs to neither by
default.

`REPLAY_SPEC.md` section 3 lists "allow payload review and editing" among V0 goals.

### Decision

**Replay requires the admin token. An API key is refused.**

An API key sits in application configuration on servers many people can reach, and it
exists to write events. Letting it also make Flight Recorder issue outbound requests to
configured destinations would turn a leaked telemetry key into a request-forgery
primitive aimed at the operator's own development network. The admin token is already an
operator credential.

This mirrors ADR-029, which refuses admin tokens at ingestion.

**V0 sends the recorded payload unmodified. The editor moves to V1.**

Review stays and is mandatory: the prepare screen shows exactly what will be sent, which
is what makes section 13's prohibition on one-click replay mean anything. What is deferred
is changing it.

An editable payload needs a JSON editor with validation, error states, and a
recorded-versus-edited diff. That is a substantial interface, and it is not required for
the loop replay exists to close: fix the code, replay the original input, compare. Editing
the input tests something other than the recorded failure.

**A payload that was never captured cannot be replayed.** Ingestion applies capture policy
before storing, so `metadata-only` environments hold nothing to send. Replay refuses with
that reason. It does **not** refuse a payload containing `[REDACTED]` markers: sending one
to a development endpoint still reproduces a shape, and the prepare screen shows it.

### Consequences

- This narrows a documented V0 goal, which is why it is an ADR rather than a quiet
  omission. `REPLAY_SPEC.md` section 3 is annotated.
- The web application needs no payload editor, removing the largest interface in Phase 6.
- The comparison view must state that two `[REDACTED]` values compare as unchanged, so a
  replay diff cannot prove a redacted field was fixed.
- A future editor is additive: the endpoint already takes a payload, so V1 changes the
  interface rather than the contract.

---

## ADR-033: Replay connects to a resolved address, not to a hostname

**Status:** Accepted

### Context

Replay adds the first outbound HTTP client in `apps/api`, in a tool that exists to be
pointed at internal services. That is a server-side request forgery surface inside a
development network.

`REPLAY_SPEC.md` section 10 requires resolving the host before the request and
revalidating after DNS resolution.

Checking a hostname and then handing that same hostname to an HTTP client does not satisfy
this. The client resolves the name again, and a name that answered with an allowed address
during validation may answer with another address a moment later. That is DNS rebinding,
and it defeats hostname-only allowlisting completely.

`fetch` offers no hook between resolution and connection.

### Decision

The host is resolved once, the resolved addresses are validated, and the connection is
made **to an address** rather than to the name, using `undici` with a custom `connect`.
`undici` is added to `apps/api` for this.

Redirects are not followed: `redirect: "manual"`, and a 3xx is recorded as the result.
Following one would repeat the whole resolution problem at a destination the operator
never approved.

**Private address ranges are permitted.** Section 10 suggests considering a block, and
this decision declines: every destination the feature exists for (`localhost`,
`host.docker.internal`, a Compose service name) resolves into a private range. Blocking
them would leave replay unable to reach anything it is for. `REPLAY_ALLOWED_HOSTS` is the
control, and an explicit allowlist is a better control than a heuristic.

The header blocklist is its own list rather than a reuse of `DEFAULT_SECRET_PATHS`, which
is a payload path list and omits three of the eight headers `SECURITY.md` section 8
requires blocked.

### Consequences

- `apps/api` gains one runtime dependency, justified by the hook it provides.
- TLS to an IP address must carry the original hostname for SNI and certificate
  verification, so the `Host` header and servername are set explicitly.
- The allowlist becomes load-bearing. An operator who adds a wildcard or a host they do
  not control reopens the surface, and the documentation says so.
- IPv4-mapped IPv6 forms are normalised before comparison, so `::ffff:127.0.0.1` cannot
  slip past a check written for `127.0.0.1`.

## ADR-034: Payloads JSON cannot represent are repaired, not refused

**Status:** Accepted

### Context

`checkLimits` measured a payload by calling `JSON.stringify` on it. That throws on exactly
two inputs, a cycle and a BigInt, and both were caught and reported as
`payload_too_large`.

Both reports were wrong, and wrong in a way that cost the payload:

- A cycle is capturable. ADR-030's redaction walk marks the point where a loop closes and
  keeps the rest of the structure. But `checkLimits` runs first, so that repair was
  unreachable: every parent/child graph an ORM hands back was discarded before reaching
  it. This was found by instrumenting a real application, not by a test.
- A BigInt is capturable too. A PostgreSQL `bigint` column, a Prisma `BigInt`, and a
  snowflake id are all ordinary values.

The diagnostic compounded it. `payload_too_large` sends an operator to raise
`maxPayloadBytes`, and no value of that setting could ever have helped.

### Decision

Values JSON cannot represent are rendered rather than rejected, and the size check
measures the rendering rather than the original.

- A BigInt becomes its decimal string. A Number would round away the precision BigInt
  exists to preserve.
- A cycle becomes `[CIRCULAR]` at the point the loop closes. `toStorable` now does this
  itself as well, because `redact` returns early when no paths are configured and its own
  cycle handling never runs in that case.
- `checkLimits` measures with a replacer that mirrors both, so the measurement and what is
  actually stored agree. It tracks the **ancestor chain**, not every object visited: two
  fields pointing at one address object is ordinary and must be expanded twice, or an
  oversized payload could slip through by carrying a self-reference.
- Genuine failures (a getter or a `toJSON` that throws) get their own reason,
  `unserialisable_payload`, so the operator is not sent to a setting that cannot help.

### Consequences

- The byte limit still applies to cyclic payloads; tolerating a cycle is not skipping the
  check.
- `Map`, `Set`, `Error`, and `RegExp` stored as `{}` when this was written, because none
  has own enumerable properties and the redaction walk rebuilt them empty. **Superseded by
  ADR-036**, which renders them inside the walk.
- `LimitViolation` gains a variant. The API passes the reason through as an error code, but
  cannot produce this one: its input is already-parsed JSON, which has no cycles, no
  BigInt, and no getters.

## ADR-035: A secret is identified by its key name, at any depth

**Status:** Accepted

### Context

`DEFAULT_SECRET_PATHS` shipped each name twice (`authorization` and `*.authorization`),
which reached the top level of a payload and one level below it. Nothing deeper, and
nothing inside an array, because an array with no matching `x[*]` rule was walked with no
rules at all.

Verified against the running stack and read back out of PostgreSQL, this was stored as
plaintext in `journey_events.input_payload`:

```json
{"items": [{"api_key": "ak_ARRAY_PROOF"}],
 "config": {"headers": {"authorization": "Bearer sk_live_DEPTH3_PROOF"}},
 "request": {"body": {"user": {"password": "hunter2-DEPTH3"}}}}
```

`config.headers.authorization` is the shape every axios error carries, and it is the most
common way a live key reaches a captured payload at all. This applied in every capture
mode, including the default, and at both redaction points (the SDK before buffering and
the server before persistence), because both append the same list.

`SECURITY.md` section 2 names secret capture as a primary threat and lists API keys, OAuth
tokens, cookies and passwords; section 3 requires that `full-payload` never mean "skip
secret detection". The filtering ran everywhere section 4 asks for it. It simply could not
reach.

The unit tests passed throughout, because each asked whether a configured rule matches a
payload built to fit it. None asked the question that mattered: whether the shipped list
reaches where real secrets sit.

### Decision

A rule of the form `**.name` matches that key name at every level, and the built-in list
is written entirely in that form. Twenty-two rules covering two levels became eleven
covering all of them.

It is implemented as a set of key names checked on every key of every object, never
narrowed while descending, and not as a general glob. The security property is then a single
sentence a reviewer can confirm in one reading: *a key whose name is on the list is
replaced wherever it is filed.* A `**` segment threaded through the existing path matcher
would have put the same guarantee behind path-matching edge cases, which is where this
class of bug lives.

Only a plain key name is accepted after the prefix. `**.a.b`, `**.*` and `**.a[*]` are
dropped rather than reinterpreted, so a malformed rule protects nothing instead of quietly
matching something its author did not mean.

The existing grammar is untouched. A bare `authorization` still matches the top level only
and `*.password` still matches one below it, so nobody who wrote a rule to mask one field
finds every field of that name masked instead.

### Consequences

- Redaction now descends into arrays. An array previously terminated the walk for its
  contents unless an explicit `x[*]` rule existed.
- Over-redaction is possible where a key name is only sometimes a secret, and the built-in
  list is deliberately narrow for that reason: each name means a secret in essentially
  every payload it appears in. A name that is sometimes a secret belongs in an operator's
  own `redact` list, where the trade is theirs to make.
- Breadth remains a separate question from reach. This decision changes only what the
  eleven existing names can reach.
- The regression test is a payload shape from a real library, asserted against the row in
  PostgreSQL rather than against the function's return value.

## ADR-036: Values that hide their contents are rendered inside the redaction walk

**Status:** Accepted

### Context

A `Map`, a `Set`, an `Error`, a `RegExp` and a `Headers` keep their data in internal slots
rather than in own enumerable properties. The object rebuild that makes redaction possible
therefore turned every one of them into `{}`. The event was still recorded and the field
was simply empty, with nothing to say so: the same failure ADR-030 fixed for `Date`, in
the values `toJSON` does not cover.

An `Error` is the sharp case. This is a debugging tool, and an error stored as `{}` is the
one payload a reader most needs. An axios failure carries `config` and `response` as
assigned own properties, so those survived, while `name` and `message`, the two fields
that say what went wrong, did not.

### Decision

One shallow `renderExotic` step, placed in `walk` immediately after the `toJSON` step it
mirrors, returning through the same single exit: `walk(rendered, paths, anyDepth, seen)`.

Two properties carry the whole security argument, and both are pinned by tests.

**Shallow.** A render never recurses. Its values are the *original* references, handed
straight back to the walk that called it, with the paths un-advanced. Converting a subtree
inside the renderer would carry it past every remaining match site and past the ancestor
set that detects cycles. That single change would turn this from a fix into a leak.

**Plain.** A render emits ordinary objects and arrays under the keys the data already had,
with no wrapper frame and no type marker. The path a reader sees in a stored payload is
therefore the path a redaction rule matches. A `{__type, entries}` wrapper would push every
key one level down, so `headers.authorization` in the interface would need a rule written
against `headers.entries.authorization`, and the rule that looked right would silently
match nothing while the secret kept flowing. A marker is also a stored `jsonb` shape: once
payloads land it propagates into `payload_diff` and the interface, and reverting the code
would not revert the data.

Detection is two-stage. `Object.prototype.toString` is a fast candidate filter, and each
branch then confirms by reaching for the intrinsic itself (`Map.prototype.entries`, the
`RegExp.prototype.source` getter), which a forgery cannot satisfy and which works across
realms, where `instanceof` fails. `RegExp.prototype.toString` is *not* a brand check: it is
specified to work on any object, and an impostor came back as `/undefined/undefined`.

`Error` is the one branch with no unforgeable brand, since the tag is what makes a
cross-realm error recognisable at all. That is acceptable only because its rendering is
non-destructive: it copies own enumerable properties under their own names, so a forged tag
produces the fields the ordinary rebuild would have produced anyway.

`stack` is excluded. It is the largest field on a typical error, `EVENT_PROTOCOL.md` gives
thrown errors their own structured fields, and an error's own `toJSON` is honoured first.

`checkLimits` renders too, in both halves. A `Map` has no own enumerable properties, so the
depth, width and string caps saw an empty object and `JSON.stringify` measured two bytes.
That was harmless only while a Map also *stored* as two bytes; keeping the contents without
teaching the guard would have let a 200,000-entry Map walk through a limit written to stop
exactly that. The measurement memoises each rendering in a `WeakMap`, because its cycle
check compares by identity and rendering the same Map twice would leave the loop never
closing.

### Consequences

- A `Map` is indistinguishable from an object once stored, and a `Set` from an array. This
  is the deliberate cost of storing them under their own keys, and the SDK README says so.
- Map keys are stringified, so two distinct keys can collapse onto one name. The count is
  reported as `[COLLIDED_KEYS]`, and an application already using that name keeps its own
  value: the marker is dropped rather than the data.
- A payload holding one of these now hashes differently, and `contentHash` is computed over
  what the SDK sent. Resending the same event id from a mixed-version fleet during a
  rollout returns 409 `event_id_conflict`.
- A `Map` that measured as `{}` may now exceed `maxPayloadBytes` and record
  `[PAYLOAD_TOO_LARGE]` with a `dropped` diagnostic. That is the guard working for the
  first time, but it will be experienced as payloads disappearing after an upgrade.
  (Amended by the SDK v1 work: that diagnostic is now `payload_omitted`, counted in
  `payloadsOmitted`, so `dropped` counts only events that were not delivered.)
- `packages/database/src/repositories/audit.ts` is the one caller with no `checkLimits` in
  front and no `toStorable` behind. Audit metadata is server-built plain strings, so it is
  not reachable today; it is newly reachable in principle, and belongs in its own change.

## ADR-037: The database is the operator's, and a project is something they create

**Status:** Accepted

### Context

The quick start bundled PostgreSQL and offered no way to point at another one, which
inverted the relationship a self-hosted tool should have with a team's data. Flight
Recorder stores captured request payloads. The database holding them is exactly the one an
operations team wants inside their own backup schedule, their own monitoring, and their own
credential rotation, not in a container the tool brought with it.

Worse, an installation could not be used at all. `key:create` requires a project, and the
only two projects that could ever exist came from the two hardcoded seeds, `local` and
`demo`, neither of which the published stack ran. A team following the documented quick
start reached "No projects yet", had no command to create one, and stopped there. Nothing
downstream (SDK, timeline, diff, replay) was reachable from a fresh install.

`key:create` was also documented only as `pnpm key:create`, which needs the repository
cloned, contradicting a quick start whose premise is that no checkout is required.

### Decision

`DATABASE_URL` is required and points at the operator's PostgreSQL. The bundled database
moves to `infrastructure/compose.bundled.yaml`, an overlay for evaluation and local work.

An overlay rather than a Compose profile: a profiled service cannot be the target of
`depends_on`, and `docker compose config` refuses the file outright: *service "app"
depends on undefined service "postgres"*. Compose also interpolates each file before
merging them, so `${DATABASE_URL:?...}` in the base would refuse to start even when the
overlay is about to supply the value. The variable is therefore permissive in the file, and
both the API's config loader and the migration CLI say what to do when it is unset.

`project:create` and `project:list` join the CLI, which the published image already
carries; `migrate` runs from it. The documented invocation is the container one, so the
no-clone path is complete.

A slug is `^[a-z0-9]+(-[a-z0-9]+)*$`, validated at creation. It reaches project selection,
the CLI, and the interface, and creation is the only cheap moment to reject one.

### Consequences

- Upgrading an installation that used the bundled database means adding
  `-f compose.bundled.yaml` or moving the data. The CHANGELOG says so.
- Flight Recorder needs an ordinary database and an ordinary role. It installs no
  extensions and touches nothing outside the tables its migrations create, so it can share
  a database with other things. (Amended by the v1 acceptance check: migration 001 still
  ran `create extension if not exists "pgcrypto"`, which nothing used and which failed for
  a role without `CREATE` on the database. The statement is gone, and PostgreSQL 15, which
  has `gen_random_uuid()` built in, is the stated minimum.)
- A team that manages its own schema changes can leave the `migrate` service out and run
  the same command when it suits them. `/ready` reports `migrations_pending` until they do,
  so the API will not serve reads against a schema it does not recognise.
- Seeds keep their hardcoded slugs. They exist for the demo and for local development, and
  they are no longer the only way a project can come into being.

## ADR-038: Every read carries a scope, not a project id

**Status:** Accepted

### Context

`principalEnvironmentId` existed and was passed to exactly one read. `/v1/search` scoped
its query to the caller's project *and* environment; `/v1/journeys/:id`,
`/v1/journeys/:id/events` and `/v1/events/:id` took a bare project id.

Read routes accept either principal, so an API key can read. A key issued for
`development` could therefore fetch a `production` journey, its events, and the full
decrypted payload, by id. Verified against a running stack before the fix: the response to
a development key carried `{"salary": 185000, "ssnLast4": "6789"}` from a production event.

The boundary was real in the schema (`journeys` and `journey_events` both carry
`environment_id` with foreign keys), enforced on one route, and absent on the three that
return the data.

The test suite contained a case that looks like it covers this and does not. *"returns 404
for another project's journey and event"* builds a second **project**, which composite keys
already make unreachable. Nothing tested a second environment of the same project.

### Decision

`ReadScope` (`{ projectId, environmentId? }`) moves out of `search.ts`, where it lived as
`SearchScope` because search was the only read that took one, into its own module. Every
read takes it. A single `readScope(principal)` in the route file is the one place a scope is
constructed, so a future read cannot be written that quietly omits the environment.

An absent environment still means every environment of one project, never every project.
That is what an admin gets, and it is what replay uses (ADR-032 makes replay admin-only).

Aliases and the service list inside `findJourneyDetail` filter on project alone, and say so
in a comment: the journey they belong to has already had to pass the scope for those lines
to run, and `entity_aliases` carries no environment.

### Consequences

- Two call sites in `replays.ts` were passing a bare project id and were caught by the
  compiler when the signature changed, which is the reason the scope is a type rather than
  an optional argument.
- The regression test builds a second environment of the *same* project and asserts 404 on
  all three routes, with a control that the production key still reads its own data.
- That test covers reads only. Writes were not scoped: a key could attach events and
  aliases to another environment's journey, which then showed through every scoped read of
  that journey. The amendment below closes it at ingestion, with its own regression test
  (`journey-environment.integration.test.ts`).
- `SearchScope` is gone rather than aliased. A deprecated name in a pre-1.0 internal
  package is cruft that outlives the reason for it.

### Amendment: writes are scoped too

Added after a pre-1.0 security review. Recorded here rather than as a new ADR because it
completes this decision: a scope on every read is only a boundary if nothing outside the
scope can write into what the reads return.


#### Context

The decision above scoped every read by environment. Writes were not scoped the same way. A
journey's `environment_id` is set by whichever environment writes it first:
`ensureJourney` inserts and ignores a conflict. Events and aliases then attached by
`(project_id, journey_id)` alone.

A pre-1.0 security review showed what that allowed. A development API key could post a
`failed` event with an alias into a production journey: the journey's status became
`failed`, the alias became searchable, and the attacker's service appeared in its service
list. The same key could create a journey id production would use later; production's
events and aliases then landed in the development journey, and the development key read
production's customer-email alias through it. Both were verified against a running stack.

#### Decision

Ingestion refuses an event whose API key's environment differs from the environment of the
journey it names, with 409 `journey_environment_mismatch`. It is refused per event, so in a
batch the rest are unaffected, and nothing is written for it: no event, no alias, no change
to the journey's summary.

The check is inside the ingestion transaction. `ensureJourney` inserts the journey if absent
and then reads it back `FOR KEY SHARE`. A concurrent create of the same id waits on the
insert's conflict until the other transaction commits, so the read sees whichever
environment won; the row lock holds until the event is stored, so a deletion cannot remove
the journey between the check and the insert.

Of the four row locks, KEY SHARE is the one that holds the row without holding up other
events for it:

- `FOR UPDATE` was the first version. It is correct and serialises every event for a
  journey behind whichever holds it: measured with 16 concurrent streams on one journey,
  p50 went from 22 ms without the check to 31-33 ms.
- `FOR SHARE` deadlocks. The same transaction then updates the journey's summary, and two
  transactions each holding SHARE and each asking for the update's lock wait on each other.
- `FOR NO KEY UPDATE` serialises like `FOR UPDATE`, since holders conflict with each other.
- `FOR KEY SHARE` conflicts only with a DELETE or a change to a key column. The summary
  update changes no key column, so it takes `FOR NO KEY UPDATE`, which KEY SHARE does not
  block: 20 ms p50 under the same load, and the race and deletion probes passed with no
  deadlock and no journey holding two environments' events. `environment_id` is in no
  unique index, and nothing updates it.

The message says the journey id is in use by another environment and that a journey cannot
span environments. It does not name the environment. That a journey id exists elsewhere in
the project is disclosed, and cannot be avoided without accepting the write.

A cross-environment workflow, where one journey really does cross from a staging service to
a production one, is not supported. Each environment records its own journey.

#### Consequences

- An SDK used normally is unaffected: it names one environment, and journey ids it
  generates are random UUIDs.
- Event ids are still unique per project, not per environment. A key for one environment
  can still claim an event id another environment later uses, which that environment then
  receives as `event_id_conflict`. That is a denial of one event, not a write into another
  environment's data, and is not changed here.
- Installations that ran an earlier build may hold events written across environments.
  `journey_events.environment_id` records the environment of the key that wrote each event,
  so `doctor` counts them and fails ("Journey environments"). `entity_aliases` records no
  environment, so an alias cannot be attributed to either side; the remedy is deleting the
  affected journeys (`docs/OPERATIONS.md` §12).
- Regression coverage: `apps/api/src/routes/journey-environment.integration.test.ts` tests
  both vectors in both directions through the single and batch routes, reading rows back
  from PostgreSQL, a concurrent create from two environments, and the SDK's ordinary flow.

## ADR-039: A secret is one name, however it is spelled

**Status:** Accepted

### Context

Matching compared a lowercased key against a lowercased rule. `api_key` was on the built-in
list and matched; `apiKey` was the same secret and was stored in the clear. Half of
JavaScript writes one and half writes the other, and a payload usually contains whichever
its author preferred.

Two further fields had no redaction at all. `applyCapture` ran on `event.input` and
`event.output`, and `error`, `runtime`, `deployment` and `metadata` went to `jsonb`
verbatim. The Node SDK redacts `metadata` before sending, but ingestion is public HTTP and
a client that is not the SDK runs none of that.

### Decision

Key names are normalised (lowercased, with `-` and `_` removed) on both sides of the
comparison. `apiKey`, `api_key`, `api-key` and `APIKey` are one name. Only case and
separators go; `secret` still does not match `secretary`, because the point is one name
spelled differently rather than one name resembling another.

Normalisation applies to operator-configured paths too, so a rule written in either
convention reaches both.

`redactAlways` applies the operator's paths plus the built-in list regardless of capture
mode, and covers the four fields `applyCapture` never saw. It is a separate function
because `applyCapture` answers a different question (*how much of the business payload may
we store*), and for `metadata-only` that answer is none, while SECURITY.md section 3 keeps
identifiers and operation metadata in that mode.

### Consequences

- For `error`, `runtime` and `deployment` this is defence against the schema growing rather
  than a fix for today: their keys are fixed, so no path rule matches one.
- **It cannot reach a secret pasted inside `error.message` or `error.stack`.** Those are
  free text and path redaction matches names. SECURITY.md section 2 names stack traces as
  carriers of credentials. ADR-046 masks that text by shape and keeps stacks only under full
  capture.
- Normalisation runs on every key of every object. The lowercase result is tested for a
  separator before any replacement, so the common case allocates once.

## ADR-040: The documentation's checkable claims are tested

**Status:** Accepted

### Context

The README asserted that payload fields are encrypted at rest. They are `jsonb`.
`docs/OPERATIONS.md` went further and told an operator that a `pg_dump` taken without
`ENCRYPTION_KEY` restores a database whose payloads cannot be read, so following the
documented backup procedure exported every captured customer payload in the clear, while
the document said it had not.

The same README counted 33 ADRs when there were 37, and its status text has been wrong in
both directions inside one week. An onboarding truth pass was already done once, in Phase 6,
and had drifted again by this one.

### Decision

Claims the repository can check for itself are checked, in `tests/docs-truth.test.ts`: the
stated ADR count matches the decision log, ADR numbers run without gaps or repeats, and no
document claims payloads are encrypted at rest.

The prose is corrected to what is true. Entity identifiers and alias values *are* encrypted
with a key derived from `ENCRYPTION_KEY`; payloads are not, which is precisely why redaction
is the control that matters. The backup section now says to treat a dump as if it contained
customers' request bodies, because it does.

### Consequences

- `tests/` needs a home in the root `tsconfig.json`, since ESLint's type-aware rules require
  every linted file to belong to a project and it belongs to no package.
- This tests the claims a machine can check. It does not test whether the prose is *useful*,
  which still needs a person who has not seen the project before.
- A fourth truth pass is now a test failure rather than an audit finding.

## ADR-041: Scanners run the real tools, and the baseline is cleared before they block

**Status:** Accepted

### Context

The pipeline had nine stages and no security job, in a tool that copies customer request
payloads into a database.

GitLab's Dependency Scanning and Container Scanning templates are Ultimate-tier features.
On a Free project they produce an empty report, which is worse than no scanner: a report
that finds nothing is indistinguishable from one that works.

### Decision

Three jobs run the underlying open-source tools directly (`pnpm audit`, gitleaks, and
Trivy), so the result is real and the pipeline stays portable off GitLab. SAST is
deliberately absent: on a codebase this size, with type-aware lint and 423 tests, it
produces findings that get triaged once and ignored afterwards, which is worse than not
having it.

**All three block, and the baseline was cleared first.** Turning a scanner on red is how it
gets disabled: the same reasoning that already keeps `demo` and `e2e` manual, written down
in this repository as *"a red pipeline on every push for a suite needing the whole stack
trains people to ignore it."*

Clearing it meant fixing rather than allowlisting:

- Three high advisories reached through Next (`postcss` twice and `sharp`) are pinned
  forward with `overrides` in `pnpm-workspace.yaml`. An override removes the finding; an
  allowlist hides it. (The setting moved out of `package.json` in pnpm 10, and is silently
  ignored there.)
- Seventeen gitleaks findings were each checked by reading the matched line. All were
  fixtures or the proof strings in `WHAT_RUNNING_IT_FOUND.md`, which necessarily contains
  things shaped like credentials because it documents a defect that stored them. The
  allowances in `.gitleaks.toml` are written against the *value* rather than the path
  wherever possible, so they cannot hide whatever lands in that file next; and a planted
  credential is still detected, which is a test rather than an assumption.
- Trivy reported seven HIGH and one CRITICAL in both images, in `tar`, `brace-expansion`,
  `ip-address` and an old `undici`. None were ours: they belong to `npm` and `corepack`,
  which the `node:24-alpine` base ships and the runtime never uses. Both Dockerfiles now
  delete them. That is a smaller attack surface as well as a clean scan.

`container-scan` runs on the default branch, on tags, and on a schedule rather than on
every push, because it builds two images.

### Consequences

- **A pipeline schedule has to be created in the GitLab interface**, and without it the
  scanners only answer when somebody commits. A base-image CVE is published without anybody
  committing anything, so the schedule is the part that makes this worth having.
- Overrides are a standing obligation. Each entry names what it is for and should be
  removed once the parent resolves it, or the project quietly pins itself to old
  transitive versions.
- Removing the package managers means a runtime container cannot `npm install` anything.
  That is intended.
- One moderate advisory remains, in `uuid`. `high` is the gate deliberately: a moderate
  advisory in a transitive development dependency is not worth a red pipeline.

## ADR-042: A Helm chart, for running it yourself rather than for distributing it

**Status:** Accepted

### Context

`AGENTS.md` lists Kubernetes and Helm in the do-not-add list, and `CONTRIBUTING.md` requires
an accepted decision before either. This is that decision.

The list was written when adoption was the goal, and the reasoning against a chart was
sound for that goal: it would point at images nobody had published, and a second install
shape doubles the surface where a quick start can dead-end. `docs/ROADMAP.md` said as much
this week.

The goal changed. The owner is the primary user, deploys to a local cluster, and does not
want to publish. Under that goal both objections fall away: a chart is not a *second*
install shape if it is the one actually used, and "no adopter would notice" stops being an
argument when there is no adopter to notice.

ADR-037 is what makes the chart small. The application holds no state: two Deployments, a
Job, a Secret, and a Service each. Before it, a chart would have had to carry a StatefulSet
and a volume claim, which is the worst kind of chart to own.

### Decision

`deploy/helm/flight-recorder` targets a **local single-node cluster**: kind, k3s, or Docker
Desktop. Access is by `port-forward` or NodePort; no ingress controller, cert manager, or
storage class is assumed, because assuming any of them is how a chart fails on the machine
it was written for.

Values are structured so a managed cluster is a values file rather than a rewrite: ingress,
resources, replica counts and image pull secrets all exist as options and are simply off.

PostgreSQL follows the shape ADR-037 set for Compose. `postgresql.enabled` defaults to
`false` and the chart expects `DATABASE_URL` for a database the operator owns; enabling it
runs one in-cluster for evaluation. No `bitnami/postgresql` dependency: a subchart is more
moving parts than a single StatefulSet, and its licensing has moved recently.

Migrations run as a Helm hook, mirroring the `migrate` service in Compose, so there is one
answer to "who applies schema" rather than two. The hook is `post-install,post-upgrade`,
not `pre-install`: a `pre-install` hook runs before *every* regular resource in the release,
so the Job could not see the Secret holding `DATABASE_URL` and, with `postgresql.enabled`,
had no database to migrate. Ordering is enforced by `/ready` returning `migrations_pending`
instead, which keeps new pods out of service until the schema is applied and lets the
previous pods keep serving through an upgrade.

The chart is verified by installing it into a throwaway kind cluster and reading pod status
and a live response, not by `helm lint` alone. A chart that templates cleanly and does not
run is the exact failure this project keeps finding.

### Consequences

- Two deployment shapes now exist, and a configuration variable added to one has to reach
  the other. The chart's values are named after the environment variables they set, so the
  mapping is mechanical rather than remembered.
- The chart pulls from the project's own container registry. Nothing needs to be published
  publicly for it to work, which is the point.
- Kubernetes and Helm come off the do-not-add list in `AGENTS.md`, replaced by a pointer
  here. `CONTRIBUTING.md` keeps its requirement for the rest.
- Local-first means the chart is *not* yet proof it runs on a managed cluster. That is
  stated in the chart's README rather than implied by its existence.

## ADR-043: The runtime image carries only what the runtime executes

**Status:** Accepted

### Context

"Can a demo application live in this repository without shipping?" turned out to have three
mechanisms behind it (`private: true` in the package, absence from
`infrastructure/compose.published.yaml` and the Helm chart, and `.dockerignore`), and
`apps/demo` satisfied only the first two.

Looking at the actual image rather than the intent made the real problem bigger than the
demo. `apps/api/Dockerfile` ended its build stage with `COPY --from=build /app /app`, which
is every file in the workspace: 62 test files, ten source directories, the demo application
and the web application, all in the published API image. The comment above it explained the
choice (keeping the whole tree keeps the paths the documentation uses), but those paths are
`dist` paths, so the reason justified far less than it was taking.

None of it is reachable. The entrypoint is `apps/api/dist/server.js`, and the workspace
`exports` maps name `./src/index.ts` only under the `development` condition, which requires
an explicit `--conditions=development` that nothing in the image passes.

Unreachable is not the same as harmless. Test fixtures in this repository contain
credential-shaped strings (`admin-token-for-tests-…`, a 64-character hex key) that exist
precisely because they look real enough to exercise the parsers. A secret scanner reading a
published image cannot tell a fixture from a leak, and neither can a person.

Trivy was already scanning these images and had nothing to say about any of it. It answers
"which packages have CVEs", not "what is in here that should not be".

### Decision

The build stage deletes what the runtime never executes (`apps/demo`, `apps/web`, every
`src` directory outside `node_modules`, every `*.test.ts` and `*.spec.ts`, and the
`tsconfig` files) after the production install and before the runtime stage copies it.

`.dockerignore` is the wrong place for `apps/demo`: the root context is shared by all three
image builds, and excluding the demo there would break `apps/demo/Dockerfile`. Exclusion
belongs to the image that does not want the files, not to the context.

`scripts/verify-image-contents.sh` asserts the result against the built image, and
`container-scan` runs it before Trivy. It is a script rather than lines in `.gitlab-ci.yml`
so it can be run locally, which is the same reasoning as DEBT on untested release paths.

### Consequences

- The check was confirmed to fail against an image built without the prune, reporting all
  four violations rather than aborting on the first. A guard whose failure path has never
  run is a guard in name only, which this repository has now been bitten by twice.
- `container-scan` runs on the default branch, tags and schedules, not on feature branches.
  A regression is caught at merge rather than before it, because the check needs a built
  image and adding a docker build to every push is the worse trade.
- Size was never the point and barely moved: 34.9M to 33.6M, since `node_modules` dominates
  both. The 62 test files were the point.
- The demo now genuinely does not ship, by all four mechanisms rather than two.

## ADR-044: Keys carry an identifier, and rotation is a grace period, not a migration

**Status:** Accepted

### Context

`ENCRYPTION_KEY` is the one secret an operator configures, and three things derive from it:
the field encryption key, the search-token key, and the API-key pepper. Encrypted values were
stored as base64 of `iv ‖ tag ‖ ciphertext` with nothing saying which key wrote them. Rotating
the key therefore made every stored identifier undecryptable, every existing journey
unsearchable by identifier, and every issued API key fail. `OPERATIONS.md` said so in bold, and
a debt declaration said adding a key label was hours before anyone stored data and a
re-encryption project after.

A self-hosting team will rotate this key: after a suspected leak, on a schedule, or when
someone who had it leaves. Nothing was published yet, so the format could still change without
a migration anyone had to run.

### Decision

Every encrypted value carries the identifier of the key that wrote it, as
`fr1.<keyId>.<base64>`. The identifier is a 12-character HKDF fingerprint of the master key
under its own label, so it is derived rather than configured: an operator cannot mislabel a key,
and the id reveals nothing about the subkeys. A value with no prefix is the legacy format, and
`.` never appears in base64, so the two cannot be confused.

Rotation is a grace period. `ENCRYPTION_KEY_PREVIOUS` holds the key being replaced beside the
new one. The API writes under the new key and reads under both: a labelled value under the key
it names, a legacy value under each in turn, with GCM authentication making the wrong key fail
rather than produce garbage. Search compares against both keys' tokens. An API key verifies
under either, and on success under the old one its verifier is rewritten under the new one in
the same request, because the presented key is the only plaintext a verifier can be recomputed
from. `rotate:reencrypt` moves everything else, resumably, and `rotate:status` exits 0 once
nothing is left under another key, which is when the previous key is removed.

One previous key, not a list. A rotation finishes before the next begins, and a list would turn
"which keys are still needed" into a question nobody can answer from the configuration.

Re-encryption is a command an operator runs, not something the API does at boot. It is a long
write across every encrypted table, and it should start when someone decides it should.

When data is under a key that is not configured, the API still starts and says so: one warning
at boot with counts per table, and one per unknown key id on read. Refusing to start would stop
ingestion over a read problem whose fix, putting the key back, means recreating the API with it
either way. A replay whose destination headers cannot be decrypted is refused and recorded,
because sending it without the destination's credentials would be a different request from the
one configured.

### Consequences

- Upgrading needs no data migration. Legacy values read as before and are rewritten by the next
  rotation, or by `rotate:reencrypt` run with no previous key, which wraps them in the envelope
  under the key they are already under. API keys issued before key ids record one when they next
  authenticate; with no rotation under way `rotate:status` lists them without holding its exit
  code at 1, so an installation that upgrades and never rotates can still reach 0.
- Keys are trimmed of surrounding whitespace. A key that was configured with a trailing newline
  derives different subkeys after the upgrade, which the CHANGELOG says in its upgrade notes.
- An API key that never authenticates during the grace period cannot be moved, and fails once
  the previous key is removed. `rotate:status` lists every one so it can be revoked and
  reissued instead of discovered by a 401.
- A row with no stored value keeps the search token it was written with, since a token is
  recomputed only from a decrypted value, and stops matching search when the previous key goes.
  Status reports these rather than holding the rotation open for them.
- The re-encryption and the retention sweep each hold their advisory lock on a dedicated
  connection for the whole run, so each needs two connections, and a server
  `idle_in_transaction_session_timeout` shorter than one batch releases the lock early. Both
  check the lock before every batch and stop when it is gone, the command exiting 1 and the sweep
  reporting that it stopped early. Rewrites are conditional on the value read, so an early release
  costs a repeated run, not data.
- `infrastructure/compose.yaml` stacks now take the keys only from `defaults.env` and the
  root `.env`. Interpolating them in `environment:` meant a key set in `.env` never reached the
  API, so `ENCRYPTION_KEY_PREVIOUS` could not either. Shell exports no longer reach those stacks.
- `ADMIN_TOKEN` has no grace period. Rotating it signs every web session out, which is the
  point of rotating it.

## ADR-045: Deletion is hard, admin-only, and audited without the value

**Status:** Accepted

### Context

The retention sweep was the only way anything left the database: by age, per
environment, all or nothing. Redaction has missed secrets twice, and fixing the
matcher did nothing about the rows already written; the operator had to wait out
retention with the secret stored. An erasure request, a customer asking to be
forgotten, had no answer at all. A load test or a misconfigured service could
fill an environment with noise that could only be removed by dropping the
environment. And a replay destination whose headers no configured key could
decrypt kept `rotate:status` at exit 1 with no way to remove it short of editing
the database.

### Decision

Four deletions: one journey, every journey matching an identifier, an
environment's journeys in a `last_event_at` window, and a replay destination with
its replay runs. The first two and the last are in the admin API and the CLI;
the time window is in the CLI only; the web interface deletes one journey,
through a confirmation page.

Deletion is **hard**. Rows are deleted, and a journey's events, aliases, and
replay runs go with it through the existing cascades. A soft delete keeps exactly
what the operator asked to remove, and every read would have to remember to skip
it.

Deletion is **admin-only**. The admin token, a signed-in session, and the database
CLI can delete; an API key cannot, for the reason it cannot replay (ADR-032).

Every deletion writes one audit row **in the same transaction** as the delete. An
erasure's row holds the identifier's search token under the current key, never
the identifier: the identifier is the personal data being erased. A destination's
row holds its name and not its base URL.

Erasure matches by search token under every configured key, the same match search
uses, so "delete what search shows" is the model and a journey still under the
previous key during a rotation is found.

The two deletions that select by criteria have a **dry run** that reads through
the same selection the deletion uses, so it cannot drift from it. Both delete in
batches, one transaction each (500 journeys for an erasure, 1,000 for a range,
as the sweep), and both select only journeys created before the run started, so
a run ends however fast matching data arrives. Their audit row is written with
the first batch, kept current by every later batch, and marked `complete: true`
by the batch that finds nothing left. A range deletion holds the retention
sweep's advisory lock, on a dedicated connection as the sweep does, so the two
never run together.

### Consequences

- A crash part way through an erasure or range deletion leaves an audit row
  whose counts are exactly what committed and which says `complete: false`. Nothing
  is ever deleted without a row, and no row claims more than was deleted.
  Running the command again finishes the job.
- Journeys created during a run are left for the next one. The documentation tells
  the operator to run the dry run again afterwards.
- A journey updated while a range deletion runs can still be deleted after its new
  last event moves it out of the window, as with the retention sweep. The window
  is a selection at the time of the batch, not a guarantee against concurrent
  ingestion.
- Deleted rows remain in PostgreSQL's files until vacuum and in every backup taken
  before the deletion. `OPERATIONS.md` says so; the tool does not pretend
  otherwise.
- Deleting events inside a journey is not offered. A journey is the unit a reader
  sees, and a partial journey is harder to reason about than none.
- `audit_events` is still never swept, and now grows by one row per deletion.

## ADR-046: Error text is masked by shape, and stacks are kept only under full capture

**Status:** Accepted. Its content-hash limitation is closed by ADR-048.

### Context

Path redaction replaces a value by the name it is filed under (ADR-035, ADR-039). It cannot
reach a credential written inside a string, and ADR-039 recorded `error.message` and
`error.stack` as unsolved for that reason. Errors are where credentials end up in text: a
connection string in `ECONNREFUSED`, a header echoed by an HTTP client, a key quoted back by
the provider that refused it.

The Node SDK already sent no stack. Ingestion is public HTTP, though, and the protocol accepts a
16 KiB stack from any client, so a stack was stored whenever a client other than the SDK sent
one.

### Decision

`maskSecretsInText` in `payload-security` replaces credential-shaped substrings with
`[REDACTED]` and keeps the words around them. It recognises:

- URL userinfo, and the secret path segment of Slack and Discord webhook URLs.
- `Bearer`, `Basic` and `Digest` credentials of at least eight characters that do not read as
  prose, skipping the auth-params of a `WWW-Authenticate` challenge.
- Values assigned to a secret name. A name is split into words on `_`, `-`, `.` and case
  changes. The built-in names, compared as ADR-039 compares them, count in every form. Any other
  single word counts only from a short list (`token`, `signature`, `sig`, `passwd`, `pwd`,
  `pass`), when assigned with `=` or as a quoted key, or after an unquoted colon with a quoted
  value; a number assigned to `pass` is a count and is kept. `key` counts only as a query
  parameter. A name of several words counts when its last word is `password`, `passwd`, `pwd`,
  `passphrase`, `secret`, `token` (unless it follows `page`, `next`, `continuation`,
  `pagination`, `cursor`, `sync`, `resume`, `marker`, `csrf` or `xsrf`), `credential` or
  `credentials`, or its last two are one of `api key`, `secret key`, `private key`, `access key`,
  `account key`, `signing key`, `master key`, `shared key`, `encryption key`, `auth key`,
  `session key` or `client key`; never when its last word is `id`, `arn`, `name` or `url`. So
  `DB_PASSWORD`, `STRIPE_API_KEY` and `x-auth-token` are secrets, and `pageToken`, `SecretId`
  and `password_hash` are not.
- JSON Web Tokens, and PEM and PGP private key blocks.
- The prefixes providers put on their credentials: Stripe, Slack, GitHub, GitLab, AWS access key
  ids, Google API keys, OpenAI and Anthropic keys, npm tokens, SendGrid keys, Hugging Face tokens
  and this product's own `fr_` keys.

After an unquoted colon a value needs a blank before it, so `secret:prod/db` inside an ARN is a
path. An unquoted value that is a plain word after a colon, or after `=` and a blank, is read as
prose and kept. Attached to `=` it is a value: `DB_PASSWORD=changeme` is how `.env` and Compose
files hold the default and dictionary-word passwords that most need masking.

It runs in two places, the same function in both. The SDK masks every error record before it is
queued. It bounds the message and any string stack to the protocol's 4096 and 16384 characters:
it masks a window of twice the limit, cuts the result to the limit with a `[TRUNCATED]` marker,
and masks and cuts again until masking changes nothing, so a megabyte of message costs no more
than twice the part the server would accept, a credential straddling the cut is seen whole, and
the server's pass never rewrites what the SDK sent. Ingestion masks `message` before storing,
whoever sent it.

Ingestion drops `error.stack` unless full capture is in effect, which already takes both
`ALLOW_FULL_PAYLOAD_CAPTURE` and the environment's own `full-payload` setting. A team that opted
into full capture gets its stacks, masked like messages. There is no new setting.

It recognises shapes and never guesses at entropy. The identifiers this product exists to show
are long and random-looking: Salesforce ids, UUIDs, order numbers, hashes. Masking them would
destroy the record a reader came for.

### Consequences

- A credential in a shape the rules do not know is stored. This is the accepted cost of not
  guessing, and SECURITY.md lists the known misses: a single dictionary word as a credential in
  a prose position, a name written without separators such as `DBPASSWORD`, and the error's
  `type` and `code`, which are not masked.
- Masking is idempotent, so the second pass over an SDK event changes nothing. That property
  failed three times on generated input before it held, each time because one rule created a
  match for a rule that ran before it; a seeded generator now runs sixty thousand inputs in the
  unit tests.
- Error text reaches the masker from public HTTP, so its cost must grow in proportion to the
  text. Every pattern either anchors on a literal prefix or refuses to start inside a run of its
  own characters, and the post-processing of each match is a character loop rather than a
  second regular expression. The first version missed that last part: trimming trailing dots
  with `/\.+$/` was quadratic on a run of dots, and took almost two seconds on 64 KiB, while a
  16 KiB wall-clock test still passed. The tests now time every adversarial case at 16 KiB and
  64 KiB and require the larger to take less than eight times as long, which linear work meets
  and quadratic work cannot, with one absolute ceiling beside them. That is a measurement over
  the shapes the tests know, not a proof for every input.
- `metadata` string values and payload strings keep path redaction only. Scanning every string
  in every payload for shapes would put this cost, and its false positives, on the data the
  product exists to show.
- Stacks from an environment below full capture are gone for good, including any event sent
  before a team turns full capture on. Rows written before this decision keep their messages and
  stacks unmasked; removing them is what deletion on demand is for (ADR-045), not this change.
- **Known limitation, not fixed here.** The content hash is an unkeyed SHA-256 over the event as
  received, before masking and redaction (ADR-021), and it is stored beside the row. Someone with
  read access to the database can test guesses at a low-entropy secret, such as a short
  password in a connection string, by rebuilding the event from the row with a candidate in
  place of `[REDACTED]`, hashing it and comparing. That works when everything else the hash
  covered is in the row or guessable, which a masked error message on an event with no dropped
  payload often is. The same was already true of redacted payload values. Keying the hash
  would close it, and would change every stored hash, so it belongs in its own decision.
  **Closed by ADR-048**, which keys the hash.

## ADR-047: Metrics on their own port, in a format written here

**Status:** Accepted

### Context

An operator running Flight Recorder without its author could not alert on
anything. Rejected events, a retention sweep that stopped completing, a pool
with requests waiting for a connection, and slow queries were visible only by
reading logs, and a sweep that silently stopped wrote no log line at all. ADR-026
chose a log line per sweep over a metrics endpoint to avoid a dependency, and
ADR-012 keeps every observability platform optional. Prometheus's text format
is what nearly every monitoring system scrapes, whether or not the team runs
Prometheus itself.

### Decision

The API serves Prometheus text exposition at `/metrics` when `METRICS_PORT` is
set, on that port alone. Unset, the default, starts no listener. `/metrics` on
the API port is 404, and Compose and the Helm chart publish the metrics port
nowhere, so exposing ingestion to the services that send events never exposes
metrics with it.

The format is written in the API rather than taken from `prom-client`. Counters,
gauges, and one histogram need label escaping, cumulative buckets, and `_sum` and
`_count`, which are a few dozen lines and have unit tests. A client library would
add its own dependency tree to a process that holds every captured payload and
the key that decrypts identifiers, and another feed of advisories to track.

Labels are bounded by the code, never by traffic: `route` is the router's
pattern, with `unmatched` for anything that matched no route; `method` is one of
seven values or `other`; every other label takes a fixed set of values. No label
carries a project id, a key prefix, an entity, or any request value.

### Consequences

- An operator can alert on rejected events, stalled retention, query timeouts,
  and pool pressure (`docs/OPERATIONS.md` §13) without adding anything to the
  default install.
- The endpoint has no authentication. It is reachable only where the operator
  routes the port, and it carries counts rather than data.
- Summaries, exemplars, OpenMetrics negotiation, and the default process metrics
  a client library adds are not provided. Two process gauges are: resident
  memory and event loop lag. Anything more is a change to this module, not a
  configuration option.
- Counters are per process and reset on restart, as with any Prometheus client;
  the documentation says to alert on `increase()`.
- The retention sweep's log line stays, for installations that read logs and do
  not scrape.

## ADR-048: The content hash is keyed, and compared under the key it names

**Status:** Accepted. Amends ADR-021 and closes the known limitation recorded in ADR-046.

### Context

ADR-021 stores a `content_hash` beside each event so ingestion can tell an identical resend
from an event id reused for different content. It is computed over the event as received, before
redaction and masking, so a server-side policy change cannot manufacture conflicts, and it was an
unkeyed SHA-256.

That made it an offline oracle. The security review ingested an error whose message carried a
dictionary password in a connection string, read the row as someone with database access and no
`ENCRYPTION_KEY` would (a dump, a replica, a backup), rebuilt the event from the row with each
dictionary word in place of `[REDACTED]`, and recovered the password by hash match. ADR-046
recorded exactly this as a known limitation and left it for its own decision because keying the
hash changes every hash written afterwards.

### Decision

The hash is an HMAC-SHA256 of the same canonical serialization, under a subkey HKDF derives from
`ENCRYPTION_KEY` with the label `flight-recorder/content-hash`, beside the three subkeys ADR-044
already derives. It is stored as `h1.<keyId>.<hex>`, the key id being the fingerprint ADR-044
stores on encrypted values.

Ingestion writes under the current key. On an id that already exists, it compares by recomputing
rather than by string equality: under the key the stored value names, current or previous; and
for a value with no prefix, a hash written before this decision, by computing the unkeyed SHA-256.
A resend that straddles the upgrade or a rotation therefore still dedupes.

No migration. Legacy hashes stay comparable, and rewriting them is impossible anyway: the hash
is of the event as received, which is not stored.

### Consequences

- A database read alone no longer confirms guesses at a masked or redacted value. Anyone holding
  `ENCRYPTION_KEY` still can, as they can already decrypt identifiers.
- Rows written before this decision keep their unkeyed hashes, and those rows stay an oracle for
  what they masked until they are deleted or age out under retention (ADR-045).
- `rotate:reencrypt` does not touch hashes, because it cannot: a hash can be recomputed only from
  the event. Once `ENCRYPTION_KEY_PREVIOUS` is removed, a resend of an event whose hash names the
  removed key cannot be compared and is refused with 409 `event_id_conflict`, which the SDK
  treats as permanent. Only a duplicate delivery of an event older than the rotation's grace
  period is affected; the stored event is untouched. `rotate:status` does not count hashes, since
  holding a rotation open for them would hold it open until retention removed every row.
- An online confirmation oracle remains, by design (ADR-021): someone holding an ingest API key
  for the environment and read access to a row can confirm a guess at a masked value by resending
  the rebuilt event under the same event id, since an identical event is answered 202 duplicate
  and a different one 409, and this holds for legacy rows too. It costs one request to the API
  per guess rather than one hash, and needs a credential that can already write events.
- One HMAC per ingested event, and a second only when an id already exists. The cost is the same
  order as the SHA-256 it replaces.

---

## ADR-049: The contract is the deliverable, and a second SDK waits for a team that needs one

**Status:** Accepted. Amends the wording of ADR-010 on OTLP ingestion, not its principle.
ADR-059 first superseded the pilot-demand condition for Python; ADR-065 now supersedes it for
Go too and sets Python → Go → optional OTLP. The rest of this decision stands, including that
each native SDK is built against `docs/SDK_SPEC.md` and passes the conformance fixtures. The
title and historical rationale are left as written.

### Context

ADR-003 chose TypeScript across V0 and left "language-neutral protocol design is still required"
as a consequence nobody has since had to satisfy. `AGENTS.md` bans a native SDK in another
language without an architecture decision. ADR-010 keeps OpenTelemetry optional and says V0 will
not implement an OTLP receiver.

Today the contract exists only as TypeScript. `packages/protocol` holds the Zod schemas,
`apps/api` holds the ingestion rules in code, and `docs/NODE_SDK_SPEC.md` describes one SDK in
the language it is written in. Somebody writing a recorder in another language, or a mapping from
OpenTelemetry log records, has nothing to build against and no way to check the result. The
product now needs teams that are not this repository to be able to send events, and the cheapest
thing that makes that true is not a second SDK.

### Decision

Publish the contract as artefacts an author outside TypeScript can use: JSON Schema generated
from the Zod schemas, an HTTP ingestion contract in `docs/INGESTION_CONTRACT.md`, a
language-neutral SDK specification in `docs/SDK_SPEC.md` with MUST and SHOULD requirements, a
dry-run validation endpoint, and conformance fixtures under `packages/protocol/conformance/` that
any implementation can run through it.

Zod stays the source of truth. The JSON Schema is generated and checked for drift, never
hand-edited.

OpenTelemetry log records over OTLP HTTP become a planned optional ingestion path rather than
something V0 refuses. That amends ADR-010 in wording and not in principle: no deployment of this
product requires OpenTelemetry, and the Node SDK stays the recommended path for Node.

Framework adapters are separate packages over the SDK's public API. A second native SDK is built
when a pilot team needs one, against `docs/SDK_SPEC.md`, and it is not considered done until it
passes the conformance fixtures through the dry run.

### Also decided here, because the contract cannot be published while it is ambiguous

`AGENTS.md` said unknown protocol fields "must be preserved where safe". Ingestion accepts them,
drops them, and does not include them in the content hash, because there is no column to store
them in and an unvalidated, unredacted field is not something to write to one. The rule means
"accepted, not refused", which is what makes an additive optional field a compatible change. The
`AGENTS.md` line is reworded to say so. Storing them would be a schema change and its own
decision.

Three codes in `PROTOCOL_ERROR_CODES` are removed rather than reserved:
`missing_required_field`, `invalid_timestamp` and `invalid_operation`. No code path has ever
emitted them; every one of those conditions is reported as `invalid_event` with the failing field
in `details`. A published registry that lists codes no implementation sends would tell the author
of a second SDK to branch on something that never arrives. Removing them is free while nothing is
published. The contract instead tells a client to treat any code it does not know by its status,
so adding a code later stays a compatible change.

### Consequences

- Contract artefacts become things that can rot, so each carries a test that fails when it
  drifts: schema drift against the committed files, Zod against Ajv over every fixture, the
  documented limits against the constants, the documented refusals against the code registry, and
  fixtures that run against the real API.
- A conformance fixture change is a contract change and is reviewed as one.
- The dry run is a new refusal path that leaves no row behind, which is a small new disclosure
  surface. Its own decision is ADR-050.
- Wire identifiers are not frozen by this decision. The propagation specification and its test
  vectors, and the OTLP attribute mapping, wait for the rename, because every requirement in them
  is a name the rename changes.

### Rejected

- **A native SDK per language.** The cost of the Node SDK's Phases 3 and 4 each time, plus
  maintenance forever, for a language nobody has asked for yet.
- **Becoming a pure OpenTelemetry backend.** The input and output pairing the payload diff
  depends on becomes a convention nobody enforces, and it is a pivot before any user asked for
  one.

---

## ADR-050: A dry run is a real ingestion that is rolled back

**Status:** Accepted. Follows ADR-049, which makes the contract the deliverable.

### Context

ADR-049 publishes conformance fixtures so that an implementation that is not this
repository can check itself against the real server. Running them means sending events, and
sending events means storing them: a conformance suite that sends refusals on purpose would
leave a trail of journeys in whatever database it ran against, and a mapping under development
would pollute the environment it was being developed against.

A validation endpoint that answered from a second implementation of the rules would be worse
than none. It would answer confidently about a server that behaves differently, and the first
divergence would be invisible.

### Decision

`POST /v1/events/batch?dryRun=true` runs the whole batch inside one transaction, each event
through the same `ingestEvent` inside a savepoint, and rolls the transaction back before
replying. It answers `200`, not `202`, because nothing was accepted for processing, and its
body is a batch response with `data.dryRun: true`.

An accepted, non-duplicate result carries `stored`: the event as `GET /v1/events/:eventId`
returns it, without `receivedAt`, and the journey as `GET /v1/journeys/:journeyId` returns it,
both read inside the transaction through the same repository functions and the same presenters
the read routes use. That is what lets a fixture state an expected stored event against a shape
the API already publishes rather than against a private representation.

The flag is a query parameter rather than a body field, so a conformance case's body is the
same bytes whether it is sent for real or validated. It is strictly `true` or `false`, given
once; anything else is `400 invalid_query`. `POST /v1/events` refuses the parameter entirely,
rather than ignoring it, because a client that guessed the wrong route would otherwise store
real events while believing it had validated them.

### Why a rolled-back real ingestion, and not the alternatives

- **A separate validation path** would have to reimplement PostgreSQL's rules. Only the insert
  discovers `unstorable_payload`: a NUL byte and an unpaired surrogate are refused by the
  database, not by any check in front of it. It would also have to guess at what `jsonb`
  normalizes, since key order and duplicate keys are settled by the database.
- **Per-event isolation without a shared outer transaction** would answer ordering wrong. The
  same event id twice in one batch is an accept and a duplicate, and a journey created by the
  first event is what the second event is checked against.
- This is the property ADR-045 chose for the deletion dry runs, for the same reason: they read
  through the same selection the deletion uses.

### Bookkeeping

A dry run updates the key's `last_used_at`, under the same once-a-minute throttle, and a key
whose verifier is under the previous key is still migrated onto the current one. Both answer
"is this key in use", and a key used only by a conformance job in CI is in use: leaving it
stale would invite an operator to revoke the key CI depends on, and skipping the migration
would leave that key failing once a rotation's grace period ended. Those two writes are about
the key rather than about the events. "Nothing is stored" here means no event, journey, alias,
summary or audit row.

Dry-run events are not counted in the ingested-events counter, because an operator alerting on
rejected events must not be paged by a conformance suite that sends refusals on purpose. No new
metric is added: a counter's name would carry the product name this work must not freeze, and a
count of validations is not something to alert on. HTTP request metrics count the request as
usual.

One line is logged per dry-run request at info level, with the request id, the API key's row id
and the counts of events, accepted and rejected. No values and no ids from the events.

### Cost, and rate of use

No separate rate limit and no separate body or batch limit. Ingestion has none today, and
inventing one only for the dry run would be a control in the wrong place. A dry run costs what a
real send costs plus the rollback, and it holds its row locks for the length of the batch rather
than the length of one event, so a conformance run should use its own environment and its own
journey ids rather than journeys a live service is writing to. An SDK must not use it in normal
operation; it is for conformance suites, for a setup check, and for a mapping under development.

### Security consequences

- **It is a probe that leaves no row.** Testing whether an event id or a journey id exists means
  sending an event today, and a wrong guess stores a journey somebody can see. A dry run answers
  `event_id_conflict` or `journey_environment_mismatch` without writing anything. It needs an
  ingest key for the project, it cannot read any value back beyond what the caller sent, and
  journey ids are random so they cannot be guessed (ADR-038). The info log line is the
  compensating trace.
- **The online confirmation oracle of ADR-048 is unchanged in kind.** Somebody holding an ingest
  key and database read access can already confirm a guess at a masked value by resending a
  rebuilt event. The dry run makes that quieter, not cheaper, and it is one request per guess
  either way.
- **The preview returns what the sending key could already read.** The stored event is the one
  the caller sent, after this installation's own capture, redaction and masking. The stored
  journey is the whole journey as a read of it would show it: when the event joins a journey
  that already exists in the caller's environment, the preview includes that journey's earlier
  label, services and displayable aliases, with masked aliases still masked. The same key can
  already read that journey by its id, so nothing new is disclosed. The preview does show the
  shape of the environment's redaction policy, which the caller can already infer by sending an
  event and reading it back.
- **The transaction holds its locks longer, and the cost falls on somebody else.** A batch of a
  hundred events holds every row it touched until the rollback, where a real send releases each
  after its own event. A real ingestion contending for one of those rows waits, and is cancelled
  by `DATABASE_STATEMENT_TIMEOUT_MS` if it waits too long; it is answered `503 query_timeout`,
  which a client treats as transient and retries, so nothing is lost. But a dry run is a request
  anybody holding an ingest key can make, and this is the one way it can affect a live service
  rather than only its own transaction. The contract says so, and says to use a separate
  environment and separate journey ids for a conformance run.

---

## ADR-051: The SDK fits an event to the server's limits, by the server's own check

**Status:** Accepted. Changes what `maxPayloadBytes` means, and stops the SDK scaling its
string limit with it.

### Context

The SDK measured each payload on its own against `maxPayloadBytes`, and raised its string
limit to the same number so that raising the budget would let a long HTML body through. The
API measures the whole envelope, with `MAX_EVENT_PAYLOAD_BYTES` for bytes, strings at 65,536
UTF-16 code units, and depth counted from the envelope's root. Nothing on the server scaled.

Instrumenting a real job showed what that disagreement costs. A 70,000 character string was
refused `max_string_length_exceeded`; two payloads that each fit the budget were refused
`payload_too_large` together; a payload 31 levels deep would be refused for depth. Each time
the SDK had counted the event as fine, and each time the server refused the whole event, so
the step vanished from the timeline rather than losing only its payload. The job worked around
it by fitting events itself before the SDK saw them.

### Decision

**Truncate, then omit.** Before an event is queued, the SDK applies exactly the limits the API
enforces, using the same functions:

- `packages/payload-security` exports `eventLimits(maxEventBytes)`, which ingestion calls on
  every envelope, and `payloadLimits(maxEventBytes)`, the same limits placed two levels down
  where a payload sits, with long strings measured as they will be cut.
- A payload that fails `payloadLimits` is replaced with `[PAYLOAD_TOO_LARGE]`, as before.
- Every string over 65,536 code units is cut, after redaction, to its start and
  `[TRUNCATED: <n> characters removed]`, exactly 65,536 code units in all.
- The envelope is then checked with `eventLimits`. While it is over the byte budget, the larger
  of `input` and `output` is replaced with the marker, then the other, then `metadata` is
  dropped. The event is always sent.
- A `payload_truncated` diagnostic and a `payloadsTruncated` counter report a payload sent with
  a string cut, separately from `payload_omitted`. Neither is part of
  `sent + rejected + dropped`.

`maxPayloadBytes` is now the byte budget of one event and should equal the server's
`MAX_EVENT_PAYLOAD_BYTES`. The default, 262,144, is unchanged.

Truncation is per string, because the limit is per string and the case that found it was one
long field among many short ones. It happens after redaction, so a cut can only shorten a
string that has already been masked.

### Consequences

- An event the SDK sends is one the server's limit check has already passed, and a unit test
  in `apps/api` runs hostile inputs through the recorder and then through `ingestEvent` to
  hold that. It found a defect on its first run, in the test harness rather than the SDK: the
  stub endpoint decoded request chunks one at a time, so a two-byte character split between
  chunks arrived as two replacement characters.
- A payload with a long string is now stored, cut, where it used to be stored as a marker (on
  the SDK's side) or lost with its event (on the server's). `maxPayloadBytes` set above the
  server's limit no longer lets a long string through; it could never be stored anyway.
- Capture costs one more serialization per event, of the envelope. The payload check already
  serialized each payload.
- A review found that a cut could defeat the server's header masking, which read only text
  containing a CRLF. A block whose first header is secret only by the environment's redaction
  paths, with a value over the limit, lost its only line break, and about 65,500 characters of
  the value were stored unmasked where the event used to be refused. Two changes close it: the
  SDK puts the marker after a CRLF when the string held one, and the server reads text ending
  in the marker as a header block. `sdk/truncated-header-block` and
  `wire/truncated-header-line-masked` hold both halves.
- A client in another language gets the same guarantee only by doing the same thing, which
  `SDK_SPEC.md` now requires.

---

## ADR-052: A journey id may be derived from the entity, under a secret the host holds

**Status:** Accepted. Qualifies ADR-038, which makes journey ids random so they cannot be
guessed.

### Context

A job with no store of its own, run on a schedule, meets the same record on many runs and
wants each run's steps in one journey. Storing the id loses it in exactly the case it matters,
when a run fails before writing its state. The job that found this derived the id from the
entity with an unkeyed SHA-256, which is stable and also predictable: anybody who knows the
entity and the scheme can compute the id. A predictable journey id is what
`INGESTION_CONTRACT.md` section 5 warns about. A key for another environment, or a forged
propagated context, can claim the journey first or append to it, and a guessed id is a way to
learn whether a journey exists.

### Decision

The SDK derives journey ids only under a secret the host configures, `journeyIdSecret`, of at
least 32 bytes. `recorder.journeyIdFor(entity)` returns the prefix and the first 32 hex
characters of HMAC-SHA256 over the length-prefixed label `journey-id/v1`, the recorder's
environment, the entity type and the entity id. The environment is in the message because a
journey cannot span environments (ADR-038). Length prefixes rather than a separator keep an id
containing the separator from meeting another. The derivation is SDK-55 in `SDK_SPEC.md`, with
vectors in `packages/protocol/fixtures/journey-id-derivation.json` computed outside this
repository's code.

The SDK reads no environment variable for the secret (SDK-50).

**Without a usable secret, nothing throws.** A secret that is configured and too short, or not a
string, is reported once as a `configuration_error` when the recorder is created, and is never
used. A call to `journeyIdFor` without a usable secret, or with an entity whose type and id are
not strings, reports a `configuration_error`, counts it in `configurationErrors`, and returns a
fresh random journey id.

### Why not throw

A missing secret is a programming error in shape, but it reaches the SDK as configuration, and
configuration is usually read from the deploy environment. Throwing from `createRecorder` breaks
startup, which SDK-6 forbids. Throwing from `journeyIdFor` breaks the host's own code path in
the one deployment where the variable was not set, which SDK-1 and ADR-007 forbid. Returning a
random id keeps recording and never produces anything guessable; the cost is that the journeys
split until the secret is set, and the counter, the diagnostic kind and `logDiagnostics` say so.

### Why not an unkeyed hash

It is predictable. A secret makes a derived id as hard to guess as a random one to anybody who
does not hold it. Rotating the secret starts a new journey for every entity; the old ones are
kept and nothing links them.

### Consequences

- A derived id is stable across runs and machines and unguessable without the secret. It is
  exactly as strong as the secret, which is why a short one is refused rather than used.
- The derivation is a SHOULD. An SDK without it still conforms.
- The prefix is the one random ids carry, and will change with the rename; the vectors will be
  regenerated then.
- After review: an entity holding an unpaired surrogate is refused rather than derived, since
  UTF-8 encoding would give it the id of its U+FFFD replacement; the fixture lists such
  entities under `refused`. And a missing or short secret prints one warning per process even
  with `logDiagnostics` off, the one exception to SDK-40, because a counter nobody reads does
  not stop journeys splitting in production.

**Amendment (2026-09-16, claims audit).** "The one exception to SDK-40" was true when this was
written and is not now. SDK-40 allows three kinds of unasked warning (SDK-56, SDK-60, SDK-61),
and the Node SDK prints four: this one, a required setting that is missing, empty or not a
string, a setting under its old name, and a secret-looking field name sent in plain text
(`packages/sdk-node/README.md`, "It cannot break your application"). The decision above is
unchanged.

---

## ADR-053: Instrumenting code may mark an alias displayable, and it takes every statement to keep it so

**Status:** Accepted. An exception to the alias masking in `apps/api/src/routes/present.ts`.

### Context

Every alias value is masked when it is read, because an alias is another identifier for the
record and the reader may not be entitled to it. That is right for an email address or a
customer number. It is wrong for an identifier that is public by nature, such as a job
posting's id on a public board: the job that found this could not tell two postings apart on
the journey page, because both read `gree…567`.

The owner decided the shape: display is opted into per alias by the instrumenting code, which
knows what the identifier is; everything else stays masked exactly as before.

### Decision

- **Wire.** The event gains an optional `displayableAliases`, a list of alias types from the
  same event's `aliases` that may be shown in full: at most 1,000 entries of at most 128
  characters. Alias values keep their type. A type the event's `aliases` does not name is
  ignored rather than refused, because refusing would lose the event over a flag that can only
  mask. A server that predates the field accepts and drops it (ADR-049), so every alias stays
  masked there.
- **Storage.** `entity_aliases.displayable boolean not null default false`, migration 017.
- **Two statements that disagree.** An alias is displayable only while **every** event that
  stated it listed it. The first insert stores the event's flag; a later statement can lower
  it and never raises it.
- **Reads.** `GET /v1/journeys/:journeyId`, and the dry run's `stored.journey`, return each
  alias as `{ type, displayValue, displayable }`. `displayValue` is the whole value when
  `displayable` is true and masked exactly as before otherwise, including for a short value.
- **SDK.** `identify(aliases, { displayable })`, `startJourney({ ..., displayable })`, and
  `displayableAliases` on `record()`. The default is none.

### Why every statement, and not the latest

Events do not arrive in the order they happened. A batch is retried, several processes record
the same record, and a resend of an old event is answered as a duplicate only if its content
is identical. "The most recent statement wins" would therefore mean the most recently
*arrived*, and a retried old event could unmask a value that a newer one had deliberately
masked. The conjunction is order-independent and idempotent, errs toward masking, and a
mistaken `displayable` is corrected by one event that states the alias without it. The cost is
that a host must list the type every time it states the alias, which the SDK README says.

A statement that does not mention an alias at all is not a statement about it: an event with
other aliases, or none, changes nothing.

### Why a column with a default is safe on a live database

PostgreSQL 11 and later add a column with a constant default as a catalogue change: existing
rows read the default without the table being rewritten. The ALTER still takes an exclusive
lock for an instant, and waits for every transaction already using the table while new
inserts queue behind it, so the migration sets `lock_timeout` to five seconds and fails rather
than stalling ingestion; running `migrate` again retries it. The previous API, still running
between migrate and deploy, inserts without the column and gets `false`. A test asserts the
table's file is not rewritten and that the migration gives up behind a held lock.

The upsert writes only when the flag moves from true to false, so a service that repeats
`identify` on every event does not turn a no-op into an update. Key rotation keeps the rule: a
row moved onto the current token keeps its flag, and a stale duplicate's flag is folded into
the row that survives before the duplicate is deleted.

### Consequences

- A reader sees an identifier in full only because the code that recorded it said so, every
  time it said anything about it. Nothing a reader sends can change that.
- The stored journey schema gains a required `displayable` on each alias. That is a new field
  in a response, which a client ignores if it does not know it.
- Search, erasure and retention are unchanged: they match on the search token, not the display
  value.

## ADR-054: A journey may carry a public label, and the journey list matches partial text on public values only

**Status:** Accepted. Builds on ADR-053 (displayable aliases) and ADR-044 (encrypted
identifiers and search tokens). Changes `GET /v1/journeys` and replaces the Recent page.

### Context

Dogfooding the recorder on job-radar showed that the interface answered two questions only:
"show me the journey for this identifier", through Search, which matches exactly, and "what
failed recently", through the Recent page. The owner could not browse what happened in a
period, and could not find a record from something half remembered, such as a company name
or part of a URL.

Entity identifiers and alias values are encrypted and matched through keyed search tokens,
so the server can match them only exactly, and that has to stay true for masked values. Two
kinds of value, however, are declared public by the code that records them: aliases marked
displayable (ADR-053), and a label, which did not exist yet.

### Decision

- **A label.** An event may carry `journeyLabel`, public display text for its journey of 1
  to 200 code points, set by the host (`journey.label(text)` in the SDK). An empty string
  refuses the event; an event without the field leaves the label alone. The label is not
  redacted.
- **Latest operation start wins.** The journey keeps the label of the event with the
  latest `timestamp` (the operation's start, ADR-031), whatever order events arrive in. The
  journey's last step (the `name` of that latest event) follows the same rule. Timestamps are
  compared at millisecond precision, the precision they are stored at, and the Node SDK
  stamps whole milliseconds, so a quick journey's events often tie. A tie is broken as the
  timeline breaks it: by the order the server received the events, then by the larger event
  id compared byte by byte. Breaking it by event id alone was the first design, and since
  the SDK makes ids at random it kept a random step as the last one, and an earlier label
  after `label()` was called again. With arrival order, events sent one after another keep
  their order; events sent concurrently in different requests are received in no
  guaranteed order. A label is public by declaration, so an old event that
  arrives late can at worst leave a stale label, never expose anything.
- **Plain-text copies of displayable values.** `entity_aliases.display_value` holds the
  alias value in plain text while, and only while, the alias is displayable. The upsert that
  lowers the flag clears it in the same statement. The database enforces the rule with the
  check constraint `entity_aliases_display_value_only_when_displayable`
  (`displayable or display_value is null`), so no code path can leave a masked alias with a
  plain value. A `BEFORE INSERT OR UPDATE` trigger,
  `entity_aliases_clear_masked_display_value`, clears the copy of any row about to be written
  masked. It exists for the previous build, which keeps ingesting during a rollout and lowers
  the flag without knowing the copy exists: without the trigger its masking statement would
  violate the check, fail the event, and put the row, value included, into the error log.
  A value containing a NUL gets no copy, because a text column cannot hold one and the event
  must not fail over it; it is read in full on the journey page and is never listed or
  matched by text.
- **Partial matching over those values only.** `GET /v1/journeys` takes `q`, 2 to 200
  characters, and keeps a journey whose label or displayable alias value contains it,
  ignoring case (`ILIKE`, with `%`, `_` and `\` escaped). It is always bounded by the
  required `since` and an optional new `until`, so it scans a window, never the table. The
  list also gains `entityType`, and each row gains `label`, `lastStep` and
  `displayableAliases`.
- **The Recent page becomes Journeys.** `/journeys` is a table of journeys over a chosen
  period (the last 24 hours and any status by default) with a Contains box and a Failures
  shortcut, and `/recent` redirects to it with its query string.
- **Two indexes, from measurement.** At 120,000 journeys, text over 30 days took about
  850 ms at p95 for an admin. Migration 019 adds `journeys_project_recent_idx` and the
  partial covering index `entity_aliases_displayable_idx`, built concurrently; the same
  cases then took 5 ms when text matched and about 300 ms when it matched nothing, and
  ingestion measured the same with and without them (`docs/OPERATIONS.md` section 10).

### What is deliberately not matched

`q` never matches a masked alias value, an entity id, a journey id or an entity type, even
when the text is exactly one of them. Those remain exact-match through Search and the search
tokens. Matching them by partial text would need them in plain text, which is the exposure
ADR-044 exists to prevent.

### Alternatives rejected

- **Filtering the rows already loaded, in the browser.** It needs no server change, but it
  finds only what is on the current page, so it answers "is it among these 25" rather than
  "did it happen this week".
- **Full-text search over payloads.** It would find the most, and it reaches data nobody
  declared searchable, needs an index over every payload, and makes redaction the only thing
  standing between a query box and a customer's details. Deferred until partial matching on
  public values proves too narrow.
- **Showing every alias value in full.** It would make every alias matchable, and it undoes
  masking for identifiers such as email addresses and customer numbers that the reader may
  not be entitled to (ADR-053).

### Consequences

- Plain text now exists in the database for values the host declared public: labels, and
  copies of displayable alias values. When an alias is masked the live row's copy goes at
  once, but earlier row versions, WAL, replicas and backups keep the text until vacuum and
  their own expiry, and destroying `ENCRYPTION_KEY` does not make it unreadable
  (`docs/SECURITY.md` section 6).
- What a label says is the host's responsibility. It is shown and matched as written, and
  it must not hold personal data.
- "Ignoring case" depends on the database's `LC_CTYPE`: under a UTF-8 locale `CAFÉ` finds
  `Café`, under the `C` locale only ASCII letters fold (`docs/API_SPEC.md` section 6).
- There is no backfill. A journey recorded before migration 018 has no label or last step
  until new events arrive, and only aliases stated displayable after the upgrade get a
  plain-text copy.
- `GET /v1/journeys` now refuses a query key it does not read with `400 invalid_query`,
  where it used to ignore it. A client that sent extra keys has to stop.
- Text that matches nothing still tests every journey in the window, so its cost grows with
  the window: an installation recording tens of thousands of journeys a day should search a
  day or a week rather than a month.

---

## ADR-055: A secret-looking name no rule covers is warned about, never redacted on a guess

**Status:** Accepted. Builds on ADR-035 (any-depth secret names), ADR-039 (name
spellings) and ADR-007 (host safety). Adds an SDK diagnostic, an SDK option, a doctor
check, a conformance field and eight built-in secret names; changes nothing on the wire.

### Context

Redaction matches a secret by the name it is filed under: the built-in names and the names
an operator configures. A credential under any other name is stored in plain text, and
nothing said so. Renaming `authToken` to `sessionCredential` was enough.

### Decision

- **Warn only.** The owner decided that a name that looks like a secret is reported and
  never redacted automatically. Replacing values on a guess would change what the timeline
  and its diffs show, and a diff that hides a real change is the failure this product exists
  to prevent.
- **One name rule, by the end of the name.** `looksLikeSecretName` in `payload-security`
  folds a name as redaction does, drops a version suffix, and matches its end against a
  fixed table of terms, with exceptions (pagination, idempotency, cancel and tokenizer
  tokens such as `nextPageToken`, `ClientRequestToken`, `bos_token`), qualified short terms
  (`pin`, `pwd`) and one term that counts only alone (`hmac`). Connection strings, database
  URLs and DSNs count, because they carry a password. Bare `key`, `session` and `code` are
  not terms. Personal data such as `ssn` or `cardNumber` is not either: this warns about
  credentials, and whether personal data is captured is the capture mode's question. The rule
  is written out in `SDK_SPEC.md` section 13 and checked against 70 secret and 87 ordinary
  names from Stripe, Salesforce, HubSpot, GitHub, AWS, Azure, OAuth, Slack and tokenizer
  configurations.
- **A value rule beside it.** A value is reported when it is a number, or a non-empty
  string that is not the marker and not one of the setting words `true`, `false`, `none`,
  `basic`, `bearer`, `oauth`, `required`, `optional`. Under a name ending in `auth` a string
  must also be at least 8 characters, because `auth: "jwt"` is a setting. That minimum is
  not applied to every term: PINs, card codes and one-time codes are real secrets of 3 to 6
  characters. An object under such a name is a container whose keys are examined in turn,
  and a boolean such as `hasPassword` is never a credential. A redacted value is never
  reported, so a name a rule covers never is.
- **In the SDK, found by the redaction walk.** `redact` takes an optional observer, so the
  warning costs no second traversal. It covers object keys and the header shapes redaction
  already reads: name-value pairs, `{name, value}` objects, interleaved lists and the lines
  of a header block. The Node SDK collects what the walk found and reports
  `unredacted_secret_name` only for payloads the event actually carries after its budget is
  fitted, with the field, the name and its path (array indices as `[*]`), never the value;
  once per recorder and name; printed once per process and name whatever `logDiagnostics`
  says, a third exception to SDK-40; counted in `unredactedSecretNames`. At most 100 names
  are remembered, and a name longer than 256 characters is remembered by its SHA-256, so
  attacker-chosen key names cannot hold the host's memory: an earlier version kept 100
  names of 200 KB, about 20 MB, alive. `onDiagnostic` receives the name as written, cut to
  128 characters and not masked, as it receives other diagnostics; the printed line is
  masked. A name containing `.`, `*`, `[` or `]` cannot be named by any redaction rule, so
  the advice for it is to rename the field or leave it out.
- **`knownSafeNames`.** A false positive that cannot be quieted prints at every deploy, and
  the only other way out would be redacting a value that is not secret. The SDK takes key
  names it does not warn about, any non-empty string, including ones no rule can name. They
  do not affect redaction (SDK-62). `sessionId` keeps warning, because a server session id
  is a credential; an analytics session id is what this option is for.
- **Webhook signature headers are redacted by default.** `stripe-signature`,
  `x-hub-signature`, `x-hub-signature-256`, `x-slack-signature`, `x-hubspot-signature`,
  `x-hubspot-signature-v3`, `x-twilio-signature` and `x-shopify-hmac-sha256` join the
  built-in list. A signature is not the signing secret, but stored beside the body it signs
  it is a request the receiver accepts, and GitHub's carries no timestamp, so the pair stays
  valid for as long as the secret does. Warning instead would have fired on every recorded
  webhook from these providers, and a default everybody silences is no default. The cost is
  that a signature mismatch can no longer be debugged by reading the stored header; the
  generic `signature` term still warns for names the list does not cover.
- **On the server, in `doctor`.** A sender that is not the Node SDK never sees the warning,
  so `doctor` samples what was stored: the cap of 2,000 events is shared evenly between
  environments, and each environment gives the 5 latest events of its 100 most recently
  active journeys, in a stable order, so one busy environment cannot fill the sample. It
  reads through index scans, in a read-only transaction cancelled after 5 seconds, and
  applies the value rule in SQL. Only key names and counts leave the database; the name rule
  runs on them in doctor, and printed names are masked like the SDK's line. It warns and
  never fails: a cancelled sample, or one that cannot run at all, is a warning with the
  reason. On 600,000 events (626 MB) in four environments it read 1,600 events in about
  155 ms warm, 168 ms cold, touching 7,698 shared buffers.
- **Cost.** Measured with `packages/sdk-node/bench/secret-names.mjs` on a 5.6 KB webhook
  recorded as input and output, five runs alternating with a build of main, medians:
  `record()` went from 180.1 to 187.3 microseconds per event (+4%) with no secret-looking
  names, and from 182.1 to 191.4 (+5%) with two reported. `redact` alone costs about 3.5
  microseconds more per payload with the observer. Part of the added walk cost is paid for
  by parsing a frozen rule list once instead of on every payload. The first version cost
  about 45% more, and an intermediate one about 8%; looking terms up by a name's last
  characters, reading positional headers once, and caching the rules brought it here.
- **The API does not report it.** A response field would be a wire change every SDK has to
  handle, for a warning a sender cannot act on at runtime. A log line per new name would put
  payload-derived names into the API's log on the ingestion hot path, need a set bounded
  against hostile senders, and repeat per replica. Ingestion is unchanged apart from the
  longer built-in list. Revisit if a pilot team runs another sender and does not run doctor.
- **Conformance.** A case may carry `expect.diagnostics` and `expect.absentFromDiagnostics`;
  `sdk/unredacted-secret-name` checks the reports, that no recorded value appears in any
  diagnostic, and the unchanged event.

### Alternatives rejected

- **Redacting secret-looking names by default.** Safer for the stored data and wrong for
  the product: a false positive hides a real value and its changes, and the rule is a guess.
- **Matching a term anywhere in the name.** It catches more and warns on `tokenCount`,
  `max_tokens` and `secretName` in ordinary payloads, which teaches people to ignore the
  warning.
- **Warning on webhook signatures instead of redacting them.** Every Stripe, GitHub and
  Slack user would see it on the first event and silence it.
- **A second walk over each payload for the warning.** Simpler to write, and it doubles
  the part of capture that costs the most.
- **Running the name rule in SQL.** Two copies of one rule drift. The query filters by the
  terms' last three characters, a superset, and doctor applies the rule.
- **A per-journey sample, or the latest events of the whole table.** Filling the cap from
  the first environment scanned left every other project unread, and no index serves the
  latest events of the whole table.

### Consequences

- A name that looks like a secret and is not prints one line per process until it is added
  to `knownSafeNames`, and doctor warns about it with no way to quiet it there; doctor's
  warning never changes its exit code.
- A credential under a name the rule does not know (`plaintext`) is still stored in the
  clear and still unreported. The warning narrows the gap; the operator's own `redact` rules
  remain the control.
- Doctor reads only a recent sample. A name used once, long ago, is not found; the query in
  `OPERATIONS.md` §12 can be run over a wider window by hand. With more than 2,000
  environments, some get no share.
- Values already stored stay until they are deleted or expire. The warning prevents new
  ones.
- Webhook signature headers recorded after the upgrade are stored as `[REDACTED]`; ones
  recorded before stay as they were.

---

## ADR-056: The Node SDK's public surface is settled before its first release

**Status:** Accepted. Changes the Node SDK's API and package, before any
release; changes nothing on the wire or in the server. Language-neutral
material changes in two places: the shared SDK conformance cases use the Node
option names (`maxEventBytes`, `displayableAliases`) in their `recorder` and
`args` objects, and SDK-60 asks for a setting under a name no longer read to be
reported and printed. Follows the API review of 2026-09-16. Leaves the product rename
(the propagation names, the `_flight` key, the print prefix, the `fr_` key
prefix and the package name) to its own decision.

### Context

`@flight-recorder/node` 0.1.0 had not been published, and the rename is the one
breaking moment that can be planned. A review of the package as a user would
install it found names that were wrong (`consume` recorded nothing;
`diagnostics()` returned counters), diagnostics a host could only tell apart by
matching prose, a `detail` typed `unknown` although the README documented its
shape, option names that disagreed with each other, types that did not match
what the wrappers do, declarations for internal modules in the tarball, and an
`engines` range that admitted Node versions where `require()` of the package
fails. Each is cheap before a release and breaking after it.

### Decision

- **One way to join a journey.** `continueJourney` takes an options object:
  `{ context, entity, label }`, where `context` is what an extract helper
  returned and `entity` is the fallback when it carries none, or
  `{ journeyId, entity }` for an id the process already holds. `consume` is
  removed, which leaves `consume`, `receive` and `validate` free for wrappers
  that would record those operations. A `journeyId` that is not a non-empty
  string is reported and replaced. The id form keeps working because a
  journey's context and the options object have the same shape.
- **Names that say what they return and take.** `diagnostics()` is
  `counters()`. The queue helpers are `injectSqsAttributes(attributes,
  context)` and `extractSqsContext`, because their shape is SQS's, and the
  payload helpers are `injectPayload` and `extractPayload`: one rule,
  `inject<Carrier>` and `extract<Carrier>Context`, as OpenTelemetry's
  propagators have it. `fail` takes `{ metadata }`, like the wrappers.
  `displayableAliases` is the one name for the displayable list.
  `maxPayloadBytes`, the budget of a whole event, is `maxEventBytes`, and
  `propagate` is `propagation`.
- **Diagnostics a program can match.** Every diagnostic is
  `{ kind, code, reason, detail }`. `code` is stable, drawn from a closed union
  per kind, and is what a host matches on; `reason` is prose that may change in
  any release. One interface per kind types `detail`, always an object;
  `delivered_first` and `insecure_endpoint` move their fields into it. `detail`
  stays `unknown` only where it carries a host or server object, and those are
  named: `serverError` and `error`. `breaker_open` is `breaker_opened`, so every
  kind maps to its counter by one rule. Codes are the Node SDK's API; the
  conformance cases keep comparing kinds and details, so another SDK is not
  bound to these strings.
- **Counters in one unit.** Every counter but `recorded` and `sent` counts
  reports of one kind, so `keysDropped` counts `key_dropped` reports and the
  number of keys stays in `detail.keys`. `recorded` is new: an event built and
  queued, or refused after shutdown, so `sent + rejected + dropped === recorded`
  holds once shutdown returns, as SDK-38 promises and SDK-42 asks to be
  checkable.
- **Types that match the runtime.** A callback returning any thenable is typed
  asynchronous, its wrapper returns a native promise of the resolved value
  (`Promise.resolve` is applied, which leaves a native promise as it is), and
  `isFailure` and `captureOutput` receive the resolved value. `WrapOptions`
  takes the input's type, so a projection needs no cast. Every optional input
  property is `?: T | undefined`, so a host compiled with
  `exactOptionalPropertyTypes` can pass `process.env.X`. Every option type is
  named and exported, with `Entity` for `{ type, id }`, and `record`'s error
  type, `ErrorInput`, admits the `stack` the SDK already masked and bounded.
  `TraceContext` is no longer exported: nothing public refers to it.
- **What cannot be recorded is reported, never sent as it is.** A
  `continueJourney` context without a non-empty string id is treated as
  absent and reported (`journey_id_invalid`); the old `consume` fell back to a
  random id, and sending the context as it was cost the whole journey at the
  server. An entity that is missing, or whose type or id is not a non-empty
  string, is reported (`entity_invalid`) and the steps are recorded under the
  unknown entity, so they are kept. `fail` options that are not `{ metadata }`,
  and an inject helper given no context, are reported (`invalid_options`,
  `context_missing`). An option under its pre-release name (`maxPayloadBytes`,
  `propagate`, `displayable`, `entityFallback`) is reported as
  `setting_renamed`, and the two recorder settings are printed once per
  process, because losing `propagate: "full"` unseen is a real trap for a
  JavaScript caller. The inject helpers replace a journey's own headers and
  attributes already in the carrier, so a forwarded message cannot pair an
  old entity id with a new journey.
- **The failure boundary cannot throw.** Describing a thrown value could
  throw again (`String()` of a null-prototype object, `instanceof` on a revoked
  Proxy); the boundary now falls back to a fixed reason, and an error record to
  a fixed message. A callback's value whose `then` getter throws makes the
  wrapper return a promise rejected with that error, as `await` would, and
  the step is recorded as failed.
- **Stability is marked.** `@experimental` in the declarations, and a README
  section, on the propagation helpers and `propagation`, `across` and
  `JourneyGroup`, `captureInput` and `captureOutput`, `journeyIdFor` and
  `journeyIdSecret`, `label`, `maxConcurrentSends` and the `Counters` fields.
  New diagnostic kinds and codes may arrive in any minor release;
  `DiagnosticKind` stays a closed union so a `switch` narrows, and the README
  tells a host to keep a `default` branch.
- **One declaration file.** API Extractor rolls tsc's declarations into
  `dist/index.d.ts`, and the build fails if a public type refers to one that
  is not exported. The tarball holds the bundle, that file, the README and the
  licence; no internal declaration or map can be imported under `node10`
  resolution any more. No API report is checked in: the demo image builds the
  package from a context without markdown, where a missing report would fail.
- **A clean manifest.** `scripts/pack.mjs` packs with pnpm, which applies
  `publishConfig`, removes `devDependencies` and `scripts`, and repacks with
  npm; `publish-sdk.sh` publishes that tarball and checks its file list.
  `exports` gains `./package.json`.
- **Node 22.12 or later.** `require()` of an ES module is unflagged from 22.12,
  and Node 20 reached end of life in April 2026, so `>=22.12.0` is the one
  range the package can honestly promise. The bundle targets `node22`.

### Alternatives rejected

- **Keeping `consume` beside `continueJourney`.** Two entry points for one
  thing, and a name that promised a `consumed` event it never recorded.
- **Documenting which `reason` prefixes are stable.** Prose and machine
  identifiers in one field break silently whenever the prose improves.
- **Keeping `keysDropped` in keys and documenting the exception.** Every other
  counter counts reports; a counter whose unit differs is a silent trap, and
  the key count is still in the detail.
- **`^20.19.0 || >=22.12.0`.** It works, and it promises support for a Node
  line that no longer receives security fixes.
- **A dual CommonJS and ES module build.** `require(esm)` covers CommonJS
  hosts, and two builds could load two recorder instances in one process.
- **Renaming the propagation names now.** They carry the product's name, which
  is not decided; renaming them twice is worse than marking them experimental.

### Consequences

- Every caller of the SDK changes: the CHANGELOG lists each rename. The wire
  format does not, so a server needs nothing.
- A native `Promise` subclass returned by a callback comes back as a plain
  `Promise`, because the wrapper resolves it through `Promise.resolve`.
- Code that matched `reason` text must match `code`; code that read
  `endpoint`, `accepted`, `scheme` or `host` from a diagnostic reads them from
  `detail`.
- A dashboard that plotted `keysDropped` as keys now plots reports.
- The build needs API Extractor, a development dependency that is not shipped.
- Node 20 and Node 22.0 to 22.11 are no longer supported.
- The product rename still changes the propagation names, the `_flight` key,
  the print prefix, the key prefix, the package name and repository fields, and
  the README's relative links, which break on npmjs.com until they become
  absolute URLs.

---

## ADR-057: The product is renamed Wayscribe, before anything is published

**Status:** Accepted, 2026-09-17. Changes the product name, the package names,
every wire name that carried the old name, the API key prefix, the deployment
names and the local database defaults. Leaves the key-derivation labels, the
stored data and the history as they were. Settles the rename ADR-056 left to its
own decision.

### Context

"Flight recorder" is already taken in this field. JDK Flight Recorder owns the
`flight-recorder` GitHub organization, Go's `runtime/trace` package ships a
`FlightRecorder`, and `pg_flight_recorder` is a PostgreSQL tool. A search for
the name finds those first, and a package or organization under it would be
confused with them.

The first replacement chosen, Clewline, was dropped on 2026-09-17: clewline.com
is a live software company, working on AI governance and open source security,
and it holds the github.com/Clewline organization. The maintainer then chose
Wayscribe and holds github.com/wayscribe and wayscribe.dev.

Nothing had been published: no npm package, no image in a registry, and no
outside team running the tool. Every wire name that carried the product's name
would be a breaking change after the first release, so this was the one moment
the rename could be a clean break.

### Decision

- **The names.** The product is Wayscribe in prose and in the interface. The
  root package is `wayscribe`, the workspace packages are `@wayscribe/*`, and
  the SDK is `@wayscribe/node`. The CLI binary is `wayscribe`. The headers are
  `x-wayscribe-journey-id`, `x-wayscribe-entity-type`,
  `x-wayscribe-entity-id`, `x-wayscribe-replay` and `x-wayscribe-project-id`,
  and `x-wayscribe-api-key` is redacted from logs. The web session cookie is
  `wayscribe_session`. The queue attributes are
  `wayscribeJourneyId`, `wayscribeEntityType` and `wayscribeEntityId`, and the
  payload envelope key is `_wayscribe`. The environment variables are
  `WAYSCRIBE_API_KEY`, `WAYSCRIBE_URL`, `WAYSCRIBE_TOKEN`, `WAYSCRIBE_PROJECT`,
  `WAYSCRIBE_ENVIRONMENT`, `WAYSCRIBE_VERSION` and `WAYSCRIBE_WEB`. The
  Prometheus metrics are `wayscribe_*` and the alert rules
  `WayscribeRetentionStalled`, `WayscribeRejectingEvents` and
  `WayscribeDatabaseStrained`. The Helm chart is `deploy/helm/wayscribe`, the
  images are `registry.gitlab.com/jojithedev/wayscribe/api` and `/web`, the
  Compose project is `wayscribe`, and the GitLab project moves to
  `jojithedev/wayscribe`.
- **New API keys start `wsk_`; keys that start `fr_` keep working.** The
  server finds a key by its stored first 12 characters and verifies an HMAC of
  the whole key, and never checks the prefix, so a key issued before the rename
  authenticates with no code for it. The three places that know the prefix
  accept both: masking of credentials in error text, `doctor`'s check of a key
  given to it, and the warning about the published demo key, which names the
  old demo key as well as the new one. `wsk_` rather than `ws_`, because
  secret scanners match on the prefix and a two-letter one is common in
  unrelated code. New keys are 36 characters; old ones are 35.
- **No aliases on the wire.** The old headers, queue attributes, envelope key
  and environment variables are not read. There were no outside users to keep
  working, and an alias would have to be carried and tested for as long as the
  product exists.
- **The six key-derivation labels keep the old name.**
  `flight-recorder/field-encryption`, `flight-recorder/search-token`,
  `flight-recorder/api-key`, `flight-recorder/content-hash`,
  `flight-recorder/key-id` and `flight-recorder/web-session` are HKDF labels,
  and a label decides the key derived from `ENCRYPTION_KEY`, or, for the web
  session, from `ADMIN_TOKEN`. Changing one would leave encrypted identifiers
  unreadable, stop search tokens matching, change key fingerprints, fail every
  stored API key and end every web session. No user sees them. Each carries a
  comment saying why, and
  `packages/payload-security/src/derivation-labels.test.ts` pins them.
- **The stored ciphertext prefix keeps its old initials.** An encrypted value
  is stored as `fr1.<keyId>.<payload>`
  (`packages/database/src/repositories/rotation.ts`,
  [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)). `fr1.` is part of the stored data,
  not a name anyone reads, and every value already written carries it, so it
  stays as it is on purpose.
- **History stays as written.** ADR-001 to ADR-056, past CHANGELOG entries,
  the dated design documents and plans, the reviews, the claims audit of
  2026-09-16 and the migration files keep the old name.
  `tests/rename-guard.test.ts` fails on the old name anywhere else, apart from
  the exceptions it lists with a reason for each.
- **The local database defaults change.** The Compose user, password and
  database are `wayscribe`, as are the database names in the examples.
- **The Helm release in the examples and in CI is `ws`**, so resources are
  named `ws-wayscribe-*`.

### Alternatives rejected

- **Keeping the name.** Every search, package name and organization would sit
  next to a better-known tool with the same name.
- **Clewline.** Taken by a live software company with the matching GitHub
  organization.
- **Accepting the old wire names beside the new ones.** A compatibility path
  for users that do not exist, kept forever.
- **Renaming the derivation labels with a migration.** It would mean decrypting
  and re-encrypting every stored identifier, recomputing every search token and
  reissuing every API key, to change strings no user sees.

### Consequences

- A local stack started before the rename is not picked up: its Compose
  project, volume and database user changed. It needs a fresh start, which
  [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md#upgrading-a-checkout-from-before-the-rename)
  describes.
- Stored data stays readable, and API keys that start `fr_` keep
  authenticating, because the labels and the schema did not change.
- Everyone signed in to the interface signs in once more: the session cookie's
  name changed, and the old name is not read.
- The GitLab project path moved to `jojithedev/wayscribe` on 2026-09-17, after
  this change was merged. GitLab redirects the old repository URL; the old
  registry path does not redirect, so an image reference must use the new path.
- Leadline and the other repositories that name the product, its package, its
  environment variables or its headers update to the new names.

## ADR-058: The website is built from the repository's documentation, as a package of its own

**Status:** Accepted, 2026-09-17.

### Context

Wayscribe needs a public page at wayscribe.dev: what the problem is, what the
tool does, how to try it, and the documentation. The documentation already
exists as Markdown in this repository and is held to the code by tests
(ADR-040). A second copy written for a website would drift from it the first
time either changed.

A site generator is also a dependency tree, and a large one. The product's
images are built from the whole repository (`COPY . .` in both Dockerfiles),
`pnpm audit` gates the root lockfile, and ADR-043 keeps anything the runtime
does not execute out of the images.

### Decision

- **Astro Starlight, in `site/`.** It renders Markdown into a documentation site
  with search built at build time (Pagefind), system fonts, and no script or
  font from another host. Versions are pinned exactly.
- **Its own package and lockfile, not a workspace member.** `site/` has its own
  `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`, and the root
  `pnpm-workspace.yaml` does not list it. The root install, the root lockfile,
  `pnpm -r` commands and the SDK never see its dependencies. `.dockerignore`
  excludes `site`, so the product images never receive its files, and
  `scripts/verify-image-contents.sh` fails an API image that contains it.
- **The docs are generated, not copied by hand.** `site/scripts/sync-docs.mjs`
  reads the pages `site/docs-manifest.json` lists, from the repository, on every
  build: it writes the title as frontmatter, rewrites relative links to the
  published page or to the file on GitLab at `main`, maps GitLab's heading
  anchors to the ones the site renders, and copies the images. The output is
  ignored by git. The landing page's comparison is the README's Alternatives
  section, read the same way.
- **Checked like the rest.** The `site` job builds the site whenever the site or
  a published document changes; `starlight-links-validator` fails the build on a
  broken internal link or anchor, offline, and `pnpm audit --audit-level=high`
  runs against the site's own lockfile. `tests/site.test.ts`, part of
  `pnpm test`, fails when a published page has an em or en dash, when the
  manifest names a missing file, and when the landing page's commands or code
  stop matching the README and the type-checked recipe.
- **No analytics, trackers or cookies.** The same stance as the product's.
- **GitLab Pages on `main`.** The `pages` job publishes the build. The custom
  domain and DNS are set by the maintainer by hand (`site/README.md`).
- **Astro telemetry is off** (`ASTRO_TELEMETRY_DISABLED=1`) in the site's
  scripts and in CI, as Next.js's is for the web app.

### Alternatives rejected

- **A workspace member.** Simpler to install, but Astro's tree would enter the
  root lockfile, the root audit and the build context every product image
  copies, for a package no product code uses.
- **Hand-written pages.** They would say something different from the
  repository within a week, and nothing would notice.
- **Leaving the docs on GitLab only.** GitLab renders them well, but a reader
  who arrives at wayscribe.dev should not need to know where the repository is
  to read the quick start.

### Consequences

- Two lockfiles to keep current, and the site's advisories are gated in the
  `site` job rather than in `audit`.
- The site cannot hold back the product. `site` runs in a stage after `mirror`
  (started at once with `needs: []`), so a failure there does not stop the
  GitHub mirror, and it does not run on tags, so it cannot stop a release.
- A published page must have a heading, link and image the generator
  understands; a broken one fails the `site` job rather than reaching the site.
- `tests/rename-guard.test.ts` and `tests/docs-helpers.ts` skip the generated
  directories, since they hold copies of files the tests already read at their
  source.

---

## ADR-059: Python is the next SDK

**Status:** Accepted, 2026-09-17. Supersedes one condition of ADR-049, that a
second native SDK waits for a team that needs one. ADR-065 later preserves
Python as the next SDK while replacing this decision's order after it with Go,
then optional OTLP. The rest of ADR-049, which makes the contract the
deliverable, stands and is what makes this decision a cheap one.

### Context

ADR-049 said a second native SDK waits for a pilot team that needs one, and it
said why. At the time the contract existed only as TypeScript, so a second
recorder would have meant designing the contract and building the recorder in
the same breath. That decision named what had to come first, and all of it now
exists: `docs/SDK_SPEC.md` states the requirements in a language-neutral form,
JSON Schema is generated from the Zod schemas and checked for drift,
`docs/INGESTION_CONTRACT.md` is normative for the wire, the conformance
fixtures under `packages/protocol/conformance/` are runnable by any
implementation, and the dry run (ADR-050) lets them run against a real server
without leaving rows behind. The condition ADR-049 set has been met.

Waiting for a request also has a cost that is easy to miss. This tool is for
integration and pipeline code, and most of that is written in Python. A team
evaluating Wayscribe for a Python worker finds an HTTP contract and no
recorder, which is a harder first fifteen minutes than
`docs/PRODUCT_PRINCIPLES.md` promises. "Wait for a team to ask" is a reasonable
rule while a second SDK means a second design, and a poor one once the design
is published.

### Decision

After the first release, the order of recorder work is:

1. **A Python SDK.** Built against `docs/SDK_SPEC.md` rather than against the
   Node SDK's source, and not done until it passes the conformance fixtures
   through the dry run. Python is where most of the pipelines, workers and
   integrations this tool is for are written, which makes it the highest-value
   second recorder rather than the one that happened to be asked for first.
2. **OpenTelemetry log records over OTLP HTTP**, the optional ingestion path
   ADR-049 planned and ADR-010 permits. It covers the languages that have no
   native recorder.
3. **Further languages, by pilot demand.** Past Python there is no ranking
   worth guessing at, so ADR-049's rule stays in force for them.

The Python SDK is dogfooded rather than demonstrated: a Python service is added
to the Leadline project and recorded with it, the way the Node SDK was.

This work comes after the first release, not before it. Nothing here adds a
package to the first published set or moves a release date.

### Alternatives rejected

- **Leaving ADR-049's condition in force.** It was written when the contract
  was the expensive part, and the expensive part is now done. Leaving it would
  tell the next reader of `AGENTS.md` that a Python SDK needs a pilot team
  first, which is the contradiction this decision exists to remove.
- **Python before the first release.** A second recorder is a second thing that
  can be wrong in public. ADR-056 settled the Node SDK's surface for release
  and ADR-057 renamed the product; adding an unproven SDK to that release buys
  nothing and risks it.
- **OTLP ingest first.** It reaches more languages for the same work, but it
  hands a Python team a mapping rather than a recorder, and the pairing of
  input and output that the payload diff depends on is a convention in OTLP
  rather than something an SDK enforces. Python first, OTLP second.
- **Generating a Python SDK from the Node one.** The two languages do not line
  up, and a generated recorder would follow the Node SDK's shape rather than
  `docs/SDK_SPEC.md`, which is the document a third implementation has to be
  able to trust.

### Consequences

- `AGENTS.md`'s do-not-add list no longer bans a Python SDK. A native SDK in
  another language still needs a decision of its own; Python's is this one.
- `docs/ROADMAP.md` and `docs/FAQ.md` already said Python is next (dca7012).
  They now have an accepted decision behind them, which is what the
  source-of-truth order in `AGENTS.md` requires of them.
- ADR-049's other rulings are untouched. The contract is still the deliverable,
  a second SDK is still built against `docs/SDK_SPEC.md`, and it is still not
  done until the conformance fixtures pass through the dry run.
- `docs/SDK_SPEC.md` gains a second reader, so a requirement that is ambiguous
  will be found rather than guessed at. Anything the specification cannot
  answer is a defect in the specification and is fixed there, not worked around
  in the Python package.
- The recorder surface to maintain doubles: two packages to release, two
  conformance runs, and two README pages that can drift from the specification.

---

## ADR-060: The settled SDK surface gains what the dogfood run asked for

**Status:** Accepted, 2026-09-17. Adds to the Node SDK's public surface, which
ADR-056 settled before the first release. Every addition is optional and
additive: no call that exists today changes its shape, its meaning or what it
puts on the wire, and the server needs no change for any of them. Follows
Leadline's first pass over the SDK: findings F-001 to F-006, F-010, F-012,
F-014 and F-021. Amended 2026-09-17, after the implementation, where the
envelope and the wrapper signatures are recorded as they were built rather than
as they were first specified.

### Context

ADR-056 settled the shape of what the Node SDK already had, so that the renames
a release makes expensive were made before it. It could not settle what was
missing, because nothing outside this repository had yet been instrumented with
the package as a user installs it.

Leadline, the lead-sync project that exists to dogfood Wayscribe, wired itself
to the SDK and wrote down every place it had to work around the package rather
than use it. Seven of those are gaps in the surface rather than defects in it.

- Two services identify one record, and `identify` always names its step
  `identify` (`recorder.ts`, the `identified` event), so one journey's timeline
  shows the same step name twice from two different services, and the
  workaround is to call `record({ operation: "identified" })` by hand (F-001).
- The wire protocol carries `deployment` (`gitCommit`, `version`, `image`), the
  ingest path redacts it and stores it as `deployment_metadata`, and no Node
  service can set it, because neither `RecorderConfig` nor `RecordInput` offers
  it. Leadline reports its commit on its own health endpoint instead (F-002).
- A wrapper's `metadata` is copied when the wrapper is called, before the
  callback runs, so a response status or a `Retry-After` cannot be metadata and
  has to be pushed into the step's output (F-003).
- A result that `isFailure` rejects always records the same error,
  `<name> reported a failed result.` with code `result_failed`, so a rate limit
  and a validation failure read alike until the output is opened (F-004).
- A worker whose message carries no context is given a random journey id even
  when the recorder holds a `journeyIdSecret` and the caller knows the entity,
  so the journey splits. ADR-052 made the derived id available and ADR-056 made
  `continueJourney({ journeyId })` the way to pass it, so the caller can do this
  itself, and every such caller writes the same two lines (F-005).
- `injectPayload` with no context returns `{ _wayscribe: {}, data: payload }`,
  which does not satisfy `ContextEnvelope<T>`, whose `journeyId` is required.
  The SDK's own source reaches that value through `as unknown as`, and anything
  that reproduces the shape needs the same cast (F-014).
- The four wrappers are declared as two call signatures each, one for a callback
  returning a thenable and one for a callback returning a value. A single plain
  function that forwards its callback's result the way all four do can only be
  typed to return `unknown`, which satisfies neither signature, so a second
  implementation has to restate both signatures. The SDK's own `operationsOn`
  casts each of its four wrappers with `as JourneyOperations["transform"]` and
  its three siblings (F-021).

Each is cheap to add before the first release and awkward after it, because a
host that worked around a gap keeps its workaround.

### Decision

The Node SDK gains the following. Every one is optional, and every existing call
behaves exactly as it does today when it is not used.

- **A name for an identify step.** `IdentifyOptions` gains `name`, so
  `identify(aliases, { name: "identify-crm" })` records the `identified` event
  under that step name. The default is `identify`, which is what every current
  caller gets. The operation stays `identified`: the step name is the timeline's
  row label, and the operation is what happened.
- **A deployment on every event.** `RecorderConfig` gains
  `deployment?: { version?, gitCommit?, image? }`, applied to every event the
  recorder sends. It sits on the recorder and not on `RecordInput` because one
  process is one deployment. A field that is not a string, or is longer than
  `deploymentSchema` allows, is reported and left out rather than sent, in the
  way ADR-056 settled for every other unusable setting, so a bad value costs
  that field and not the event.
- **Metadata computed from the result.** `WrapOptions` gains
  `metadataFrom`, which receives the callback's resolved value and returns
  metadata. It runs after the callback resolves, whether or not `isFailure`
  rejected that value, so a status and a `Retry-After` from a refused response
  are recordable. It does not run when the callback throws, because there is no
  result. What it returns is merged over any static `metadata`, and the
  wrapper's own `attempt` is applied last, so a projection cannot overwrite the
  attempt the wrapper recorded. It is synchronous and its failure is isolated
  exactly as `captureOutput`'s is: a projection that throws or returns a promise
  is reported and costs its own metadata, never the step and never the host's
  call.
- **A reason on a failed result.** `isFailure` may return a reason instead of
  `true`: a non-empty string, which becomes the error's message, or
  `{ message?, code? }`, whose fields replace the generic message and the
  `result_failed` code. Returning `true`, or any other truthy value, records
  today's generic error, and a falsy value is not a failure, so every current
  caller is unaffected. The reason is masked and bounded as any recorded error
  is (ADR-046), because it comes from a response body and may hold a secret.
- **A derived journey id as the last resort.** When `continueJourney` finds no
  usable journey id, in the context or in `journeyId`, and it does have a usable
  entity and the recorder has a usable `journeyIdSecret`, the journey id is
  `journeyIdFor(entity)` rather than a fresh random one. Without a usable
  secret, or without a usable entity, the id is random, as it is today, and it
  stays documented. The diagnostics ADR-056 settled for an unusable context, an
  unusable id and an unusable entity are unchanged and are reported before the
  fallback, so nothing that was visible becomes silent.
- **An envelope type that admits its own no-context shape.**
  `ContextEnvelope<T>` is unchanged: its `journeyId` stays required, so a reader
  who has a real context still reads a `string`. A second interface,
  `NoContextEnvelope<T>`, describes the shape `injectPayload` emits when there
  is nothing to inject, with `_wayscribe: { journeyId?: undefined }`, and
  `PayloadEnvelope<T>` is the union of the two. `injectPayload` returns the
  union. The `_wayscribe` key is required in both, because the envelope always
  carries it and its empty form is how `extractPayload` reads the absence of a
  journey. The SDK's `as unknown as` cast goes, and anything that reproduces
  the no-context shape, such as a recorder that records nothing, now has a type
  to name. Runtime behaviour is unchanged: the values on the wire are exactly
  what they were.

  **How the union narrows, which is not obvious.** TypeScript does not narrow a
  union on a discriminant reached through another property, so
  `if (envelope._wayscribe.journeyId !== undefined)` does not make `envelope` a
  `ContextEnvelope<T>`. An earlier draft of this decision claimed it did, and
  the review disproved it. Compiled under tsc 5.9.3 with this repository's own
  settings (`strict`, `exactOptionalPropertyTypes`), the assignment inside that
  `if` is `error TS2322: Type 'PayloadEnvelope<T>' is not assignable to type
  'ContextEnvelope<T>'`. Three things are true instead, each compiled before
  this was written:

  - **To read the journey id, the plain check is enough.** It narrows the value
    read even though it does not narrow the envelope: inside
    `if (envelope._wayscribe.journeyId !== undefined)`, the expression
    `envelope._wayscribe.journeyId` is `string`.
  - **To hold the envelope as a `ContextEnvelope<T>`, use a type guard.**
    `function hasJourney<T>(e: PayloadEnvelope<T>): e is ContextEnvelope<T>`,
    returning that same comparison. Inside `if (hasJourney(envelope))` the
    envelope is a `ContextEnvelope<T>`, assignable with no cast.
  - **Destructuring first also narrows**, because the discriminant is then at
    the top level of the value being tested: after
    `const { _wayscribe } = envelope`, `if (_wayscribe.journeyId !== undefined)`
    gives `_wayscribe` the context's own shape, with `entityType` and
    `entityId` reachable on it.

  The README carries this, because a reader who tries the obvious thing meets a
  compiler error about assignability that says nothing about narrowing.

  **The package exports the guard**, so the second of those three is written
  once rather than in every consumer:
  `hasJourney<T>(envelope: PayloadEnvelope<T>): envelope is ContextEnvelope<T>`.
  It reads the value as `unknown` before testing it, because a queue hands a
  consumer whatever was put there and a JavaScript caller can pass anything
  the types did not stop. It takes the package's exported values from two to
  three, `createRecorder`, `OPERATIONS` and `hasJourney`, which
  `docs/NODE_SDK_SPEC.md` section 4 states. Most consumers still want
  `extractPayload`, which returns the context and the payload apart and reads a
  body that is not an envelope at all; the guard is for a reader who already
  holds one.
- **Wrapper signatures a second implementation can satisfy.** Each of
  `transform`, `persist`, `publish` and `deliver` is declared so that one plain,
  non-overloaded function satisfies it without a cast: one signature over
  `() => T | PromiseLike<T>` with a conditional return type. If that is found to
  lose inference at a call site, the overloads stay and a non-overloaded alias
  is exported beside them, and the README says which one an implementer writes
  against. The mechanism chosen was the conditional type:
  `WrapResult<T> = T extends PromiseLike<infer R> ? Promise<Awaited<R>> : T`,
  one signature per wrapper over `fn: () => T`.

  **The acceptance test is met.** All four assignment-site casts are gone from
  the SDK's own factory, and a hand-written implementation satisfies
  `JourneyOperations` with no cast, which was F-021's complaint. One cast
  remains inside the body of the shared wrapper implementation, on its return.
  It is unavoidable: `WrapResult<T>` is a conditional type over an unresolved
  type parameter, and TypeScript cannot check that a value produced at run time
  satisfies one, so returning the value without a cast is
  `error TS2322: Type 'unknown' is not assignable to type 'WrapResult<T>'`.
  Every implementation of these methods needs it, a second SDK's included; no
  consumer of them needs any. The cast is commented where it sits, saying which
  of those two it is. A declaration that forced a caller outside the package to
  cast would fail this test; one that costs an implementer a commented cast on
  a return does not. This is a
  declaration change; what the wrappers do at runtime is untouched, and a
  callback returning a thenable still comes back as a native promise of its
  resolved value.

Two more public additions arrive with fixes recorded elsewhere in this pass.
They are listed here because ADR-056 settled the surface, and every addition to
it belongs in one place.

- **A diagnostic for personal data in a plain-text value.** A new diagnostic
  kind, `personal_data_in_public_value`, with the single code
  `personal_data_shape` and `detail` of
  `{ field: "journeyLabel" | "displayableAliases", shape: "email" | "phone" }`,
  and a `personalDataInPublicValues` counter beside it (F-006, F-012). It
  follows ADR-055's secret-name pattern exactly: it warns, once per process and
  shape, and never changes the value. `DiagnosticKind` is a closed union
  (ADR-056), so adding a kind is a public change, and the README's advice to
  keep a `default` branch in a `switch` is what makes it a safe one.
- **The rejected settings by name.** `counters()` gains `rejectedSettings`, the
  names a configuration report carried in `detail.setting`, in the order first
  seen, once each, capped at 50 (F-010). `configurationErrors` says how many
  settings were rejected and never which, so a recorder running on a default
  nobody chose was invisible to an operator who reads counters rather than
  diagnostics. This does not reopen ADR-056's rule that every counter counts
  reports of one kind: `rejectedSettings` is a list rather than a counter, and
  `configurationErrors` still counts the reports.

These are additions. No existing call changes meaning, nothing already released
changes shape, and the surface is settled again once they land: ADR-056's rule
holds, and this decision is its amendment rather than a standing licence to add.

### Alternatives rejected

- **Waiting until after the first release.** Each of these becomes harder once
  hosts have worked around it: a dashboard matches the step name `identify`, a
  service puts its version in custom metadata, and an envelope a host has
  already cast around cannot be repaired without touching their code. This is
  ADR-056's own argument, arriving once more.
- **A `deployment` on `RecordInput` as well as on the recorder.** One process is
  one deployment, so a per-event deployment is mostly a way to record something
  untrue, and it puts the same unchanging bytes on every event.
- **Letting the callback mutate the wrapper's metadata object.** It makes what
  was recorded depend on when the SDK copied the object, which is the class of
  bug ADR-056 removed by reading every option once, inside the boundary.
- **One `onResult` hook covering metadata, output capture and failure
  detection.** Three options with three rules are easier to document, to test
  and to isolate on failure than one hook whose return value means three things,
  and `captureOutput` and `isFailure` already have settled shapes.
- **Deriving a journey id from the entity without a secret.** ADR-052 settled
  this: an unkeyed derivation is guessable by anyone who knows the entity and
  the scheme, which is what `INGESTION_CONTRACT.md` section 5 warns about.
- **Making `journeyId` optional on `ContextEnvelope` itself.** This is what this
  decision first specified, and the implementation was right to go the other
  way. One optional property on the one envelope type is a smaller diff, and it
  puts the narrowing burden on every reader of a real context, including hosts
  that never disable their recorder and never see a no-context envelope. A
  union charges that cost only to the code that can actually meet both shapes.
- **Making `_wayscribe` itself optional.** That would also admit `{ data }`,
  which `injectPayload` never emits, and it would hide from the reader the one
  case the type exists to make visible.

### Consequences

- The Node SDK's README documents each new option beside the one it belongs
  with, and the CHANGELOG lists them as additions in the first release.
- `docs/SDK_SPEC.md` carries the ones another implementation should follow: the
  identify step name, the deployment on every event, and the derived id as the
  last resort. `metadataFrom`, the `isFailure` reason and the wrapper signatures
  are the Node package's own ergonomics and stay in its README.
- Nothing on the wire changes and the server needs no change. `deployment` is
  already validated by `deploymentSchema` and stored as `deployment_metadata`,
  which is why F-002 is an SDK gap and not a protocol one.
- A host that matches the error code `result_failed` keeps matching it, unless
  its own `isFailure` supplies a code.
- `injectPayload` returns `PayloadEnvelope<T>` rather than `ContextEnvelope<T>`,
  so a caller who annotated the result, `const job: ContextEnvelope<T> =
  recorder.injectPayload(...)`, no longer compiles and changes the annotation to
  `PayloadEnvelope<T>`. The review found this, and it is the whole migration.
  Nothing is published yet, so no compatibility promise is broken, and
  `ContextEnvelope` is marked experimental (ADR-056) in any case. A caller who
  passes the result straight on, or reads `.data`, changes nothing, and a
  caller that reads `_wayscribe.journeyId` under the usual check changes
  nothing either. A caller that needs the envelope itself typed as a
  `ContextEnvelope<T>` writes the guard the decision describes.
- The surface grows by five options, two exported envelope types, one exported
  function, one signature shape, one diagnostic kind with its counter, and one
  field on `counters()`,
  each of which is a thing to keep documented, tested and honest in two places
  once a second recorder exists (ADR-059).

---

## ADR-061: A successful retry clears a failure rather than completing the journey

**Status:** Accepted, 2026-09-17. Changes how the server derives a journey's
status from one event. ADR-022 is unchanged: a retried attempt still records the
operation `retried`, because that is what happened. Nothing in the SDK changes
and nothing on the wire changes. `completed` keeps the meaning it has today.
Follows finding F-008.

This decision is narrower than the one Task 2 of
`docs/superpowers/plans/2026-09-17-leadline-findings-fixes.md` described. That
plan said a successful `retried` should count as a completion "the same way
`completed` does". It should not, for the reason recorded under the rejected
alternatives, and the plan's wording in Task 2 and Task 8 is corrected to match
this decision. Where the two disagree, this decision governs.

### Context

Two rules meet here, and each is right on its own.

`deriveStatus` in `packages/database/src/repositories/journeys.ts` maps one
event to the status it implies: `failed` when the event carries an error or its
operation is `failed`, `completed` when its operation is `completed`, and null,
meaning this event has no opinion, for everything else. The status case in
`updateJourneySummary` applies that mapping: a `failed` wins whatever its
timestamp says, because ADR-031 stamps a wrapped event when its callback starts
and enqueues it when the callback ends, so a slow failing step is routinely
stamped earlier than events that reach the server before it; any other status
applies only when the event is at or after the newest one the journey has seen.

ADR-022 makes the SDK's `wrap()` rename a wrapped call's operation to `retried`
whenever the caller passes `attempt` greater than one, whichever way the call
comes out.

So a step that fails on attempt one and succeeds on attempt two records
`delivered` with an error and then `retried` with none. The failure sets the
journey to failed. The success carries the operation `retried`, which
`deriveStatus` has no opinion about, so it cannot undo the failure by itself.
Only `finish()`, which records a plain `completed` or `failed` whatever the
attempt, can, and a reader looking at the journey between the retry and the
`finish()` sees a failed journey whose most recent event succeeded.

There is a general asymmetry underneath this. Every operation is already read at
journey level when it fails, because `hasError` is checked before the operation
is: a first-attempt `delivered` that fails sets the journey failed with no retry
involved. No operation but `completed` is read at journey level when it
succeeds. So any failing step leaves its journey failed until `finish()`, and
F-008 is the case where that is most obviously wrong, not the only case.

What makes `retried` the one operation to act on is that it is the only one
whose meaning is "this is another attempt at something already recorded". Its
success is evidence about the earlier attempt: that attempt's error has been
superseded. A successful `delivered` or `persisted` of some other step carries
no such evidence, because it says nothing about the step that failed. That is
the whole of the argument, and it reaches exactly as far as clearing the
failure.

### Decision

A `retried` event that carries no error clears an existing `failed` status,
returning the journey to `active`. It does not mark the journey `completed`.

`completed` keeps the meaning it has today: the operation `completed`, at or
after the watermark, which in practice is `finish()`. A journey is completed
when the run that owns it says it finished, and nothing else says that.

A `retried` event that carries an error is a failure, as it already is.

The event itself is not touched. Its operation stays `retried` on the wire, in
storage and on the timeline. This decision is about what the server derives from
an event, not about what the SDK records.

What follows, stated so the implementation is not guessed at:

- A journey whose step fails on attempt one and succeeds as `retried` on attempt
  two, with no `finish()`, reads `active`. The run is in progress again, which
  is what is true of it. It is not completed, because nothing has said the run
  reached its end.
- A journey whose only event is a successful `retried` reads `active`, which is
  what it reads today. There is no failure to clear, and a lone retry is not an
  ending.
- A journey whose last retry failed is still failed. The retry carries an error,
  `deriveStatus` returns `failed`, and that branch wins whatever the timestamp.
- The clearing obeys the watermark, like every status change but a failure: a
  successful retry clears the failure only when it is at or after the newest
  event the journey has seen. Without that, a retry stamped before a later
  failure would clear it.
- If the successful retry is applied before the earlier failure, the failure
  still wins and the journey reads failed. That is the existing rule and it is
  deliberately conservative. It is rare in practice: attempt two cannot start
  until attempt one has finished, and the SDK's queue does not reorder one
  journey's events.

**The shape of the implementation is the implementer's call.** Clearing a
failure is not a pure per-event mapping, because it reads the status the journey
already has, so `deriveStatus` alone is unlikely to carry it and the status case
in `updateJourneySummary` will probably need a branch of its own. Whether the
successful retry arrives there as a new value from `deriveStatus` that the case
interprets, or as a separate fact passed beside it, does not matter. What must
hold is this:

- the failure branch still wins whatever the event's timestamp says;
- the clearing applies only at or after the watermark, by the same comparison
  every other status change uses;
- a successful retry never sets `completed` and never writes `completed_at`;
- the label and last-step rules are untouched.

### Alternatives rejected

- **A successful retry completes the journey, the same way `completed` does.**
  This was the plan's wording and the first draft of this decision. It is
  rejected because "completed" has to mean the journey finished. Under that rule
  a run that retries successfully and then dies before finishing reads
  `completed`, and `completed_at` gets set mid-run by a step that was not an
  ending. A falsely reassuring status is worse than a stale alarming one: a
  failed journey that has really recovered costs someone a look, while a
  completed journey that really died is never looked at. It would also have made
  a journey whose only event is a successful retry read completed, which is
  plainly untrue of it.
- **Renaming a successful retry to `completed` in the SDK.** The status would
  then fall out with no server change, and the timeline would lose the fact that
  the attempt was a retry, which is the thing ADR-022 exists to keep. A second
  attempt would read like a first. It also has the defect above, one layer down.
- **Treating every successful operation as clearing a failure.** `delivered` and
  `persisted` say a step finished, and say nothing about a different step that
  failed, so a later success would erase a failure it has no evidence about.
  `retried` is the exception because it is a second attempt at something already
  recorded.
- **Leaving it, on the grounds that `finish()` resolves it.** F-008 says as much
  for Leadline, which calls `finish()` on every run. It holds only for a host
  that always reaches its own end, and it leaves the status wrong for as long as
  the rest of the run takes, which is exactly the window someone watching a
  retry is looking at.

### Consequences

- The general asymmetry is untouched. Any operation that carries an error still
  fails its journey, and only a `completed` operation still completes one. This
  decision adds one way for a failure to be cleared, by the one operation whose
  success is evidence about the failure, and changes nothing else about how a
  journey's status is reached.
- `completed_at` is untouched and keeps meaning what it means today. This is the
  main thing the narrower rule buys over the rejected one.
- A journey that failed and then retried successfully moves out of a
  `status=failed` filter on the journeys list and into `status=active`. That is
  the point of the change, and it is what a reader scanning for failures wants:
  the ones still listed are the ones nothing has superseded.
- `active` after a cleared failure is not distinguishable from `active` that
  never failed. The failure is still in the journey's own timeline, which is
  where the evidence belongs; the status is a summary, not a history.
- Existing rows are not rewritten. A journey recorded before this change keeps
  the status it was given; there is no backfill and no migration.
- The status is the server's derivation, so the behaviour follows the server's
  version and not the recorder's. A recorder at 0.1.0 against a newer server
  gets the new status for free.
- `docs/EVENT_PROTOCOL.md` section 5's `retried` entry and the journey status
  vocabulary in `docs/API_SPEC.md` say what a successful retry does, and say
  that `completed` means the run reached its end, so the status a reader sees is
  documented where they look it up.

---

## ADR-062: What the second dogfood run changed in the SDK's surface

**Status:** Accepted, 2026-09-18. Amends the Node SDK's public surface, which
ADR-056 settled and ADR-060 extended, before the first release. Changes what
`counters()` reports, what `deployment` refuses, one declaration and one
warning's reach. Nothing on the wire changes and the server needs no change.
Follows Leadline's second pass over the SDK, written against `dcd4fea`:
findings F-031, F-034, F-038 and F-041.

### Context

ADR-060 added `deployment` and `counters().rejectedSettings` so a host could set
its build and learn which settings the SDK refused. Leadline adopted both, and
measured what they report. Checked against the code at `dcd4fea`:

- **A partial refusal and a total one read the same.** `readDeployment` in
  `packages/sdk-node/src/config.ts` keeps each of `gitCommit`, `version` and
  `image` that is a non-empty string within the protocol's limit, and reports
  every other problem once, under the setting name `deployment`. So
  `{ gitCommit: <40 chars>, version: <129 chars> }`, which still sends the
  commit, and `{ gitCommit: <129 chars> }`, which sends nothing, both leave
  `rejectedSettings` at `["deployment"]` with one configuration error. Only the
  diagnostic's prose, which the SDK says may change in any release, tells them
  apart (F-031).
- **Two empty inputs pass in silence.** `readDeployment` refuses `""` but keeps
  `"   "`, because it compares with `""` and never trims, while the required
  settings' own check treats a blank value as missing. And `{}`, like
  `{ gitCommit: undefined }`, which is what `process.env.GIT_SHA` gives when the
  variable is unset, is accepted with nothing reported and no deployment sent
  (F-031).
- **Some unknown keys go unreported.** The check for keys other than the three
  is `key in DEPLOYMENT_LIMITS`, and `in` reads the prototype, so `constructor`
  or `toString` beside a valid `gitCommit` is left off without a report. Found
  while checking this decision, and measured: both leave `rejectedSettings`
  empty. The key is never sent, because only the three fields are copied, so
  this is a silent loss and not a refused event.
- **Calls feed the settings list.** `createDiagnostics` in `diagnostics.ts`
  keeps one set, `rejectedSettings`, capped at `MAX_REJECTED_SETTINGS` (50), and
  `report` adds `detail.setting` from every `configuration_error`, whenever it
  arrives. The recorder sends those at creation, for its settings, and on later
  calls: `continueJourney` for `context`, `journeyId` and `entity`,
  `startJourney` for `entity`, `journeyIdFor` for `journeyIdSecret` when it has
  no usable secret, and `continueJourney`, `identify` and `startJourney` for
  the pre-release option names `entityFallback` and `displayable`. So a
  recorder whose every setting was valid ends with `["journeyId", "context"]`
  after two odd calls, and a shutdown summary prints a setting problem the
  process never had. `journeyIdFor` reports an invalid entity with
  `detail: {}`, so that one reaches no list at all, although
  `ConfigurationErrorDiagnostic`'s own TSDoc says `setting` is `entity` (F-038).
- **The guard cannot take what it was written for.** `hasJourney` in
  `propagation.ts` is declared over `PayloadEnvelope<T>`, reads its argument as
  `unknown` and answers `false` for anything that is not an envelope with a
  journey, and its TSDoc says it takes anything. A body off a queue is
  `unknown`, and passing one is `error TS2345` (F-034).
- **An error message is shown in the clear and nothing warns.** `maskedError`
  in `recorder.ts` is the one point every error record passes on its way to
  the queue: a thrown error's, a `FailureReason`'s, `fail()`'s and one given to
  `record()`. It masks credential shapes with `maskSecretsInText`, which leaves
  an email address and a telephone number alone, and nothing warns about them.
  The label and displayable-alias warning of ADR-060, `warnAboutPersonalData`
  in `personal-data.ts`, is never called for an error (F-041).

### Decision

**Settings and options are two lists.** `Counters` keeps `rejectedSettings`
and gains `rejectedOptions`, both `readonly string[]`:

- `rejectedSettings` names what was refused while `createRecorder` ran: the
  recorder's settings, the fields of `deployment` as below, a setting given
  under its old name, and an unusable `journeyIdSecret`. It is fixed once
  `createRecorder` returns, so it gives the same answer whenever it is read,
  and a correctly configured process never ends with an entry in it.
- `rejectedOptions` names what a call was refused after that: `entity`,
  `context`, `journeyId`, `journeyIdSecret` (a call that needed a secret the
  recorder does not have, or cannot use), and the old option names
  `entityFallback` and `displayable`.

Each list keeps a name once, in the order first seen, at most 50 entries:
`MAX_REJECTED_SETTINGS` stays 50 and a new `MAX_REJECTED_OPTIONS` is 50. Both
hold only names the SDK itself wrote, never a value or a key the host chose,
which is what keeps them bounded. `counters()` returns a fresh copy of each.
`configurationErrors` is unchanged: it counts every `configuration_error`
report, from creation and from calls alike, one per report.

The split is made by when a report arrives, not by tagging each report. The
internal `Diagnostics` interface gains `endCreation(): void`, which
`createRecorder` calls once, as its last statement before it returns the
recorder. A `configuration_error` reported before that call names an entry in
`rejectedSettings`; one reported after it names an entry in `rejectedOptions`.
No call can reach the recorder before `createRecorder` returns, so the phase
cannot be wrong, and a creation-time report added later lands in the right list
without anyone remembering a flag. The same rule settles `journeyIdSecret`: an
unusable secret is reported at creation and is a setting; a missing secret is
the default and not a misconfiguration (the recorder does not report it at
creation), so a `journeyIdFor` that needed one names it as an option.

`journeyIdFor` reports an invalid entity with `detail: { setting: "entity" }`,
as `startJourney` and `continueJourney` already do, so it reaches
`rejectedOptions` like theirs.

**`deployment` is reported by field.** What each case adds to
`rejectedSettings`, with the code `setting_unusable` for every one; no new code
is added:

- **`deployment.gitCommit`, `deployment.version`, `deployment.image`:** that
  field was given, meaning its value is not `undefined`, and is not sent: it is
  not a string, is empty or whitespace only, is longer than the protocol
  accepts (128, 128 and 512 UTF-16 code units, as today), or reading it threw.
  Whitespace only means `value.trim() === ""`, the test the required settings
  use. A value with text in it is sent as given, never trimmed: nothing is
  converted.
- **`deployment.*`:** the object holds one or more own enumerable keys other
  than the three, tested with `Object.hasOwn` against the limits table rather
  than `in`, or its keys could not be listed. One report however many such keys
  there are, and never the key's name, because the key is the host's and could
  be anything. The three fields are still read and sent as usual.
- **`deployment`:** the setting was given and events carry no deployment as a
  result. That is: it could not be read, it is not an object (`null`, an array,
  a string), or it is an object from which no field is sent, which covers `{}`,
  `{ gitCommit: undefined }` and an object whose every given field was refused.

Reports are made in the order `deployment.gitCommit`, `deployment.version`,
`deployment.image`, `deployment.*`, `deployment`, one `configuration_error`
each. So "was the whole setting dropped" is
`rejectedSettings.includes("deployment")`, and "which field" is the dotted
entry. Measured today against decided:

| `deployment` given | `rejectedSettings` today | decided | sent |
| --- | --- | --- | --- |
| `{ gitCommit: <40> }` | `[]` | `[]` | the commit |
| `{ gitCommit: <40>, version: <129> }` | `["deployment"]` | `["deployment.version"]` | the commit |
| `{ gitCommit: <40>, branch: "main" }` | `["deployment"]` | `["deployment.*"]` | the commit |
| `{ gitCommit: <40>, constructor: "x" }` | `[]` | `["deployment.*"]` | the commit |
| `{ gitCommit: <129> }` | `["deployment"]` | `["deployment.gitCommit", "deployment"]` | nothing |
| `{ gitCommit: "" }` | `["deployment"]` | `["deployment.gitCommit", "deployment"]` | nothing |
| `{ gitCommit: "   " }` | `[]` | `["deployment.gitCommit", "deployment"]` | nothing |
| `{}` or `{ gitCommit: undefined }` | `[]` | `["deployment"]` | nothing |
| `null` | `["deployment"]` | `["deployment"]` | nothing |

`configurationErrors` is the length of the decided list in every row, since
each entry is one report.

**`hasJourney` takes anything.** Its declaration becomes
`hasJourney(envelope: unknown): envelope is ContextEnvelope<unknown>`, with no
type parameter. The guard checks `_wayscribe.journeyId` and never `data`, so a
type parameter the caller could set would assert the payload's type unchecked,
which is a cast by another name. None is needed: compiled under tsc 5.9.3 with
this repository's settings, a value typed `PayloadEnvelope<Job>` still narrows
to `ContextEnvelope<Job>` inside the guard and to `NoContextEnvelope<Job>` in
its `else`, because narrowing keeps the union members assignable to the
predicate's type; a value typed `unknown` narrows to
`ContextEnvelope<unknown>`, whose `data` is `unknown` until the caller checks
it. The TSDoc says plainly that `false` covers both "not an envelope" and "an
envelope with no journey", since F-034 shows a caller needs to tell those apart
and this guard does not (F-034).

**An error message is checked for personal data.** `maskedError` calls
`warnAboutPersonalData` on the message after masking and bounding, which is the
text that is sent. `PublicValueField`, and so the diagnostic's `detail.field`,
becomes `"journeyLabel" | "displayableAliases" | "errorMessage"`. It is the same
mechanism, not a second one: the same diagnostic kind and code, the same
printed line with logging off, and the value is never changed (ADR-055's
pattern). A `stack` is not examined: the SDK never sends one of its own, and
F-041 is about the message a timeline shows.

*Amended the same day, after review.* The once-per-process rule is kept per
field and shape, not per shape alone, so `personalDataInPublicValues` is at
most 6 (three fields by two shapes) rather than 2. The reason: the fields are
not equally noisy. An error message carries text nobody chose, library paths,
URLs, dates, and under a per-shape rule one false positive there spent the
email warning for the process and silenced a real address in a later journey
label, which warned before this change. A noisier field must not mute a quieter
one. Six lines is still few enough that nobody silences them. The shapes were
tightened in the same change, because error text is where they meet the most
`@` and `+` that are not personal data: an email's local part holds no `/`,
`:`, `[` or `]` and starts the text or follows whitespace, a bracket, a quote,
`,`, `;`, `=` or `:`, and a domain followed by `:`, `/` or `@` is a host, not
an address; so a module path, a versioned package, the SDK's own masked URL
userinfo, a git remote, an ssh target and an image digest are not matched. A
`+` followed by exactly four digits is a timezone offset, not a telephone
number.
`FailureReason`'s TSDoc says that masking covers credential shapes and leaves
personal data in place (F-041).

### Alternatives rejected

- **One list with a discriminator**, such as
  `{ name: string; when: "creation" | "call" }[]`. It changes the type of a field
  a health check already reads as a list of names, and every reader asking the
  one question that matters, "is this process misconfigured", would filter it
  first. Two lists answer that question with one read.
- **A second counter beside `rejectedSettings`**, counting call-time reports.
  A count says how many and never which, which is the gap ADR-060 closed for
  settings, and it would leave the settings list still polluted by calls.
- **A name that covers both**, such as `rejectedConfiguration`. It makes the
  documentation true and the value no more useful: F-038's point is that the
  two mean different things, "this process is misconfigured" against "one call
  site passed something odd", and only the first is a reason to stop.
- **Tagging each report with its phase** through `ReportOptions`. It works
  until someone adds a creation-time report and forgets the tag. `unlimited`,
  the one tag there today, is already not a phase marker: `journeyIdFor`'s
  first secret report passes it at call time.
- **Naming the unknown key**, as `deployment.branch`. The list's bound rests
  on holding only names the SDK wrote; a host-chosen key breaks that and puts
  whatever the host wrote into every log line that prints the list.
- **Reporting only the field when nothing is sent.** Then telling a partial
  refusal from a total one means knowing which fields were given, which is the
  prose-parsing F-031 asks to end. The extra `deployment` entry is one report
  that states the outcome.
- **Dropping the whole deployment when any field is refused.** One bad
  `version` would then cost a correct commit, which is the outcome F-031 shows
  a strict consumer already gets from the list today.
- **Trimming whitespace.** Nothing in `RecorderConfig` is converted, and a
  trimmed value would name a build differently from the one the host gave.

### Consequences

- `personalDataInPublicValues` is at most 6, one per field and shape, and a
  warning for one field never silences another. A handler that assumed at most
  two reads the new bound; nothing else about the warning changes.
- A consumer that refuses to record when the SDK refused a setting, as
  Leadline's `openRecorder` does, reads `rejectedSettings` and gets the same
  answer at any moment, and can let `deployment.version` through while
  refusing `deployment` or `journeyIdSecret`.
- `rejectedSettings` no longer holds `entity`, `context` or `journeyId`, and
  holds `journeyIdSecret` only for a secret configured and unusable. A test that
  expected call-time names there moves to `rejectedOptions`; the SDK's own test
  of two `journeyIdFor` calls without a secret now expects `["batchSize"]` and
  `["journeyIdSecret"]`.
- `{ gitCommit: process.env.GIT_SHA }` with the variable unset now reports
  `deployment`. It was silent, and it sends nothing either way.
- The one-line warning printed at creation is keyed by the setting name, so a
  process prints one per dotted name, which is at most five for `deployment`.
- The public surface grows by one field on `counters()` and one value of an
  existing `detail.field`, and one declaration loosens. `Counters` and the
  diagnostic kinds are documented as open to additions, and a caller of
  `hasJourney` that passed a typed envelope compiles unchanged; one that wrote
  an explicit type argument, which nothing in this repository does, drops it.
- The Node SDK's README, `docs/NODE_SDK_SPEC.md`, the TSDoc on `Counters`,
  `Deployment`, `ConfigurationErrorDiagnostic`,
  `PersonalDataInPublicValueDiagnostic`, `hasJourney` and `FailureReason`, and
  the CHANGELOG say what is decided here. `docs/SDK_SPEC.md` SDK-60 says that
  settings refused at creation are readable apart from options refused on a
  call, and SDK-63 names an error message beside a label and a displayable
  alias, with its conformance row extended to match.

---

## ADR-063: An event names the SDK that recorded it, a failed journey names its failed step, and a drop names its cause

**Status:** Accepted, 2026-09-18. Adds one optional protocol field, one journey
field with a migration, one SDK counter and one breaker rule, and fixes two
defects found while reviewing Leadline's second run. Follows findings F-046,
F-047, F-048 and F-049, and two review items: the telephone shape that ADR-062
tightened, and a deadlock between dry runs. The protocol version stays `0.1`:
every wire change here is an added optional field, which EVENT_PROTOCOL.md
section 11 lists as compatible and ADR-049 makes true in practice.

### Context

Checked against the code at `85a8651`:

- **Nothing says which SDK recorded an event (F-046).** `enqueue` in
  `packages/sdk-node/src/recorder.ts`, which builds every event, sends `deployment` when the host set it
  and never sends `runtime`, so every event from the Node SDK is stored with
  `runtimeMetadata: null`. `runtimeSchema` in `packages/protocol/src/event.ts`
  has `language`, `version`, `hostname` and `processId`, and no field for the
  recorder itself. The SDK does not know its own version at run time: nothing in
  `src/` reads `package.json`, and `scripts/bundle.mjs` bakes nothing in. Both
  builds Leadline ran, from `27f4d64` and from `dcd4fea`, are `0.1.0` in
  `package.json`. The API solved the same problem for itself (F-007):
  `apps/api/src/version.ts` reads `WAYSCRIBE_BUILD_VERSION` and
  `WAYSCRIBE_BUILD_COMMIT`, which `scripts/publish-image.sh` bakes into the
  image, and `/ready` reports them. Leadline's `scripts/pin-sdk.sh` packs the
  SDK from `git archive` output, which has no `.git`, so a commit read with
  `git rev-parse` at pack time would find nothing there.
- **The server already stores and shows `runtime`.** `ingestEvent` stores
  `redactAlways(event.runtime, policy)` as `runtimeMetadata`, the event read
  returns it, and the web app's event detail lists it as the "Runtime" group
  through `metadataEntries` in `apps/web/src/lib/metadata.ts`, one entry per
  key, with a nested value shown as compact JSON. `runtimeSchema` is a plain
  `z.object`, so an unknown key inside `runtime` is stripped before the content
  hash and before storage (ADR-049), and the published JSON Schema does not set
  `additionalProperties: false` (`packages/protocol/src/json-schema.ts`).
- **A failed journey's last step is not its failure (F-047).**
  `updateJourneySummary` in `packages/database/src/repositories/journeys.ts`
  sets `status` to `failed` for any failing event whatever its timestamp, and
  sets `last_step` from the event that is last in timeline order,
  `(timestamp, received at, event id)`, failing or not. So between a failure
  and the event that settles it (ADR-061's successful `retried`, or
  `finish()`), every later successful step moves `lastStep` off the step that
  failed. Nothing stores which event set the failure. `lastStep` reaches the
  journey read (`presentJourneyDetail`), both list rows
  (`presentJourneySummary`), the dry run's preview (`storedJourneySchema`), the
  Journeys table's "Last step" column (`JourneyRow.tsx`), and nothing else: the
  journey page shows the status in `JourneyTimeline`'s summary line, fed by the
  web's events proxy (`journeyStatus`), and the CLI shows no step at all.
- **`dropped` is one number for five causes (F-048).** `DroppedDiagnostic` in
  `packages/sdk-node/src/diagnostics.ts` has the codes `queue_full`
  (`queue.ts`), `after_shutdown` and `shutdown` (`recorder.ts`),
  `retry_budget` (`Transport.giveUp`) and `no_verdict` (`readOutcome`), and
  `Counters.dropped` counts them all together. So a collector that hangs past
  shutdown (`shutdown`) and a proxy answering 2xx with the wrong body
  (`no_verdict`) end with the same counters.
- **A wrong collector never opens the breaker (F-048).** A send whose reply
  gave no verdict for any event returns from `readOutcome` with
  `accepted: 0` and `retry: []`. In `Transport.send` that leaves nothing
  pending and nothing abandoned, which is the branch that sets
  `consecutiveFailures = 0`. So a stream of such replies resets the breaker on
  every send, and Leadline measured `recorded 16000, dropped 16000` with the
  breaker never opened. SDK-32 says a send that stored anything must not count
  toward the breaker; nothing says what a send that got no answer at all counts
  as.
- **Journey ids come in two shapes and the protocol shows neither (F-049).**
  The Node SDK makes a random id as `` `jrn_${randomUUID()}` `` (`recorder.ts`):
  `jrn_` and a lowercase hyphenated version 4 UUID, 40 characters. It derives
  one as `jrn_` and the first 32 lowercase hex characters of an HMAC
  (`journey-id.ts`, SDK-55, ADR-052), 36 characters. EVENT_PROTOCOL.md section
  4 recommends `jrn_<uuidv7>`, which neither is. What checks a journey id:
  `journeyEventSchema` (1 to 128 characters) and, when the SDK reads a
  propagated context, `build` in `propagation.ts`, which requires the `jrn_`
  prefix, at most 256 characters and the characters of `SAFE_VALUE`. Nothing
  checks the part after the prefix.
- **The telephone shape misses what it should find and finds what it should
  not.** `PHONE_SHAPE` in `personal-data.ts` takes a `+` only at the start of
  the value or after whitespace, `(`, `[` or `<`. Measured against a copy of
  the rule: `phone=+19195551234`, `tel:+19195551234` and
  `{"phone":"+19195551234"}` report nothing, and `Received +12345678 bytes`
  reports a telephone number, because any run of 8 to 15 digits after a
  well-placed `+` counts. The email shape already accepts `=`, `:` and a quote
  before an address (ADR-062's amendment); the telephone shape was not given
  the same.
- **Two dry runs deadlock on each other's journeys.** `previewBatch` in
  `apps/api/src/routes/events.ts` runs a dry run's events in one outer
  transaction, each in a savepoint, in the order sent. Each event creates its
  journey (`ensureJourney`, an insert that waits on another transaction's
  uncommitted insert of the same id) and takes its row lock (`lockJourney`),
  and a dry run holds all of them until its rollback. Two dry runs that touch
  journeys A and B in opposite orders each hold one and wait for the other.
  PostgreSQL cancels one statement, which `storageRejection` answers as
  `storage_error` (500), so a preview reports a storage failure that real
  ingestion would never have. The reviewer reproduced it in 50 runs of 50, on
  main before round 2 as well. A live batch cannot do this: `ingestBatch`
  without a dry run gives each event its own transaction, which touches one
  journey and commits before the next event starts.

### Decision

**1. An event names the SDK that recorded it, inside `runtime` (F-046).**

The protocol's `runtime` block gains one optional field, `sdk`:

```typescript
runtime?: {
  language?: string;   // at most 64, as today
  version?: string;    // at most 64, as today
  hostname?: string;   // at most 256, as today
  processId?: number;  // as today
  sdk?: {
    name: string;      // 1 to 128 characters
    version: string;   // 1 to 64 characters
    commit?: string;   // 1 to 128 characters
  };
};
```

In `packages/protocol/src/event.ts` that is a new exported
`runtimeSdkSchema = z.object({ name: z.string().min(1).max(128), version:
z.string().min(1).max(64), commit: z.string().min(1).max(128).optional() })`,
added to `runtimeSchema` as `sdk: runtimeSdkSchema.optional()`. `name` and
`version` are required inside it because an `sdk` object without them says
nothing; the SDK writes them from constants, never from host input, so the
requirement cannot cost a host an event. The limits are the protocol's
existing ones for the same kind of value: `runtime.version`'s 64 for a
version, `deployment.gitCommit`'s 128 for a commit, and 128 for a package
name. A value over a limit is `invalid_event` with the path
`event.runtime.sdk.<field>`, like every field.

It goes inside `runtime` rather than beside it because `runtime` already means
"what was running when this was recorded", which the recorder is part of, and
because it then costs the server nothing: `runtimeMetadata` stores and returns
it with no column, no migration and no change to the event read, and the web
app already lists it.

What the Node SDK sends, on every event, read once when the recorder is
created and frozen as `deployment` is:

- `runtime.language`: `"node"`.
- `runtime.version`: `process.versions.node`.
- `runtime.sdk.name`: `"@wayscribe/node"`.
- `runtime.sdk.version`: the `version` of `packages/sdk-node/package.json`,
  baked into the bundle by `scripts/bundle.mjs` through esbuild's `define`.
  Run from source, where nothing is baked in (only this repository's tests do
  that; containers and npm both run `dist/`), it is `"0.0.0-development"`,
  which cannot be mistaken for a release.
- `runtime.sdk.commit`: the commit the bundle was built from, baked in the same
  way, from the first of these that gives a value (order corrected after
  implementation, see the note at the end):
  1. A new file, `packages/sdk-node/BUILD_COMMIT`, holding `$Format:%H$` and
     marked `export-subst` in `.gitattributes`, so that `git archive`, which is
     how Leadline's `pin-sdk.sh` and a GitLab source download make a tree,
     writes the commit into it. Used when it holds 40 or 64 lowercase hex
     characters (a SHA-1 or a SHA-256 repository), which it does only in an
     archive. First, because it is exact for the tree it sits in and is never
     filled in a checkout, so it cannot be wrong when present.
  2. `WAYSCRIBE_BUILD_COMMIT`, then `CI_COMMIT_SHA`, the variables
     `scripts/publish-image.sh` already reads. A value that is set and is not
     7 to 64 lowercase hex characters fails the build rather than baking in
     something that names no commit, whichever source gives the commit.
  3. `git rev-parse HEAD`, only when `git rev-parse --show-toplevel` run in
     the package directory names the repository root that contains it, so an
     extracted archive that happens to sit inside another repository does not
     take that repository's commit.
  4. None: `commit` is left out.

`hostname` and `processId` are not sent. The question F-046 asks is which
services run which SDK, and `service` with `runtime.sdk` answers it. A
hostname is a new identifier on every event, often a person's name on a
laptop, and nothing here needs it; sending it would be its own decision.

**An old SDK sends none of this**, and its events keep `runtimeMetadata: null`.
That absence is itself the answer during an upgrade: an event with no
`runtime.sdk` was recorded by an SDK from before this decision or by another
client. **An old server** strips `runtime.sdk` as an unknown key and stores the
rest of `runtime`, so a new SDK works against it unchanged.

The web app's event detail keeps the Runtime group and formats one entry:
when `runtimeMetadata.sdk` is an object whose `name` and `version` are strings,
its value is shown as `<name> <version>`, followed by ` at <commit>` when
`commit` is a string, for example `@wayscribe/node 0.1.0 at 27f4d64...` with
the full commit. Any other shape falls back to the compact JSON every other
entry gets. Nothing else in the web app changes.

**2. A failed journey carries the step that failed it (F-047).**

The journey read, both list rows (`GET /v1/journeys` and `GET /v1/search`) and
the dry run's `stored.journey` gain `failedStep: string | null`, beside
`lastStep`. `storedJourneySchema` gains
`failedStep: z.string().nullable()`, described as below.

`failedStep` is the `name` of the failing event that is last in timeline order,
`(timestamp, received at, event id)` under the tie rule `lastStep` uses, among
the failing events applied since the journey last became failed. It is null
whenever `status` is not `failed`.

How it is set and cleared, in the same `update journeys` statement that sets
the status, so it costs no statement:

- The status case is written once as a SQL fragment, `NEW_STATUS`, and used for
  `status` and for the rules below, because every SET expression reads the row
  as it was before the update.
- A failing event (one `deriveStatus` maps to `failed`) takes the failed step
  when the journey was not already failed, or when no failed step is stored,
  or when its own `(event_at, now(), event_id)` is greater than the stored
  one's. That is `TAKES_FAILED_STEP`, written like `TAKES_STEP`:
  `(e.event_status = 'failed' and (status <> 'failed' or failed_step_at is null
  or (e.event_at, now(), e.event_id collate "C") > (failed_step_at,
  coalesce(failed_step_received_at, '-infinity'), failed_step_event_id collate
  "C")))`.
- When `NEW_STATUS` is not `failed`, all four columns are set to null. That
  covers ADR-061's clearing retry, a `completed` at or after the watermark, and
  nothing else, since those are the only ways out of `failed`.

So the answer to "latest-stamped or latest-applied" is latest-stamped, among
the failures that are current. Latest-applied would name whichever failure
happened to arrive last, which depends on delivery order within one failed
episode; latest-stamped does not. It is not independent of arrival order
altogether, because the status is not: which failures belong to the current
episode depends on where a clearing retry fell in arrival order (see the
server half's corrections below). "Among the failures that are
current" is what the clearing buys: a failure that a successful retry cleared
cannot come back as the named step. Two consequences follow from rules already
decided, and are intended:

- A failure stamped before the clearing retry but applied after it fails the
  journey again (ADR-061 keeps that rule deliberately conservative), and
  `failedStep` then names that late failure, because it is the one that set the
  status.
- Two current failures name the later-stamped one whichever arrives first.

A migration adds the columns, `packages/database/migrations/021_journey_failed_step.js`:

```sql
set local lock_timeout = '5s';
alter table journeys
  add column if not exists failed_step text null,
  add column if not exists failed_step_at timestamptz null,
  add column if not exists failed_step_received_at timestamptz null,
  add column if not exists failed_step_event_id text null;
```

This is 020's pattern: nullable columns with no default are a catalogue change
that rewrites nothing, run in knex's migration transaction so `set local`
holds, and `lock_timeout` makes the ALTER give up after five seconds rather
than queue ingestion behind it. It gives up cleanly and is retried by running
`migrate` again. `down` drops the four, under the same timeout. No index: the
list is not filtered by the failed step. No backfill: rebuilding it for every
failed journey means reading their events under row locks that ingestion
needs, for a value the next failure sets anyway.

Old rows, and rows the previous API writes between migrate and deploy, have
null columns. The reads, `journeySummaryColumns` in `journey-summary.ts`,
which both lists use, and `findJourneyDetail` in `journey-reads.ts`, select the
column as
`case when status = 'failed' then failed_step end as "failedStep"`, which hides
a stale value left by a previous-build instance that cleared or completed a
failure without knowing the column, while the journey stays out of `failed`;
and `TAKES_FAILED_STEP`'s `status <> 'failed'` branch replaces such a value
however it is stamped, when a failure is applied while the journey is not
failed. During a rolling deploy the previous build can fail the journey again
and make the stale step visible; the server half's corrections below say
exactly when.
A failed journey with a null `failedStep` is one whose failure predates the
column, and a reader falls back to `lastStep`, which is what it shows today.

The web app:

- The Journeys table's "Last step" header becomes "Step". In a row whose
  status is `failed` and whose `failedStep` is a string, the cell shows
  `failedStep` in the failed style, with the title
  `Failed at <failedStep>; last step <lastStep>`. Every other row shows
  `lastStep` as today.
- The journey page's summary line reads `failed at <failedStep>` where it read
  `failed`, and otherwise as today. The web's events proxy
  (`app/api/journeys/[journeyId]/events/route.ts`) adds
  `journeyFailedStep: string | null` to `EventsPageResponse`, from the journey
  it already fetches, so a live journey's line updates on the same poll as its
  status.
- A search result (`JourneyListItem`) shows `failed at <failedStep>` in its
  status the same way.
- The web types take `failedStep?: string | null`, optional, because an older
  API omits it; absent reads as null.

**3. A drop names its cause, and an answer that is not an answer counts
toward the breaker (F-048).**

`Counters` gains `droppedByCause: Readonly<Record<DroppedCause, number>>`,
where `DroppedCause` is a new exported type,
`type DroppedCause = DroppedDiagnostic["code"]`, today
`"queue_full" | "after_shutdown" | "shutdown" | "retry_budget" | "no_verdict"`.
The keys are the diagnostic codes verbatim, so a report and its counter share
one name. Every key is present from creation, at zero, so a health check reads
it without a guard. Each `dropped` report increments `droppedByCause[code]`
and `dropped`, in the same place `COUNTER_OF` is applied, and `counters()`
returns a fresh copy. `dropped` stays the total, so
`dropped === sum(droppedByCause)` always and
`sent + rejected + dropped === recorded` after `shutdown()` is untouched. A
code added later adds a key, which `Counters`' `@experimental` note already
allows.

F-048's four faults then read apart: a hanging collector and one slower than
the shutdown timeout end in `shutdown`, the two wrong bodies in `no_verdict`.

**The breaker.** A send counts as a failure toward the breaker when the server
gave a verdict for none of its events. Exactly:

- `SendOutcome` gains `noVerdict: number`, the events of that request the reply
  gave no verdict for, which `readOutcome` counts as it reports each
  `no_verdict` drop.
- An attempt **gave a verdict** when `noVerdict` is less than the number of
  events it sent: at least one event was accepted, refused for good, or
  refused for now.
- At the end of `Transport.send`, the rules are, in order: a send that stored
  anything resets the count (SDK-32, unchanged); a send with events still
  unsent or given up adds one (unchanged); a send in which **no attempt gave a
  verdict** adds one (new); any other send resets the count (unchanged, and
  now only for a send the server really answered). A whole-request permanent
  refusal still returns before any of this and leaves the count as it was
  (SDK-31, unchanged).
- Reaching `breakerThreshold` (5) opens the breaker for `breakerCooldownMs`
  (30 seconds), with the existing `breaker_opened` report and code
  `consecutive_failures`. A verdictless send reports no `transport_error`: its
  events are already reported as `dropped` with `no_verdict`.
- Sends already in flight when the breaker opens, at most
  `maxConcurrentSends` minus 1, still complete. Each that fails counts, reports
  `breaker_opened` again and restarts the cooldown, so `breakerOpened` can
  exceed 1 for one episode.
- A send of no events neither counts toward the breaker nor resets it. `flush`
  never sends one, and the rule does not depend on that.

What resets it: a send that stored something, or a send that got at least one
verdict and left nothing unsent, and the cooldown ending, as today. A reply
with some verdicts and some missing is a server speaking the protocol badly,
not a wrong collector, and it resets as today. While the breaker is open,
events wait in the queue instead of being sent into a reply that loses them,
so a misconfigured proxy now shows `breakerOpened` above zero and loses events
as `queue_full` or `shutdown` only once the queue is full or the process ends.

**4. Journey ids have two documented shapes, and nothing checks either
(F-049).**

They are not unified. Changing the derived shape would give every derived
journey a new id at the SDK upgrade, splitting each one in two, which is the one
thing derivation exists to prevent (ADR-052). Changing the random shape buys
nothing, since random ids join nothing across versions, and would make the two
shapes no more alike. Both are stated instead, in EVENT_PROTOCOL.md section 4
under `journeyId`, replacing the `jrn_<uuidv7>` recommendation that neither
matches:

- random: `jrn_` and a lowercase hyphenated UUID, 40 characters, such as
  `jrn_dd37c205-7ea6-4e14-bc8f-c07022f96696`;
- derived: `jrn_` and 32 lowercase hex characters, 36 characters, such as
  `jrn_5f93deccb9b599e792d560765761bec6`, computed as SDK-55 says.

The section says that a journey id is an opaque string of 1 to 128 characters,
that the server checks nothing else about it, that another client may use any
unpredictable id, and that a reader must not parse or validate the shape. The
one check that exists stays as it is and must not be tightened: the SDK's
propagation reader requires the `jrn_` prefix and the characters of
`SAFE_VALUE`, which both shapes satisfy. No schema, route or reader gains a
shape check. API_SPEC.md and INGESTION_CONTRACT.md keep `jrn_01` in their
examples, and API_SPEC.md section 7 points to EVENT_PROTOCOL.md section 4 for
what a real id looks like.

**5. A telephone number may follow `=`, `:` or a quote, and a bare count is
not one (review).**

`PHONE_SHAPE` becomes, in order:

1. **Where the `+` may be:** at the start of the examined text, or after
   whitespace or one of `<`, `>`, `(`, `)`, `[`, `"`, `'`, `,`, `;`, `=`, `:`.
   That is the email shape's delimiter set plus `[`, which the telephone shape
   already accepted. A `+` after a letter, a digit or `.` is still not a
   dialling code (`1.2.3+20130313144700`, `12:00:00+01:00`).
2. **The candidate:** the `+` and the run of digits, spaces, `(`, `)`, `.` and
   `-` after it, at most 20 characters as today.
3. **A real timezone offset is skipped:** `+`, hours 00 to 14, minutes 00, 15,
   30 or 45, and no fifth digit. So `+0000 2026` and `+0530` are skipped, and
   `+1234 5678`, `+4930 1234567` and `+3531 234 5678` are found.
4. **Digits:** 8 to 15 when a separator stands between two of the digits;
   **10 to 15 when the digits are one unbroken run.**

The last rule is what removes `Received +12345678 bytes`: a signed count is an
unbroken run, and so is a telephone number written in a field, but a real one
in a field is nearly always 10 digits or more (`+1` and ten, `+44` and ten).
What it gives up: an unbroken number of 8 or 9 digits from a few small numbering
plans, written with no separator. Matched after this: `phone=+19195551234`,
`tel:+19195551234`, `{"phone":"+19195551234"}`, `+1 919 555 1234`,
`(+44) 20 7946 0958`. Not matched: `Received +12345678 bytes`, `+3 more`,
`1.2.3+20130313144700`, `2026-09-17T12:00:00+01:00`,
`Fri Sep 18 14:00:00 +0000 2026`. The rule stays a warning that never changes
the value, once per field and shape (ADR-062).

**6. A dry run takes its journeys in one fixed order before it starts
(review).**

Before its first event, `previewBatch` takes, inside its outer transaction, one
transaction-scoped advisory lock per distinct journey the batch names, in
ascending order of key:

- The journeys are the `event.journeyId` strings it can read from the raw
  elements, without parsing; an element with none touches no journey and adds
  no lock.
- Each key is the two-integer form,
  `pg_advisory_xact_lock(DRY_RUN_JOURNEY_LOCK, <key>)`, where
  `DRY_RUN_JOURNEY_LOCK` is a fixed `int4` constant named in the route and
  `<key>` is the first four bytes of SHA-256 over the project id, a NUL, and
  the journey id, read as a signed 32-bit integer. PostgreSQL keeps the
  two-integer key space apart from the single-`bigint` keys retention and
  rotation use, so these cannot meet them.
- Keys are deduplicated and taken one statement each, in ascending numeric
  order. One statement that relies on the planner to evaluate the calls in
  array order is not acceptable, because nothing guarantees that order.

Every dry run then acquires the journeys it shares with another in the same
order, and the second waits at its start for the first to roll back instead
of taking half of them. A hash collision only makes two unrelated dry runs
wait for each other, and cannot deadlock, because the order is by key. A wait
here is bounded by `DATABASE_STATEMENT_TIMEOUT_MS` like any statement, and a
timeout answers the whole request `503 query_timeout` through the app's error
handler, which a client retries.

Live batches do not take these locks. Each live event is its own transaction
touching one journey, so it holds at most one journey while it waits and
cannot close a cycle; a lock statement per event would be a cost on the hot
path for a deadlock that cannot happen. A live event can still wait on a dry
run's journey, which ADR-050 already says.

### Alternatives rejected

- **`sdk` beside `runtime`, at the top of the event.** It would need a column
  or a place in another stored block, a change to the event read and a new
  group in the web app, where inside `runtime` it needs none of them. And the
  recorder is part of what was running, which is what `runtime` describes.
- **Flat fields, `runtime.sdkName` and `runtime.sdkVersion`.** They would read
  better in today's metadata list, and they split one fact into fields that
  mean nothing apart. The web formats the one entry instead.
- **The SDK's version alone, without a commit.** Both of F-046's builds are
  `0.1.0`, and every build between releases will be too. Bumping the version on
  every commit is not how the package is released.
- **A commit read with `git` at pack time, and nothing else.** Leadline packs
  from `git archive`, where there is no repository, and would have got nothing,
  which is the case F-046 was found in. `export-subst` is the mechanism git
  provides for exactly that.
- **Sending `hostname` and `processId` because the protocol has them.** See the
  decision: F-046 does not need them, and a hostname is personal data often
  enough to be its own decision.
- **Deriving the failed step on read, from the journey's events.** Every list
  row would join to `journey_events` and find the right failure among them,
  which is the cost 018 avoided for `lastStep` by storing it.
- **`failedStep` as the latest-applied failure, one column.** It depends on
  arrival order within one failed episode, so the same failures delivered
  differently would name different steps even where the status does not
  differ. Latest-stamped removes that dependence; the one that remains comes
  from the status itself (the server half's corrections below).
- **Replacing `lastStep` with the failed step on a failed journey.** The field
  would mean two things depending on another field, and the timeline's last
  row would no longer be `lastStep`, which EVENT_PROTOCOL.md section 3 says it
  is.
- **A backfill of `failed_step`.** It reads every failed journey's events under
  locks ingestion needs, during a migration that 019 and 020 took care to keep
  from blocking ingestion.
- **Separate counters, `droppedQueueFull` and so on.** Five top-level fields
  that a reader must know to sum, and a sixth for every new cause, where one
  record keyed by the code the diagnostic already carries grows by itself.
- **Leaving the breaker alone because `no_verdict` is already reported.** A
  report nobody reads does not stop a process sending every event into a proxy
  that loses them; the breaker is what stops the sending, and the finding
  measured 16,000 events lost without it opening.
- **Counting any send with a missing verdict toward the breaker.** A reply with
  some verdicts is a server answering, and opening the breaker on it would
  stop delivery of the events it does store, which is what SDK-32 exists to
  prevent.
- **Retrying a verdictless event.** SDK-33 forbids it for the reason it gives:
  the request succeeded and the server may have stored the event.
- **One journey id shape.** See the decision: unifying the derived shape splits
  every derived journey at the upgrade.
- **Validating the two shapes on the server.** It would refuse ids another
  client makes legitimately, including Leadline's disabled recorder's, and an
  SDK in another language would have to copy a rule that protects nothing.
- **A telephone rule with a list of unit words**, such as "bytes" or "ms" after
  the number. Unbounded, and exactly the cleverer rule that `personal-data.ts`
  says it will not be.
- **Processing a dry run's events in journey order.** It changes the answer:
  the batch is ordered, and the same event id in two positions is an accept
  and then a duplicate or a conflict by position (ADR-050), which a reordering
  would swap.
- **Locking the journey rows themselves, sorted, at the start.** A journey the
  batch will create has no row to lock, and two dry runs creating the same two
  journeys in opposite orders deadlock on the inserts.
- **Retrying a dry run's event on a deadlock.** It turns a deterministic
  preview into one that depends on timing, and the retry can deadlock again.

### Consequences

- **Public surface, exactly.**
  - Protocol: `runtime.sdk?: { name: string; version: string; commit?: string }`,
    limits 128, 64 and 128, exported as `runtimeSdkSchema`. The committed JSON
    Schemas under `packages/protocol/schemas/0.1/` are regenerated.
  - API: `failedStep: string | null` on `GET /v1/journeys/:journeyId`, on each
    item of `GET /v1/journeys` and `GET /v1/search`, and on a dry run's
    `stored.journey`; `storedJourneySchema` gains it. `runtimeMetadata` on an
    event read may now hold `sdk`; its type stays open.
  - SDK: `Counters.droppedByCause: Readonly<Record<DroppedCause, number>>` and
    the exported type `DroppedCause`. Events carry `runtime`. A verdictless send
    counts toward the breaker. The personal-data warning's telephone shape
    changes as stated.
  - Database: migration `021_journey_failed_step.js`, adding
    `journeys.failed_step text`, `failed_step_at timestamptz`,
    `failed_step_received_at timestamptz` and `failed_step_event_id text`, all
    null.
  - Web: the Journeys table's "Last step" header becomes "Step";
    `EventsPageResponse.journeyFailedStep: string | null`.
- **Content hashes cover `runtime.sdk`**, like every protocol field, because the
  hash is taken over the parsed event. One narrow case follows, and it is the
  one every added field already has: an SDK upgraded before its server, whose
  first delivery of an event reached the old server (which stripped the field)
  and whose response was lost, resends it to the upgraded server and gets
  `event_id_conflict`. The event is stored; the SDK counts it `rejected`. It
  needs the upgrade to land between an event's two deliveries, and the order
  Leadline followed, server first, never meets it.
- Every Node SDK event grows by about 150 bytes of `runtime` with a
  40-character commit, and about 100 without one, stored in
  `runtime_metadata`. The event budget is unchanged and the SDK's fitting
  (ADR-051) counts it like any field.
- Leadline's `pin-sdk.sh` gets the commit with no change, through
  `export-subst`. A build from a modified working tree bakes in its `HEAD`,
  which is a limitation of any commit stamp, and is not marked.
- Nothing in Wayscribe yet lists which SDK each service runs; a reader opens an
  event per service. A view of that is not decided here.
- A failed journey created before migration 021 shows `lastStep` in the
  Journeys table until its next failure, as it does today.
- `scripts/upgrade-test.mjs` is extended to assert that the baseline's
  journeys read `failedStep` null beside `label` and `lastStep`.
- A misconfigured proxy now opens the breaker after five sends. Events then
  queue for 30 seconds rather than being lost to the proxy, and are lost as
  `queue_full` if the queue fills first, which `droppedByCause` says.
- Dry runs that share a journey run one after the other. A conformance suite
  that sends two batches against the same journeys concurrently takes the time
  of both, and no longer gets a spurious `storage_error`. The reviewer's
  reproduction, 50 runs of two dry runs over two journeys in opposite orders,
  becomes an integration test in `dry-run.integration.test.ts` expecting no
  `storage_error`.
- Documentation that says what is decided here: EVENT_PROTOCOL.md sections 3
  (`runtime.sdk`, and `failedStep` beside the last step) and 4 (the two
  journey id shapes); API_SPEC.md sections 5 to 7 (`failedStep`, with the
  example items showing it) and 7's pointer to the id shapes;
  INGESTION_CONTRACT.md section 8 (dry runs sharing a journey wait for each
  other); `docs/SDK_SPEC.md`, where SDK-42 names dropped by cause, SDK-63
  states the new telephone rule, SDK-64 says an SDK SHOULD send
  `runtime.language`, `runtime.version` and `runtime.sdk` and MUST NOT take
  them from host settings, and SDK-65 says a send in which no attempt got a
  verdict for any event MUST count toward the breaker; the Node SDK's README
  (counters, and "Which build recorded this"), `docs/NODE_SDK_SPEC.md`,
  OPERATIONS.md's counters paragraph, the TSDoc on `Counters` and
  `DroppedDiagnostic`, and the CHANGELOG. Two wire conformance cases cover
  `runtime.sdk`: one stored and read back, one refused with the path
  `event.runtime.sdk.name`.

### Corrections after implementation (2026-09-18)

Made while implementing and reviewing the SDK half, and folded into the text
above:

- **The commit order.** `BUILD_COMMIT` comes first, before the two variables.
  Packing an archive inside another project's GitLab CI job baked in that
  project's `CI_COMMIT_SHA`, which names nothing here; `BUILD_COMMIT` is exact
  for the tree it sits in and is never filled in a checkout.
- **`BUILD_COMMIT`'s format** is 40 or 64 lowercase hex characters, so a
  SHA-256 repository's archive is read too.
- **`readOutcome`** reported missing verdicts and did not count them; it now
  counts one as it reports each `no_verdict` drop.
- **Decision 5.** The step that cut the candidate after its last digit is gone:
  a separator after the last digit is not between two digits, and a fuzz of 2
  million cases found it changed no outcome. The timezone step skipped any
  `+` and four digits, which also skipped numbers such as `+4930 1234567`; it
  now skips a real offset only.
- **The breaker under concurrency** and **an empty batch** are stated above.
- **Event size.** About 150 bytes with a 40-character commit and about 100
  without one, not about 130.
- **The SDK specification.** SDK-64 and SDK-65 sit at the end of section 13 of
  `docs/SDK_SPEC.md`, not in the event and transport sections, because
  requirement numbers must follow document order (`tests/docs-truth.test.ts`).

### Corrections after implementation, the server half (2026-09-18)

- **Status is not independent of arrival order, so `failedStep` is not either once a clearing retry is involved.** Decision 2 said every other summary field is independent of the order events arrive in. `status` is not, by ADR-061's design: a failure registers whatever its timestamp says, and a clearing retry applies only when it arrives while the journey is failed and at or after the watermark. Failures stamped t10 and t11 with a clearing retry stamped t12 end `active` when the retry is applied last, and `failed` in the other four orders. `completed_at` depends on arrival order the same way. What the latest-stamped rule guarantees is narrower. Among the failures of one failed episode, the later-stamped one is named whichever arrives first, and a dry run names what the send that follows it in the same order will name. Which failures belong to the current episode depends on where a clearing retry fell in arrival order, so the same events can name different steps: t11, t12, t10 ends failed at t10's step, and t12, t10, t11 ends failed at t11's. Latest-stamped is still the choice, because latest-applied would add a second dependence on order within an episode. The summary fields that are independent of arrival order are `started_at`, `last_event_at`, `event_count`, `label` and `lastStep`.
- **A previous build can make a stale value visible during a rolling deploy.** The reads' `case when status = 'failed'` hides a value the previous build left when it cleared or completed a failed journey, but only while the journey stays out of `failed`. If the previous build then fails the journey again, the read names the earlier, cleared step until a failure applied by this build, and stamped later, replaces it. `TAKES_FAILED_STEP`'s `status <> 'failed'` branch replaces a stale value only when the journey is not failed at the time. Likewise, a failure the previous build applies to a journey this build already failed is not recorded as the failed step. All of this needs the previous build to write the journey after the migration, so it ends with the deploy, and it can only name a step that did fail in that journey.
- **Decision 6 now orders event ids as well as journeys.** Two dry runs that send the same event ids under different journeys, in opposite orders, deadlocked on the `journey_events` insert, because an event id is unique per project whatever the journey and an insert waits on another transaction's uncommitted row with the same id; the journey locks did not order them, and the reviewer measured 20 `storage_error` runs of 20. A dry run now also takes one lock per distinct `event.id` string read from the raw elements without parsing, keyed `pg_advisory_xact_lock(DRY_RUN_EVENT_LOCK, <key>)` with the same SHA-256 derivation over the project id, a NUL and the event id. `DRY_RUN_EVENT_LOCK` is `49_190_064` and `DRY_RUN_JOURNEY_LOCK` `49_190_063`, so a journey id and an event id with the same text never share a lock. Every lock is taken one statement each in one order, ascending by the pair: all journey keys ascending, then all event keys ascending, before the first event. The reproduction is an integration test in `dry-run.integration.test.ts` that fails 20 of 20 without the event locks. On a 100-event dry run with 100 distinct ids the 100 event-id lock statements measured 15.5 to 17.3 ms at the median against a dry run of about 420 ms; the before and after medians of the whole dry run were within run-to-run noise. Live batches still take no lock. The key is the first four bytes read big-endian, which decision 6 left unstated.
- **A journey id containing a NUL.** The protocol accepts any 1 to 128 characters, but PostgreSQL refuses a NUL in text: such an event is refused `unstorable_payload`, and the read routes answer `404` for such an id. EVENT_PROTOCOL.md section 4 says so.

---

## ADR-064: Per-record timing is explicit bounded evidence, not inferred monitoring

**Status:** Accepted, 2026-09-18. Completes the timing and context scope before
the first release without adding a service, dependency, event operation,
database column or protocol version. The wire remains `0.1`: the vocabulary is
optional metadata, and all read/filter additions are additive.

### Context

An immutable event already says when a step began and may say how long it ran,
but a record investigation cannot distinguish queue backlog, retry backoff,
remote rate limiting, ordinary work and clock disagreement from those two
numbers alone. Leadline exposed the unsafe shortcuts: it replaced unknown waits
with zero, treated a retry's age since initial enqueue as queue wait, and named
HTTP status under the generic key `status`. Event names and adjacency cannot
prove that two queue events concern the same message or that attempts belong to
one retry sequence.

A top-level timing object or storage column would duplicate arbitrary metadata
and complicate mixed-version installations. Aggregate metrics, alerts and
workflow orchestration would also turn a record-first debugger into a monitoring
system. The smaller compatible change is a strict vocabulary for evidence the
caller or broker actually has, plus a bounded read projection and presentation
rules that preserve uncertainty.

### Decision

**1. Timing uses optional metadata and one protocol-owned interpretation.**

`EVENT_PROTOCOL.md` section 9 defines `queue`, `queueWaitMs`,
`queueWaitBasis`, `deliveryCount`, `targetHost`, `httpStatusCode`,
`retryAfterMs`, the existing `attempt`, and `retryGroup`, with the exact bounds
there. Metadata wire acceptance is unchanged. Invalid values remain available
in raw event detail but are not presented as measurements.

The protocol package exports `TimingContext` and `timingContext(metadata)`. It
reads only own fields of already-redacted stored JSON, validates each field
independently and returns a new object containing only valid named fields. A bad
field cannot cost another field or the event. Unknown, negative, fractional,
non-finite, out-of-range and redacted values are omitted, never changed to zero;
a measured zero remains zero. Redaction and capture markers are never queue,
host or retry identity, because grouping under `[REDACTED]` would merge
unrelated work.

A queue wait is measured only when all evidence agrees. `initial-enqueue`
requires recorded attempt 1 and no explicit `deliveryCount` above 1.
`retry-ready` requires an attempt above 1. A broker can redeliver a stalled job
before any application attempt finishes, so attempt 1 does not outweigh an
explicit second delivery. The original enqueue time is never accepted as a
retry-readiness boundary. Timeline
reads project only the named metadata keys and no payload. They may include
`recordedHost`, bounded to 256 code points, from already-redacted
`runtime.hostname`; a marker is not host evidence. Event detail applies the
same parser while retaining raw metadata.

**2. SDK helpers create evidence without owning application control flow.**

The Node package exports standalone `queueMetadata(job, options?)` and
`httpMetadata(response, options?)`, plus their structural input, option and
result types. They return ordinary metadata for existing `record`, wrapper
`metadata` and `metadataFrom` calls. They add no broker or HTTP dependency and
do not change propagation envelopes.

`queueMetadata` reads the BullMQ-shaped `queueName`, `id`, initial enqueue
`timestamp`, current-attempt `processedOn`, and completed-attempt count
`attemptsMade`. A valid nonnegative safe `attemptsMade` becomes current attempt
`+ 1`. Attempt 1 may measure `processedOn - timestamp` unless caller-supplied
`deliveryCount` above 1 proves redelivery. A later attempt has no measured wait
unless the caller supplies a valid `readyAgainAt`; then it uses
`processedOn - readyAgainAt` with `retry-ready`. Unknown clocks never fall back
to `Date.now`, negative differences never clamp to zero, and `deliveryCount` is
only an explicit caller value. Usable queue and job ids form the unambiguous
identity ``queue:${JSON.stringify([queueName, id])}``; if the complete value
does not fit 256 code points it is omitted rather than truncated into a
collision.

The helper's `attempt` must also be passed as the wrapper's top-level `attempt`.
The wrapper owns attempt and operation, defaults to one, and applies its own
attempt after static and projected metadata. Arbitrary metadata alone cannot
turn `delivered` into `retried`. Raw `record` calls choose their operation
explicitly. Attempt outcome remains separate: `error` or operation `failed`
means the attempt failed; a successful `retried` event means that attempt
worked, not that the journey completed.

`httpMetadata` reads numeric response `status`,
`headers.get("retry-after")`, and an optional `targetUrl`. It records only the
parsed URL host, never credentials, path or query. `Retry-After` accepts
nonnegative integer delay-seconds or a valid non-past HTTP date; `now`, or
`Date.now()` when it is absent, is only the observation instant for the latter.
A malformed or past date is unknown and a real zero is kept. Getters, proxies,
headers and fields are isolated so one unreadable value costs only itself and
nothing escapes into host code. The packed ESM entry point and `require()` of
that ESM both expose the helpers.

**3. Journey duration and list filters use existing stored facts.**

Displayed journey duration is `lastEventAt - startedAt`, the span between
recorded event starts. It is not summed step time, time since journey creation,
or completion latency. A one-event journey has measured span zero; its last
step may still have duration, and clocks from different hosts may disagree.
No mutable timing cache or migration is added.

The bounded journey list gains three filters, combined with existing predicates
and pagination: `minDurationMs` matches a first-to-last span strictly greater
than a nonnegative integer threshold; `minStepDurationMs` matches any stored
event duration strictly greater than the threshold, with project and journey
both scoped; and `inactiveBefore` matches only active journeys whose last event
is strictly before a zoned ISO instant. Numeric bounds are 0 through
2,147,483,647. Invalid or future inactivity cutoffs and a contradictory
non-active status are refused. The web GET form freezes the explicit inactivity
cutoff across pagination, as it does the rolling window, and calls inactivity a
debugging clue rather than proof a job is stuck. Query plans are measured before
adding an index.

**4. Timeline timing preserves adjacency, clocks and retry ambiguity.**

For consecutive loaded events, end-to-next-start is calculated only when the
previous duration and both timestamps are valid. Positive is a recorded gap,
zero stays zero, and negative is overlap or clock disagreement rather than idle
time clamped to zero. Missing duration leaves the idle gap unknown. Gaps are
computed on the unfiltered loaded page so hiding a service or operation cannot
invent adjacency; the first loaded row gets no fabricated prior gap.

An adjacent `published` to `consumed` pair may be labelled
`Publish → consume gap`, explicitly not broker-measured queue wait and not proof
of matching messages. Cross-host or missing-host evidence carries a clock
caveat; matching service names do not prove one clock.

Attempts are grouped only by explicit `(service, name, retryGroup)` within a
journey. Without `retryGroup`, each attempt remains visible and unlinked.
Attempt-to-attempt delay is calculated only for unambiguous adjacent attempt
numbers with known previous duration. Duplicate or missing attempt numbers,
missing duration, negative delay and incomplete pages stay explicit. No loaded
page proves a winning or final attempt. Older APIs that omit timing context
remain readable, and the UI never fetches every event detail to render timing.

### Consequences

- Mixed-version ingestion remains compatible: an old server accepts metadata
  and a new reader omits evidence it cannot validate.
- The read model gains bounded `timingContext` and `recordedHost`; raw metadata
  remains on detail only. Response-schema additions and API filters are the
  server implementation of this decision, not changes to event ingestion.
- The Node public surface grows by two functions and six structural types:
  `queueMetadata`, `httpMetadata`, `QueueMetadataJob`,
  `QueueMetadataOptions`, `QueueTimingMetadata`, `HttpMetadataResponse`,
  `HttpMetadataOptions`, and `HttpTimingMetadata` (two functions and six
  types).
- Leadline adopts the helpers, records explicit retry readiness and compares
  its manifest under the same unknown-versus-zero rules. Queue backlog,
  retries/rate limits, ordinary and slow steps, active inactivity, and
  missing/corrupt broker timing are dogfooded before roadmap completion.
- Verification covers bounds, unknown versus zero, redaction markers, hostile
  SDK inputs, retry identity ambiguity, clock overlap, filtered/paginated
  adjacency, strict/auth-scoped filters, no-JS/mobile form behavior, and packed
  SDK exports. Release claims remain gated on that evidence and review.

---

## ADR-065: Python, then Go, then optional OTLP, on one propagation contract

**Status:** Accepted, 2026-09-20. Supersedes ADR-059's order after Python and
ADR-049's pilot-demand condition for Go. The contract-first requirement in
both decisions remains.

### Context

The first release proved the Node recorder and published a language-neutral
event and ingestion contract. It did not freeze propagation: HTTP header names,
SQS/SNS attribute names, payload-envelope fields, value grammar, and malformed
input behavior still lived only in the released Node implementation.

ADR-059 chose Python next, followed by optional OTLP log ingestion and then
languages requested by pilot teams. The owner has now approved a native Go
recorder as the third implementation. Building Python and Go before OTLP makes
the record-oriented API available directly in the two next target ecosystems;
OTLP remains useful interoperability for applications that do not use a native
recorder.

The same program approved a mixed-language exercise, an explicit setup and
redaction preview, small backup and isolated-restore helpers, bounded
per-project ingestion controls, and one project-scoped view-only capability.
These are practical self-hosting gaps. They do not change the free core, add a
required service, or broaden replay authority.

### Decision

1. [`PROPAGATION_SPEC.md`](PROPAGATION_SPEC.md) and
   `packages/protocol/fixtures/propagation.json` freeze the released HTTP,
   SQS/SNS, and payload-envelope behavior. The Node SDK runs those literal
   vectors first. Later recorders use the specification and vectors rather than
   copying Node source.
2. The implementation sequence is Python, native Go, then optional OTLP logs
   over HTTP. Python and Go send directly to the existing event API and do not
   depend on OpenTelemetry. The OTLP receiver remains disabled by default;
   traces, metrics, gRPC, and a required Collector remain out of scope.
3. Python and Go are not complete until their applicable event and propagation
   fixtures pass, the exact bytes are accepted by the real local dry-run API,
   transport failure is isolated from the host, and their concurrency and
   shutdown behavior is exercised. Go additionally needs race tests.
4. A mixed Node → Python → Go workflow must prove one journey with identity,
   transformation, retry/failure, and HTTP or queue-style propagation. Setup
   checking and redaction preview use the dry-run contract, mask secret output,
   and do not silently store journey events.
5. Backup and restore helpers wrap PostgreSQL's tools. A restore check creates
   a new isolated database and never overwrites an existing database. Key
   custody stays separate.
6. Per-project ingestion controls apply consistently to native and OTLP paths,
   use bounded bookkeeping, and state their process or replica scope. A
   project-scoped view-only capability may read journey status and timelines,
   but cannot read payloads, replay, delete, or administer projects.

The carrier has no environment field. A recorder uses its configured
environment and the server binds its API key to that environment and refuses a
journey already owned by another one. No implementation adds environment
metadata to the released carriers merely to make local extraction decide that
boundary.

### Consequences

- ADR-049's title and historical rationale stay unchanged. Its pilot condition
  no longer applies to Python or Go; it still applies to any further native
  language.
- ADR-059 still decides why Python is second, while this decision replaces its
  Python → OTLP → pilot-demand ordering with Python → Go → optional OTLP.
- Propagation names and behavior are no longer experimental. Changing them is
  a contract change and needs versioning and a compatibility plan.
- None of the Python, Go, OTLP, operational, rate-control, or read-capability
  deliverables is claimed as shipped by this decision. Each remains separate,
  locally verified implementation work.

### Alternatives rejected

- **OTLP before Go.** It reaches more languages but offers a mapping rather
  than the native record-oriented wrappers and concurrency behavior the Go
  recorder can enforce.
- **Adding environment to every carrier.** That breaks released carrier bytes
  and duplicates the recorder configuration and server contract that already
  enforce isolation.
- **One combined implementation change.** The propagation contract, native
  recorders, interoperability, and operator controls need independent review
  and verification boundaries.

## ADR-066: Optional annotated OTLP HTTP logs reuse native ingestion

**Status:** Accepted. Implements the optional receiver sequence approved by ADR-065.

Applications that already export OTLP logs can explicitly annotate business events
without adopting a native recorder. Generic log bodies and severity do not describe
a deterministic journey, so they are ignored. Stable caller event/journey IDs and
timestamps are required; the adapter never invents identity, time, runtime SDK
metadata or failure outcomes.

`OTLP_LOGS_ENABLED` defaults false and leaves `/v1/logs` absent. When enabled,
JSON/protobuf with identity/gzip use the existing listener and environment API
keys. Scoped parsers bound compressed and expanded bytes and validate the whole
export's count before writing. Only the two settings documented in
[OTLP_LOGS.md](OTLP_LOGS.md) are added; no service or runtime exporter is introduced.

Mapped envelopes go through `ingestEvent`, preserving authoritative capture,
redaction, scope, aliases, diffs, hashing and idempotency. Permanent refusals
produce HTTP 200 partial success with only a count and fixed summary. The first
transient authentication/storage failure produces 503 without partial success,
even when earlier events committed. Processing stops and earlier commits remain;
an unchanged retry reuses stable IDs and becomes duplicate evidence, not new rows.
PostgreSQL poison-text refusals remain permanent using native classification.

Authentication/parser/storage diagnostics are fixed safe summaries. Admin tokens
cannot ingest and the failed-admin-auth throttle does not cover logs. An official
pinned Python exporter is isolated example/test tooling; native SDKs never depend
on it. Publication/deployment are separate from local source implementation.
