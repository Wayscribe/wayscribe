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
the step against a development destination. 503 unit tests, 139 integration
tests against a real PostgreSQL, 7 acceptance tests against a running stack.

Nothing is published. There is no npm package and no image in any registry, so
every install today is `git clone` and `docker compose up`. That is deliberate
and not currently a priority — see *If this goes public*.

---

## Next

Presenting the work, and closing what the last review opened.

- **Screenshots in the README.** The product's whole value is visual — a
  timeline across four services with the changed field named — and the README
  has none. Highest return of anything on this page.
- **Surface the decision log.** 44 ADRs of real tradeoff reasoning are linked
  from the bottom of the README as a docs bullet. That is the most interesting
  artifact in the repository and it reads as an afterthought.
- **Write down what went wrong.** Dogfooding this tool against a real ORM
  surfaced four defects in a day, including a plaintext credential leak in its
  own redaction. That story lives in `git log`. It belongs in a page somebody
  can read.
- **A CLI** — `search`, `journey`, `event --diff`, `projects`, over HTTP, with
  `--json` on everything. It is the ops-shaped answer for teams who will not
  expose an admin console, and unlike the web interface it is testable in CI.
- **`docker compose up` from a clean clone, verified in CI.** Every onboarding
  defect on the record was found by a person running the README literally. That
  is a job, not a habit.

### Known open, and honest about it

Each of these now carries a DebtWatch declaration where the shortcut lives, with
an owner and a date — `npx debtwatch list`. This section says what; the
declaration says until when, and `debt` in the pipeline says whether the
declaration is still valid.

- **Free text in errors is not redacted.** Path redaction matches key names, so
  a credential pasted inside `error.message` or `error.stack` survives it.
  `SECURITY.md` §2 names stack traces as carriers of credentials. Needs either
  value scanning, which is false-positive-prone, or a decision not to store
  stacks (ADR-039).
- **`audit_events` is never swept.** Harmless while it holds four call sites;
  a problem the moment reads are audited.
- **The login limiter is per-process,** so N web replicas means N times the
  allowed attempts.

---

## If this goes public

Deferred on purpose. None of it is visible to somebody evaluating the code, and
all of it is cheap to add once there is a reason.

- publish `@flight-recorder/node` and the images, pinned off `:latest`, with the
  pushed tag booted on both architectures before it moves
- a private-registry rehearsal of the documented install before the public tag
- a `doctor` preflight — migrations applied, secrets not the published defaults,
  an issued key that actually authenticates
- the SDK saying something on its first successful flush, so a working install
  is distinguishable from a broken one
- a read-only principal: journeys and timelines without payloads, which is the
  cheap answer to "management should see this too" and much less work than
  accounts
- admin endpoints (`POST /v1/projects`, key lifecycle) so the CLI's admin half
  works remotely rather than only inside the container
- rate limiting, quotas, and a `statement_timeout`

---

## Later

- Fastify, Express, and fetch/Axios adapters
- a Go or Python SDK — which would also prove the protocol is genuinely
  language-neutral rather than TypeScript-shaped
- S3-compatible payload storage, backup and restore tooling
- an audit-log interface, retention and legal-hold controls
- high-availability deployment

---

## Not doing

Everything on the do-not-add list in `AGENTS.md` stays out. The ones worth
restating, with reasons:

- ~~**Kubernetes and a Helm chart.**~~ **Built** — see `deploy/helm` and ADR-042.
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
  millisecond, and one matching 20,000 takes 64 ms (measurements on
  `searchJourneys`).
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
- **Four planning documents** — `PRODUCT_SPEC.md`, `IMPLEMENTATION_PLAN.md`,
  `ARCHITECTURE.md`, and this one — predate every ADR and describe an install
  premise that no longer holds. Reconciling four vocabularies costs more than
  retiring three of them, which is not done yet because `AGENTS.md` ranks
  `PRODUCT_PRINCIPLES.md` second in the source-of-truth order and deleting it
  means editing that first.
