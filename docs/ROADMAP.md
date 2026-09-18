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
the step against a development destination. Counted on 2026-09-17: 2,416 unit
tests, 747 integration tests against a real PostgreSQL, 7 acceptance tests
against a running stack and 40 browser tests.

Nothing is published. There is no npm package and no image in any registry, so
every install today is `git clone` and `docker compose up`. That is deliberate
and not currently a priority; see *If this goes public*.

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
- **`docker compose up` from a clean clone, verified in CI.** Partly built: the
  `demo` job, and `release-verify` on a release tag, build and boot the demo stack
  from the pipeline's checkout and run `pnpm test:demo`. Neither follows the
  README literally, so neither copies `.env.example` to `.env`, which is how a
  literal run on 2026-09-15 found a web container listening on the wrong port.
  Every onboarding defect on the record was found by a person running the README
  literally. That is a job, not a habit.
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

- **Per-record timing and context, before the first release.**
  Wayscribe already stores when each step started and how long it took, so most
  of this is presentation. All of it answers a question about one record;
  aggregate latency and throughput across records stays with Prometheus,
  Grafana or an OpenTelemetry backend. Each item is exercised by the Leadline
  dogfood project (a local lead-sync system with queues, retries and rate
  limits) before it counts as done.
  - **Gaps on the timeline:** the idle time between consecutive steps, with
    queue waits (a `published` step followed by a `consumed` one) called out,
    and a note when the two steps ran on different hosts whose clocks may
    differ.
  - **Journey duration and stuck journeys:** total time from first to last
    event on the journey page and the Journeys table, and a filter for active
    journeys with no event for longer than a chosen threshold.
  - **Retry detail:** for each step, the attempts, the delay between them, and
    which attempt succeeded.
  - **A small standard metadata vocabulary:** agreed names for queue name,
    queue wait, delivery count, target host, HTTP status and rate-limit retry
    time, shown as labelled fields rather than anonymous metadata, and set by
    the SDK where it can (for example the queue wait when it extracts context
    from a job). Needs a decision on names, and belongs in the contract.
    Two things the names alone do not settle, both found by instrumenting a
    real queue (F-019, F-027):
    - **A value that could not be measured has to be marked, not defaulted.**
      A missing or corrupt queue field read as `0` is indistinguishable on the
      timeline from a job that truly waited no time, and reads with the same
      confidence. The vocabulary needs a way to say "not measured" for every
      field it defines, or a rule that an unmeasurable field is left off the
      event entirely. Two independent computations over the same job, one
      defaulting to `0` and one dropping the record, disagreed about exactly
      this case, and only comparing them showed it.
    - **A retried attempt's queue wait is not the same measurement.** BullMQ,
      for one, has no "ready again" timestamp: `processedOn` is when the
      current attempt began, so the gap before it includes that attempt's own
      backoff rather than time spent waiting for a worker. Either the
      vocabulary defines queue wait for a retried attempt explicitly, or it
      says plainly that the two are not comparable and the presentation keeps
      them apart.
  - **The deployment on each event:** the existing `deployment` field shown on
    the timeline, so a field that changed after a deploy is easy to spot. The
    event detail already lists it, with the custom and runtime metadata, as
    plain keys and values (F-044); this item puts it on the timeline's rows.
  - **Duration filters** on the Journeys page: journeys that took longer than
    a given time, and journeys with a step longer than a given time.

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

## If this goes public

Deferred on purpose. None of it is visible to somebody evaluating the code, and
all of it is cheap to add once there is a reason.

- publish `@wayscribe/node` and the images, with the pushed tag booted on
  both architectures before it moves. (`compose.published.yaml` already
  requires `WAYSCRIBE_VERSION` rather than falling back to `latest`.)
- a private-registry rehearsal of the documented install before the public tag
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
