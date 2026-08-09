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
