# Roadmap

Direction, not commitments. What is actually built is in
[CHANGELOG.md](../CHANGELOG.md); why it is built that way is in
[DECISIONS.md](DECISIONS.md).

Every item has to preserve the free, self-hosted, private-by-default experience
in [Product Principles](PRODUCT_PRINCIPLES.md). Paid hosting or enterprise
conveniences may come later; the record-first debugging workflow stays in the
community edition.

---

## Where this actually is

The core loop works end to end and is tested: instrument a service, search a
record, read its timeline across services, see the field that changed, replay
the step against a development destination. The 0.1.0 preview is published:
`@wayscribe/node@0.1.0` and signed multi-platform API and web images. On
its protected tag, the release pipeline passed every required job.
Counted on 2026-09-20: 3,422 unit tests, 979 integration tests on each of PostgreSQL 15,
17 and 18, 796 SDK tests on each of Node 22.12.0 and 24, two 71-test browser
runs, and 7 release acceptance tests. The
[release verification](reviews/2026-09-20-release-verification.md) records the
public provenance, image and SBOM digests, and installation exercise.

The released install uses tagged Compose files and public images without a
checkout. The clone-based demo remains the source and contributor path.

---

## Next

Presenting the work, and closing what the last review opened.

- ~~**Screenshots in the README.**~~ **Built:** the README opens with the diff
  view, and `docs/images` holds search, timeline, diff, replay and the Journeys
  page, regenerated with `pnpm screenshots`, which seeds the journeys it needs
  through the demo's own webhook.
- ~~**Surface the decision log.**~~ **Built:** the README's first section after
  the screenshot points at [the decision log](DECISIONS.md), and its ADR count is
  checked by `tests/docs-truth.test.ts`.
- ~~**Write down what went wrong.**~~ **Built:**
  [What running it found](WHAT_RUNNING_IT_FOUND.md).
- ~~**A CLI**~~ **Built:** `packages/cli`: `search`, `journey`, `event --diff`,
  `projects`, over HTTP, with `--json` on everything (`pnpm cli`).
- **`docker compose up` from a clean clone, verified in CI.** The `demo` job,
  and `release-verify` on a release tag, copy `.env.example` to `.env`, build
  and boot the demo stack from the pipeline's checkout, wait for the API,
  demo source and web health endpoints, and run `pnpm test:demo`. This covers
  the configuration step that found a web container listening on the wrong
  port on 2026-09-15. Timing a first installation on a new user's machine
  remains a separate release check.
- **A contract somebody else can build against.** JSON Schema generated from the
  Zod schemas and checked for drift, `docs/INGESTION_CONTRACT.md` for the routes,
  limits, refusals and idempotency, `docs/SDK_SPEC.md` for what a recorder in any
  language must do, a dry run that validates a batch without storing it, and
  conformance fixtures under `packages/protocol/conformance/` that any
  implementation can run through the dry run (ADR-049). The fixtures are what
  prove the protocol is genuinely language-neutral rather than TypeScript-shaped.
  The propagation specification and its test vectors are not part of this yet:
  every requirement in them is a header name, a queue attribute name or an
  environment variable name, and all of those carried the product name until the
  rename to Wayscribe (ADR-057). With the names settled, it can be written.
- **OpenTelemetry log ingest.** `POST /v1/logs` accepting OTLP
  over HTTP, so a team already exporting logs can map them onto journey events
  without adding a recorder. gRPC is out of scope: it is a second transport and a
  second dependency for a path that is already optional. The Node SDK stays the
  recommended path for Node, because the input and output pairing the diff needs
  is something a recorder knows and a log line does not. It waited for the
  rename because the attribute names it reads carry the product prefix, which is
  now `wayscribe` (ADR-057).

- **A Python SDK, after the first release.** Python is where most of the
  pipelines, workers and integrations this tool is for are written, so it is the
  next recorder rather than one that waits for a request. It is built against
  `docs/SDK_SPEC.md`, checked with the conformance fixtures through the dry run,
  and dogfooded by adding a Python service to the Leadline project. ADR-049 said
  a second SDK waits for a team that needs one; that was written before the
  contract, the fixtures and the dry run existed, and they are what make a second
  SDK a normal piece of work instead of a second product. ADR-059 supersedes that
  condition and sets the order: Python, then OpenTelemetry log ingest, then
  further languages by what pilot teams ask for.

- ~~**Per-record timing and context, before the first release.**~~ **Built:**
  Wayscribe presents bounded evidence about one record; aggregate latency and
  throughput stay with Prometheus, Grafana or an OpenTelemetry backend. The
  implementation was exercised by the Leadline dogfood project with actual
  intake and worker processes, dedicated Redis, retries, a controlled slow
  target and the real Wayscribe API. Run `dogfood-a4d2cc02` passed all six
  scenarios; the scoped Task 4 re-review accepted the delivery-aware manifest
  comparison at Leadline `f65d3e0`. The full evidence and remaining release
  limits are in the
  [release-readiness review](reviews/2026-09-18-round-3-and-release-readiness.md).
  - ~~**Gaps on the timeline**~~ **Built:** consecutive operation-start gaps,
    explicit queue waits, overlap, and the cross-host clock qualification.
    Filtering retains original loaded neighbors rather than inventing
    adjacency.
  - ~~**Journey duration and stuck journeys**~~ **Built:** the recorded span
    appears on journey detail and the Journeys table; active inactivity uses a
    frozen cutoff preserved through detail and back navigation.
  - ~~**Retry detail**~~ **Built:** explicitly grouped attempts show outcomes,
    observed delay and which attempt succeeded, with partial-history scope
    stated.
  - ~~**A small standard metadata vocabulary**~~ **Built:** ADR-064 and the
    event/SDK contracts define queue name and wait basis, delivery count,
    attempt and retry group, target host, HTTP status and requested retry
    delay. Unknown evidence is omitted and a measured zero remains zero.
    Initial-enqueue wait belongs only to broker delivery 1; a later delivery
    needs its own explicit ready instant. Leadline's independent comparator
    validates those rules without using the SDK as its oracle.
  - **The deployment on each event. Built:** each timeline row shows its
    recorded version and commit, when present (F-043), and the event detail
    lists the full deployment with custom and runtime metadata (F-044).
  - ~~**Duration filters**~~ **Built:** the Journeys page filters by strict
    recorded-span and step-duration thresholds and active inactivity while
    preserving scope, pagination and no-JavaScript navigation.

