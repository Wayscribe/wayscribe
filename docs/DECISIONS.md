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

**Status:** Accepted

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
  a database with other things.
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
- `SearchScope` is gone rather than aliased. A deprecated name in a pre-1.0 internal
  package is cruft that outlives the reason for it.

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
  carriers of credentials, so this is recorded as unsolved rather than covered.
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


## ADR-047: Metrics on their own port, in a format written here

**Status:** Accepted

Numbered 047 because ADR-046 is being taken by a branch in progress at the time
of writing; the two land in either order and the log keeps both numbers.

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
