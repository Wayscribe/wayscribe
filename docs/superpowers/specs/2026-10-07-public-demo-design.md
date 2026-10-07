# Public demo at demo.wayscribe.dev: design

**Date:** 2026-10-07
**Status:** Approved in discussion, awaiting written-spec review
**Follow-up spec:** SSO (separate, after this ships)

## Goal

Anyone with a link can open a live Wayscribe instance, with no login and no install,
and within a minute search an entity, walk its journey, and read the field diff that
shows where a value was lost. It exists to sell and demo quickly to larger companies and
government agencies, while the product stays open source and self-hosted.

Success means: a prospect on a call, or reading an email, clicks one link and reaches the
phone-number diff without help.

## Decisions made

| Question | Decision |
| --- | --- |
| What can a visitor do | Explore only: search, timelines, event detail, diffs. No replay, delete, or ingestion. |
| Where it runs | One small VM (Hetzner CX22, 2 vCPU, 4 GB) running the published compose files. Chosen over DigitalOcean Kubernetes for cost; the managed-cluster test of the Helm chart stays open on the roadmap. |
| How visitors get in | A new read-only API principal plus a web setting that signs visitors in with it. Enforced by the API, not by hiding buttons. |
| What data | The existing lost-phone scenario with variations, about 300 backfilled journeys, live runs about every 60 s, and one pinned failed journey for `+1 555 0100`. |
| Which version, how updated | The latest release. A manual GitLab job on protected `v*` tags deploys it. |

## Relation to recorded decisions

`AGENTS.md` lists hosted SaaS infrastructure as not to be added, and `docs/ROADMAP.md`
("Not doing") rules out a hosted offering because the project must never be custodian of
customer payloads. The public demo holds only generated data and accepts none from
visitors, so that reasoning stands. A new ADR records this boundary: the demo never
ingests anything a visitor supplies and never holds customer data.

The reader principal is a separate ADR. It is the roadmap's "read-only principal" item
("After the first public release"), with one difference: the roadmap version hid payloads;
this one may read them, because the demo's value is the diff. A payload-free viewer is left
for the SSO roles work.

## Components

### 1. Reader principal (API)

- New setting `READ_TOKEN`, at least 32 characters, with `READ_TOKEN_FILE` support and a
  published-default check in `insecure-defaults.ts`, matching `ADMIN_TOKEN`.
- ADR-029 resolves a request to an API key or the admin token. This adds a third
  principal, **reader**, resolved from `READ_TOKEN`. A reader's scope is the same as
  admin's for reads: `{ projectId, environmentId? }` across all environments of one
  project.
- Authorization is an **allowlist**. A reader may call only the read routes: `GET
  /v1/projects`, `GET /v1/search`, `GET /v1/journeys/:id`, `GET
  /v1/journeys/:id/events`, `GET /v1/events/:id`, and any other existing `GET` read
  route the implementation plan inventories. Every other route refuses a reader with
  403, including ingestion, OTLP, replay, deletion, and key lifecycle, and so does any
  route added later unless it is explicitly allowlisted.
- A reader's request is never written to `audit_events` as an admin action. No reads are
  audited today, and this does not change that.
- The read token never travels to the browser. The web app holds it server-side.

### 2. Anonymous read-only mode (web)

- New setting `WEB_ANONYMOUS_READ_ONLY` (default `false`).
- When `true`: the web app signs every visitor in as a reader without a login page, and
  holds only the read token; it does not need `ADMIN_TOKEN`. The HKDF session key
  today derives from `ADMIN_TOKEN`; in this mode it derives from `READ_TOKEN` with a
  distinct HKDF info label, so a session from one mode never verifies in the other.
- The web app refuses to start when the mode is on and `READ_TOKEN` is absent.
- A persistent banner: "Public demo. Read-only, sample data." with a link to the pilot
  call to action (`pilots@wayscribe.dev`) and to wayscribe.dev.
- Replay and delete controls are hidden **by principal**, not by the setting, so a
  reader outside anonymous mode sees the same interface.
- When the mode is off, behavior is unchanged: the login page and admin token work as
  today.
- `doctor` prints a prominent warning whenever the mode is on.

### 3. Continuous demo traffic (`apps/demo`)

- A loop mode for the `source` entry point: one new generated customer about every 60 s.
  About 20% of runs take the 422, retry, dead-letter path; the rest succeed.
- A backfill step after bootstrap sends about 300 journeys with timestamps spread over the
  past **5 days**. `DEFAULT_RETENTION_DAYS` is 7, so backfilled history survives until the
  next nightly reset. First task of the plan: confirm the API stores events with past
  timestamps and orders the timeline by them.