### Known open, and honest about it

Neither of these carries a DebtWatch declaration yet, so neither has a date;
`npx debtwatch list` shows the three shortcuts that do, and `debt` in the
pipeline checks that each declaration is still valid.

- **`audit_events` is never swept.** It grows by one row per deletion, replay,
  and key issued or revoked, ten actions in all (`docs/SECURITY.md` section
  13). That is small while nothing else is audited, and a problem the moment
  reads are.
- **The login limiter is per-process,** so N web replicas means N times the
  allowed attempts.

---

## After the first public release

Release 0.1.0 made the distribution path visible. The operational follow-up is:

- ~~publish `@wayscribe/node` and signed images for both architectures~~
  **Built:** 0.1.0 is public, and `compose.published.yaml` requires
  `WAYSCRIBE_VERSION` rather than falling back to `latest`. Signatures and SBOM
  attestations verified for linux/amd64 and linux/arm64. The public runtime
  exercise used arm64; running the amd64 images remains a separate platform
  check.
- ~~a private-registry rehearsal of the documented install before the public
  tag~~ **Done:** followed by an automated install from public artifacts after
  publication.
- ~~a `doctor` preflight~~ **Built:** `pnpm run doctor`, or `doctor` in the API
  image: migrations applied, secrets not the published defaults, an issued key
  that actually authenticates (`OPERATIONS.md` §12)
- ~~the SDK saying something on its first successful flush~~ **Built:**
  `logDiagnostics: true` prints `delivered_first` once the server stores a batch
- a read-only principal: journeys and timelines without payloads, which is the
  cheap answer to "management should see this too" and much less work than
  accounts
- admin endpoints (`POST /v1/projects`, key lifecycle) so the CLI's admin half
  works remotely rather than only inside the container
- rate limiting and quotas on ingestion. (~~a `statement_timeout`~~ **Built:**
  `DATABASE_STATEMENT_TIMEOUT_MS`, `OPERATIONS.md` §13. Admin token and API key
  authentication failures are throttled, which is not rate limiting.)

---

## Later

- Fastify, Express, and fetch/Axios adapters for the stacks pilot teams actually
  run, as separate packages over the SDK's public API (ADR-049)
- SDKs in languages beyond Python, by what pilot teams ask for (ADR-049,
  ADR-059), built against `docs/SDK_SPEC.md` and checked with the conformance
  fixtures
- S3-compatible payload storage, backup and restore tooling
- an audit-log interface, retention and legal-hold controls
- high-availability deployment

---

## Not doing

Everything on the do-not-add list in `AGENTS.md` stays out. The ones worth
restating, with reasons:

- ~~**Kubernetes and a Helm chart.**~~ **Built**: see `deploy/helm` and ADR-042.
  The reasoning against it held while adoption was the goal: it would point at
  images nobody had published, and a second install shape doubles the surface
  where a quick start can dead-end. Neither survives the owner being the primary
  user and deploying to a local cluster. Managed clusters are still untested and
  the chart says so.
- **A hosted offering.** Self-hosting is the reason anybody would put customer
  payloads in this. Running it centrally makes us custodian of exactly the data
  the design refuses to centralise.
- **User accounts, OIDC, team roles.** A single admin token plus per-project API
  keys covers the real access patterns, and identity is the largest thing that
  could be built that nobody evaluating this would notice.
- **Bundled PostgreSQL as the default.** ADR-037 inverted this deliberately. The
  bundle stays an evaluation overlay.
- **Making `full-payload` easy to enable.** It keeps requiring both a
  process-level variable and an explicit environment setting, because its
  failure mode is silent and permanent.
- **A second storage engine.** The search latency at 120k journeys was a query
  and indexing problem, and it was solved as one: at a million journeys in
  PostgreSQL, search for a value matching a few journeys is under a
  millisecond, and one matching 20,000 takes 64 ms (measured on 2026-09-15;
  `OPERATIONS.md` section 10, *Indexes*).
- **AI features.** A future bring-your-own-key module may be added, disabled by
  default. Nothing will be sent anywhere without being asked for.

---

## What the old version of this file got wrong

Kept as a note on how planning documents drift.

- **"External PostgreSQL" sat under V1 as a possibility.** It shipped as ADR-037,
  and it is now the documented default.
- **The V0 scope listed "self-hosted Docker Compose deployment" as the goal**
  while the quick start it described could not create a project, so a new
  installation had nothing to instrument.
- **Four planning documents** (`PRODUCT_SPEC.md`, `IMPLEMENTATION_PLAN.md`,
  `ARCHITECTURE.md`, and this one) predate every ADR and describe an install
  premise that no longer holds. Reconciling four vocabularies costs more than
  retiring three of them, which is not done yet because `AGENTS.md` ranks
  `PRODUCT_PRINCIPLES.md` second in the source-of-truth order and deleting it
  means editing that first.
