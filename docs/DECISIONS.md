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

Both are the same underlying problem — migration identity must not depend on how
the process was started.

### Decision

Migrations and seeds are plain ESM JavaScript in `packages/database/migrations` and
`packages/database/seeds`, at the package root rather than under `src`. Knex is
configured with `loadExtensions: [".js"]` only. Knex types are supplied through
JSDoc.

The directories resolve as `../migrations` relative to the Knex configuration
module, which sits at `src/knex-config.ts` in development and `dist/knex-config.js`
in a container — both exactly one level below the package root.

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
lookup and was therefore unusable, and the product's central promise — type an
identifier into a search box and find the record — could not work, because a developer
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
`phone` changing from a value to `null` with `name` unchanged — both sides using
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

Review stays and is mandatory — the prepare screen shows exactly what will be sent, which
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
this decision declines: every destination the feature exists for — `localhost`,
`host.docker.internal`, a Compose service name — resolves into a private range. Blocking
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
two inputs — a cycle and a BigInt — and both were caught and reported as
`payload_too_large`.

Both reports were wrong, and wrong in a way that cost the payload:

- A cycle is capturable. ADR-030's redaction walk marks the point where a loop closes and
  keeps the rest of the structure. But `checkLimits` runs first, so that repair was
  unreachable — every parent/child graph an ORM hands back was discarded before reaching
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
- Genuine failures — a getter or a `toJSON` that throws — get their own reason,
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

`DEFAULT_SECRET_PATHS` shipped each name twice — `authorization` and `*.authorization` —
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
mode, including the default, and at both redaction points — the SDK before buffering and
the server before persistence — because both append the same list.

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
narrowed while descending — not as a general glob. The security property is then a single
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
was simply empty, with nothing to say so — the same failure ADR-030 fixed for `Date`, in
the values `toJSON` does not cover.

An `Error` is the sharp case. This is a debugging tool, and an error stored as `{}` is the
one payload a reader most needs. An axios failure carries `config` and `response` as
assigned own properties, so those survived, while `name` and `message` — the two fields
that say what went wrong — did not.

### Decision

One shallow `renderExotic` step, placed in `walk` immediately after the `toJSON` step it
mirrors, returning through the same single exit: `walk(rendered, paths, anyDepth, seen)`.

Two properties carry the whole security argument, and both are pinned by tests.

**Shallow.** A render never recurses. Its values are the *original* references, handed
straight back to the walk that called it, with the paths un-advanced. Converting a subtree
inside the renderer would carry it past every remaining match site and past the ancestor
set that detects cycles — that single change would turn this from a fix into a leak.

**Plain.** A render emits ordinary objects and arrays under the keys the data already had,
with no wrapper frame and no type marker. The path a reader sees in a stored payload is
therefore the path a redaction rule matches. A `{__type, entries}` wrapper would push every
key one level down, so `headers.authorization` in the interface would need a rule written
against `headers.entries.authorization`, and the rule that looked right would silently
match nothing while the secret kept flowing. A marker is also a stored `jsonb` shape: once
payloads land it propagates into `payload_diff` and the interface, and reverting the code
would not revert the data.

Detection is two-stage. `Object.prototype.toString` is a fast candidate filter, and each
branch then confirms by reaching for the intrinsic itself — `Map.prototype.entries`, the
`RegExp.prototype.source` getter — which a forgery cannot satisfy and which works across
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
  value — the marker is dropped rather than the data.
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
credential rotation — not in a container the tool brought with it.

Worse, an installation could not be used at all. `key:create` requires a project, and the
only two projects that could ever exist came from the two hardcoded seeds, `local` and
`demo`, neither of which the published stack ran. A team following the documented quick
start reached "No projects yet", had no command to create one, and stopped there. Nothing
downstream — SDK, timeline, diff, replay — was reachable from a fresh install.

`key:create` was also documented only as `pnpm key:create`, which needs the repository
cloned, contradicting a quick start whose premise is that no checkout is required.

### Decision

`DATABASE_URL` is required and points at the operator's PostgreSQL. The bundled database
moves to `infrastructure/compose.bundled.yaml`, an overlay for evaluation and local work.

An overlay rather than a Compose profile: a profiled service cannot be the target of
`depends_on`, and `docker compose config` refuses the file outright — *service "app"
depends on undefined service "postgres"*. Compose also interpolates each file before
merging them, so `${DATABASE_URL:?...}` in the base would refuse to start even when the
overlay is about to supply the value. The variable is therefore permissive in the file, and
both the API's config loader and the migration CLI say what to do when it is unset.

`project:create` and `project:list` join the CLI, which the published image already
carries — `migrate` runs from it. The documented invocation is the container one, so the
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

The boundary was real in the schema — `journeys` and `journey_events` both carry
`environment_id` with foreign keys — enforced on one route, and absent on the three that
return the data.