- One pinned failed journey for `+1 555 0100`, recreated on every reset, with the phone
  diff. The web landing hint suggests this search.
- Generated identifiers follow the rule in the synthetic-data lesson: deduplicate on the
  normalized form the pipeline uses, so the backfill cannot create aliases that collide.

### 4. Demo deployment (`deploy/demo/`)

Kept out of `deploy/helm` and out of the product compose files, so nothing a customer
installs contains demo pieces.

- A compose overlay on `compose.published.yaml` plus `compose.demo.yaml` adding Caddy
  (automatic TLS for `demo.wayscribe.dev`) and setting `WEB_ANONYMOUS_READ_ONLY=true`.
- Only the web app is reachable through Caddy. The API, PostgreSQL, and ElasticMQ publish
  no host ports.
- Caddy applies a per-IP request rate limit on the web routes. PostgreSQL's existing
  `DATABASE_STATEMENT_TIMEOUT_MS` stays set.
- `robots.txt` disallows everything and responses carry `X-Robots-Tag: noindex`.
- Every service has `restart: unless-stopped`.
- Host: Hetzner CX22, firewall open on 22 (keys only), 80, and 443.
- Secrets (`ADMIN_TOKEN` for CLI use on the box, `READ_TOKEN`, `ENCRYPTION_KEY`) are
  generated on the VM at setup and stored in a root-only env file. They are never
  committed and are separate from CI variables.
- A systemd timer at 04:00 UTC resets the demo: `down -v`, `up -d`, bootstrap, backfill,
  pinned journey. A weekly timer runs `docker image prune`.

### 5. Deploy job (`.gitlab-ci.yml`)

- `deploy-demo`: manual, runs only on protected `v*` tags. SSH key in a protected, masked
  variable; the key on the box is restricted to the deploy command.
- Steps: write `WAYSCRIBE_VERSION` into the box's env file, pull, verify image signatures
  with cosign, `up -d`, then run the smoke check (below). The job fails if the check fails.
- Rollback is the same job run on the previous tag.
- Following the untested-release-paths lesson, the job is played on every release, so it
  stays exercised.

### 6. Smoke check (shared)

One script used by the deploy job, the uptime monitor, and CI: load the home page through
Caddy, search `+1 555 0100` through the web app, and confirm the pinned failed journey and
its phone diff come back.

## Failure handling

- Uptime: an external check runs the smoke check every 5 minutes and alerts through ntfy.
- A failed nightly reset alerts through ntfy and retries every 30 minutes, up to three
  times, alerting on each failure. A reset that fails all retries can leave the demo empty
  until fixed by hand; at 04:00 UTC with retries, that is an accepted risk for a demo,
  cheaper than keeping two stacks.
- Disk stays flat: volumes are wiped nightly, images pruned weekly.

## Testing

- **Reader allowlist as a property:** enumerate every route Fastify registers and call each
  as a reader. Only allowlisted routes may succeed; every other route must return 403. A
  new route is refused unless allowlisted, and the test proves it.
- **Reader integration:** against a real database, reads succeed; ingestion, OTLP, replay,
  delete, and key lifecycle are refused and change no rows, including `audit_events`.
- **Web:** anonymous mode signs in as reader and shows the banner; replay and delete are
  hidden for a reader in both modes; startup fails without `READ_TOKEN`; with the mode off
  the login flow is unchanged.
- **doctor:** warns when anonymous mode is on.
- **Demo overlay in CI:** bring up the overlay with a local Caddy, run the smoke check, and
  assert the API port is not reachable from outside the compose network.
- **Backfill:** past timestamps are stored and ordered correctly, and retention does not
  remove the backfilled history before the next reset.
- Run the full unit suite for any doc wording change, because `tests/site.test.ts` pins
  site claims.

## Links and docs

- wayscribe.dev: a "Live demo" button next to the video.
- README: one line linking the demo.
- `docs/DEMO_HOSTING.md`: VM setup, DNS, secrets generation, reset, deploy, rebuild from
  nothing.
- Two ADRs (next numbers after ADR-068): the public demo boundary, and the reader
  principal.
- ROADMAP: mark the read-only principal item as built (with the payload difference noted).

## Jorge's manual steps

- Create the Hetzner account and the CX22 VM; add the SSH public key.
- Add the `demo.wayscribe.dev` DNS record in Cloudflare as DNS only (not proxied), so Caddy
  obtains and serves its own certificate.
- Add the protected CI variable for the deploy key.

## Out of scope

- Visitor-triggered journeys.
- A government-style second story (first candidate for the next addition).
- A Kubernetes demo on DigitalOcean.
- SSO (next spec).
- Visitor analytics beyond Caddy access logs.