The test suite contained a case that looks like it covers this and does not. *"returns 404
for another project's journey and event"* builds a second **project**, which composite keys
already make unreachable. Nothing tested a second environment of the same project.

### Decision

`ReadScope` — `{ projectId, environmentId? }` — moves out of `search.ts`, where it lived as
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

Key names are normalised — lowercased, with `-` and `_` removed — on both sides of the
comparison. `apiKey`, `api_key`, `api-key` and `APIKey` are one name. Only case and
separators go; `secret` still does not match `secretary`, because the point is one name
spelled differently rather than one name resembling another.

Normalisation applies to operator-configured paths too, so a rule written in either
convention reaches both.

`redactAlways` applies the operator's paths plus the built-in list regardless of capture
mode, and covers the four fields `applyCapture` never saw. It is a separate function
because `applyCapture` answers a different question — *how much of the business payload may
we store* — and for `metadata-only` that answer is none, while SECURITY.md section 3 keeps
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
`ENCRYPTION_KEY` restores a database whose payloads cannot be read — so following the
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

Three jobs run the underlying open-source tools directly — `pnpm audit`, gitleaks, and
Trivy — so the result is real and the pipeline stays portable off GitLab. SAST is
deliberately absent: on a codebase this size, with type-aware lint and 423 tests, it
produces findings that get triaged once and ignored afterwards, which is worse than not
having it.

**All three block, and the baseline was cleared first.** Turning a scanner on red is how it
gets disabled — the same reasoning that already keeps `demo` and `e2e` manual, written down
in this repository as *"a red pipeline on every push for a suite needing the whole stack
trains people to ignore it."*

Clearing it meant fixing rather than allowlisting:

- Three high advisories reached through Next — `postcss` twice and `sharp` — are pinned
  forward with `overrides` in `pnpm-workspace.yaml`. An override removes the finding; an
  allowlist hides it. (The setting moved out of `package.json` in pnpm 10, and is silently
  ignored there.)
- Seventeen gitleaks findings were each checked by reading the matched line. All were
  fixtures or the proof strings in `WHAT_RUNNING_IT_FOUND.md`, which necessarily contains
  things shaped like credentials because it documents a defect that stored them. The
  allowances in `.gitleaks.toml` are written against the *value* rather than the path
  wherever possible, so they cannot hide whatever lands in that file next — and a planted
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
want to publish. Under that goal both objections fall away — a chart is not a *second*
install shape if it is the one actually used, and "no adopter would notice" stops being an
argument when there is no adopter to notice.

ADR-037 is what makes the chart small. The application holds no state: two Deployments, a
Job, a Secret, and a Service each. Before it, a chart would have had to carry a StatefulSet
and a volume claim, which is the worst kind of chart to own.

### Decision

`deploy/helm/flight-recorder` targets a **local single-node cluster** — kind, k3s, or Docker
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
so the Job could not see the Secret holding `DATABASE_URL` and — with `postgresql.enabled` —
had no database to migrate. Ordering is enforced by `/ready` returning `migrations_pending`
instead, which keeps new pods out of service until the schema is applied and lets the
previous pods keep serving through an upgrade.

The chart is verified by installing it into a throwaway kind cluster and reading pod status
and a live response — not by `helm lint` alone. A chart that templates cleanly and does not
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
mechanisms behind it — `private: true` in the package, absence from
`infrastructure/compose.published.yaml` and the Helm chart, and `.dockerignore` — and
`apps/demo` satisfied only the first two.

Looking at the actual image rather than the intent made the real problem bigger than the
demo. `apps/api/Dockerfile` ended its build stage with `COPY --from=build /app /app`, which
is every file in the workspace: 62 test files, ten source directories, the demo application
and the web application, all in the published API image. The comment above it explained the
choice — keeping the whole tree keeps the paths the documentation uses — but those paths are
`dist` paths, so the reason justified far less than it was taking.

None of it is reachable. The entrypoint is `apps/api/dist/server.js`, and the workspace
`exports` maps name `./src/index.ts` only under the `development` condition, which requires
an explicit `--conditions=development` that nothing in the image passes.

Unreachable is not the same as harmless. Test fixtures in this repository contain
credential-shaped strings — `admin-token-for-tests-…`, a 64-character hex key — that exist
precisely because they look real enough to exercise the parsers. A secret scanner reading a
published image cannot tell a fixture from a leak, and neither can a person.

Trivy was already scanning these images and had nothing to say about any of it. It answers
"which packages have CVEs", not "what is in here that should not be".

### Decision

The build stage deletes what the runtime never executes — `apps/demo`, `apps/web`, every
`src` directory outside `node_modules`, every `*.test.ts` and `*.spec.ts`, and the
`tsconfig` files — after the production install and before the runtime stage copies it.

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
- Size was never the point and barely moved — 34.9M to 33.6M, since `node_modules` dominates
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
