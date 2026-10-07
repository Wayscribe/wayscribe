# Public demo at demo.wayscribe.dev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone with the link opens a live, read-only Wayscribe at demo.wayscribe.dev with no login and, within a minute, searches `+1 555 0100`, opens the failed journey and reads the phone-number diff.

**Architecture:** A third API principal, **reader**, resolved from a new `READ_TOKEN`, is enforced by a route allowlist in the API (a global `onRequest` guard, so a route added later is refused unless listed). A new web setting, `WEB_ANONYMOUS_READ_ONLY`, signs every visitor in as a reader with sessions keyed from `READ_TOKEN` under a distinct HKDF label; replay and delete are hidden by principal. The demo runs the published release on one Hetzner VM from `compose.published.yaml` plus a demo-only overlay in `deploy/demo/` (Caddy with TLS and a rate limit, generated history, a pinned failed journey, a 60 s traffic loop, a visit-notifier sidecar), reset nightly by a systemd timer and deployed by a manual GitLab job on protected `v*` tags.

**Tech Stack:** TypeScript on Node 24 (API, web, demo) and Node 22.12 (the visit notifier, run with `--experimental-strip-types`), Fastify 5, Next 15, Zod 4, Knex/PostgreSQL 17, Vitest, Docker Compose 2.24+ (`!reset`), Caddy 2.11.7 built with `caddy-ratelimit`, POSIX `sh`, systemd, GitLab CI, cosign v3.1.3.

**Spec:** `docs/superpowers/specs/2026-10-07-public-demo-design.md`

---

## Read this first (executor rules)

1. **Gates are hard stops.** Task 1 ends in a gate. Tasks 20 to 22 contain steps marked **JORGE ONLY**: you do not attempt them, you do not simulate them, you stop and report that the plan is waiting on Jorge, naming the step.
2. **Credentials.** Never print, `cat`, `head`, `grep` or otherwise read `.env`, `~/.npmrc`, `~/.pypirc`, `~/.docker/config.json`, `/etc/wayscribe-demo/env`, or any file a `*_FILE` setting names. To check whether a secret is set, test existence or length only (`test -s file`, `[ -n "${VAR:-}" ]`, `${#VAR}`).
3. **Shell.** Never write `cmd | grep -q pattern` under `pipefail`: `grep -q` exits at the first match, the writer gets SIGPIPE, and the pipeline reports a false failure. Capture the output into a variable, then match it with `case`. In any line that may be pasted into or sourced by zsh, brace every parameter that a colon follows (`"${var}:x"`, never `"$var:x"`, which zsh reads as a modifier).
4. **Docs pin claims.** Any change to wording in `README.md`, `docs/`, or `site/` requires the **full** unit suite (`pnpm test`), because `tests/site.test.ts`, `tests/docs-truth.test.ts` and `tests/docs-claims.test.ts` pin claims across files.
5. **New CI jobs pass twice.** A job's first green run has no cache, so failures that depend on cache state appear only on run 2. Every new CI job in this plan must pass on two consecutive pipelines before its task is done.
6. **Commits.** One commit per task unless the task says otherwise, Conventional Commit subject, body ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on a feature branch; do not merge to `main` without Jorge.
7. **Verify on a clean clone** before calling a task that touches build or CI done: `git clone` the branch to a temp dir, `pnpm install --frozen-lockfile`, run the task's commands there.

## Decisions this plan makes that the spec left open

- **The demo image is published.** Only `api` and `web` are published today; the demo services build from source. `publish-images` and its rehearsal gain `apps/demo/Dockerfile=$CI_REGISTRY_IMAGE/demo` so the VM pulls a signed demo image and cosign verifies all three (Task 18).
- **Backfill and the pinned journey are written straight to the ingestion API** with explicit past timestamps, using the same step names, services, payload shapes and the real `transformAccount` as the live services. The SDK stamps `now`, so it cannot write history (Task 10).
- **Every deploy is a reset.** `deploy.sh` runs the same `down -v` / `up -d` as the nightly reset. A rollback to an older tag would otherwise meet a database migrated forward by the newer one and fail at `migrate`. Demo data is regenerated anyway (Task 17).
- **Caddy's data and logs are host bind mounts**, not named volumes: `down -v` deletes named volumes, which would re-issue the TLS certificate nightly and hit Let's Encrypt's duplicate-certificate limit (5 a week), and would erase the 7-day access log (Task 16).
- **Caddy is built on the VM** from `caddy:2.11.7-builder-alpine` with `github.com/mholt/caddy-ratelimit@v0.1.1-0.20260612195517-5625512f24f6` (stock Caddy has no rate limiter). The visit notifier is a small image from `node:22.12.0-alpine`. Neither is a product image, so neither is signed; both are built from the checked-out release tag.
- **Caddy's log rolls by size and keeps 7 days** (`roll_size 50MiB`, `roll_keep_for 168h`). The spec says "rolls daily"; Caddy's file writer rolls by size, and the retention promise (7 days) is what matters.
- **Rate limit:** 300 requests per minute per client IP on everything except `/_next/static/*`. A journey page polls `/api/events` every 2 s (30 a minute) and a page load fetches about 20 assets, so 120 a minute would throttle an engaged visitor.
- **The uptime check runs on the VM** every 5 minutes (systemd timer), alerting through ntfy on state change (down, then recovered). A GitLab schedule every 5 minutes would spend about 140 CI minutes a day. An on-box check cannot see the box itself die, so an external HTTP monitor is listed as an optional Jorge step (J6).
- **In anonymous mode the web app refuses to start if `ADMIN_TOKEN` is set**, not merely "does not need it": a public web container must not hold the token that deletes. The overlay sets `ADMIN_TOKEN: ""`, which the web config reads as unset.
- **API tokens follow the mode; UI controls follow the principal.** The web app sends `READ_TOKEN` in anonymous mode and `ADMIN_TOKEN` otherwise. Sessions carry `principal: "admin" | "reader"`, and replay/delete links, pages and route handlers check the session's principal, so a reader session sees the same interface in either mode (today a reader session exists only in anonymous mode; SSO roles will add others).
- **A reader may list projects** (`GET /v1/projects`), like an admin, because the web app resolves the project from that list. In a multi-project install a reader therefore sees every project's name. ADR-070 records this.
- **Key lifecycle has no API route today** (it is CLI-only; ROADMAP "admin endpoints"). The allowlist property test registers stand-in key-lifecycle routes to prove they would be refused.
- **Doctor prints the anonymous-mode line only when the mode is on** (a WARN), so the existing doctor output is unchanged for everyone else.

## Spec points found wrong or impossible against the code

- ADR-065 item 6 approved a view-only capability that **cannot read payloads**. The reader reads payloads. ADR-070 must amend ADR-065 item 6 explicitly, not only the ROADMAP line (Task 19).
- `compose.published.yaml` publishes the API and web on `127.0.0.1`, and `compose.demo.yaml`/`compose.bundled.yaml` publish elasticmq, the demo services and PostgreSQL. "Publish no host ports" needs `ports: !reset []` on each (Compose 2.24+).
- `compose.demo.yaml` builds the demo image from source (`build:`), so "the published compose files" alone cannot run the demo services on the VM; hence the published demo image.

## File map

| File | Responsibility |
| --- | --- |
| `apps/api/src/routes/backfill-history.integration.test.ts` | Task 1 spike, kept as the regression test for past timestamps, ordering and retention |
| `packages/config/src/schema.ts`, `secret-files.ts`, `insecure-defaults.ts` | `READ_TOKEN`, `READ_TOKEN_FILE`, published-default check |
| `apps/api/src/principal.ts` | `reader` principal |
| `apps/api/src/reader-routes.ts` | The allowlist and the guard |
| `apps/api/src/app.ts`, `server.ts`, `routes/projects.ts`, `routes/queries.ts` | Wiring `readToken`, route inventory |
| `apps/api/src/reader-allowlist.test.ts` | Property test over every registered route |
| `apps/api/src/reader.integration.test.ts`, `reader-principal.integration.test.ts` | Reads succeed, writes refused and leave no rows |
| `packages/database/src/doctor.ts` | Anonymous-mode warning, `READ_TOKEN` scrubbed |
| `apps/web/src/lib/config.ts`, `session.ts`, `web-session.ts` (new) | Web settings, session principal and labels, session resolution |
| `apps/web/app/(authenticated)/layout.tsx`, `src/lib/current-project.ts`, `src/lib/request-session.ts`, `src/lib/api.ts`, `app/api/login/route.ts`, `app/login/page.tsx`, `app/api/select-project/route.ts` | Use the new session resolution |
| `apps/web/app/components/DemoBanner.tsx` (new), `EventDetail.tsx`, `JourneyTimeline.tsx`, journey/replay/delete pages and route handlers, `app/globals.css` | Banner, principal-based hiding |
| `apps/demo/src/history.ts` (new), `backfill.ts` (new), `source.ts` | Generated history, pinned journey, loop mode |
| `deploy/demo/smoke-check.sh`, `wait-for-smoke.sh` | Shared smoke check |
| `deploy/demo/visit-notifier/{notifier.ts,main.ts,Dockerfile}` | Visit notifications |
| `deploy/demo/caddy/{Dockerfile,Caddyfile}`, `deploy/demo/compose.yaml` | Edge and overlay |
| `deploy/demo/host/{lib.sh,reset.sh,deploy.sh,uptime.sh,setup.sh}`, `deploy/demo/host/systemd/*` | VM operations |
| `deploy/demo/ci/overlay-test.sh` | CI overlay test |
| `tests/visit-notifier.test.ts`, `tests/demo-overlay.test.ts` | Root unit tests for deploy/demo |
| `.gitlab-ci.yml` | demo image publish, `demo-overlay`, `deploy-demo` |
| `docs/DECISIONS.md` (ADR-069, ADR-070), `docs/DEMO_HOSTING.md` (new), `docs/ROADMAP.md`, `docs/API_SPEC.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`, `CHANGELOG.md`, `README.md`, `site/src/content/docs/index.mdx` | Docs |

---

### Task 1: Spike — past timestamps, ordering, retention (GATE)

The backfill only works if the API stores an event's own timestamp, orders a timeline by it, and the retention sweep (7 days by default, keyed on `journeys.last_event_at`) leaves 5-day-old history alone until the next nightly reset (at most 24 h later, so at most about 6 days old). Code reading says yes (`event-reads.ts` orders by `event_timestamp`; `retention.ts` deletes on `last_event_at < now() - retention_days`), but this proves it against PostgreSQL.

**Files:**
- Create: `apps/api/src/routes/backfill-history.integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import {
  createKnexConfig,
  insertReturningId,
  issueKey,
  sweepExpiredJourneys
} from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The public demo backfills about 300 journeys spread over the past five days
 * (docs/superpowers/specs/2026-10-07-public-demo-design.md). That only works
 * if an event keeps the time it was sent with, a timeline is ordered by that
 * time rather than by arrival, and retention at the default 7 days leaves the
 * history alone until the next nightly reset, when it is at most six days old.
 */
describe("backfilled history", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await insertReturningId(db, "projects", { name: "Demo", slug: "demo" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "demo",
        environmentName: "development",
        name: "demo",
        retentionDays: 7
      })
    ).apiKey;
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const envelope = (
    journeyId: string,
    id: string,
    at: Date,
    operation: string,
    name: string
  ): unknown => ({
    protocolVersion: "0.1",
    event: {
      id,
      journeyId,
      environment: "development",
      service: "demo-integration",
      entity: { type: "customer", id: `cust-${journeyId}` },
      operation,
      name,
      timestamp: at.toISOString()
    }
  });

  const ingest = async (events: unknown[]): Promise<void> => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { events } as object
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const results = response.json<{ data: { results: { status: string }[] } }>().data.results;
    expect(results.map((result) => result.status)).not.toContain("rejected");
  };

  const asAdmin = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

  /** A journey whose last event is `ageMs` old. */
  const journeyAged = async (journeyId: string, ageMs: number): Promise<void> => {
    const last = new Date(Date.now() - ageMs);
    await ingest([
      envelope(journeyId, `${journeyId}_1`, new Date(last.getTime() - 10_000), "received", "first"),
      envelope(journeyId, `${journeyId}_2`, last, "completed", "finish")
    ]);
  };

  it("stores past timestamps as sent and orders the timeline by them, not by arrival", async () => {
    const start = new Date(Date.now() - 5 * DAY_MS);
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    // Sent out of order on purpose: arrival order is third, first, second.
    await ingest([
      envelope("jrn_spike_order", "evt_spike_3", at(2), "failed", "third"),
      envelope("jrn_spike_order", "evt_spike_1", at(0), "received", "first"),
      envelope("jrn_spike_order", "evt_spike_2", at(1), "transformed", "second")
    ]);

    const events = await asAdmin("/v1/journeys/jrn_spike_order/events");
    expect(events.statusCode, events.body).toBe(200);
    const items = events.json<{ data: { items: { name: string; eventTimestamp: string }[] } }>()
      .data.items;
    expect(items.map((item) => item.name)).toEqual(["first", "second", "third"]);
    expect(items.map((item) => item.eventTimestamp)).toEqual([
      at(0).toISOString(),
      at(1).toISOString(),
      at(2).toISOString()
    ]);

    const journey = await asAdmin("/v1/journeys/jrn_spike_order");
    expect(journey.statusCode, journey.body).toBe(200);
    const data = journey.json<{ data: { startedAt: string; lastEventAt: string } }>().data;
    expect(data.startedAt).toBe(at(0).toISOString());
    expect(data.lastEventAt).toBe(at(2).toISOString());
  });

  it("keeps history up to six days old through a 7-day retention sweep, and removes older", async () => {
    // Backfilled at reset: up to 5 days old. Just before the next reset, 24 h
    // later: up to 6 days old. 6 days and an hour gives margin for a reset
    // that retries for 90 minutes.
    await journeyAged("jrn_spike_backfill_fresh", 5 * DAY_MS);
    await journeyAged("jrn_spike_backfill_before_reset", 6 * DAY_MS + 2 * HOUR_MS);
    // The control: the sweep does delete what is past retention, so the two
    // above surviving means something.
    await journeyAged("jrn_spike_expired", 8 * DAY_MS);

    const result = await sweepExpiredJourneys(db);
    expect(result.ran).toBe(true);

    expect((await asAdmin("/v1/journeys/jrn_spike_backfill_fresh")).statusCode).toBe(200);
    expect((await asAdmin("/v1/journeys/jrn_spike_backfill_before_reset")).statusCode).toBe(200);
    expect((await asAdmin("/v1/journeys/jrn_spike_expired")).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run --config vitest.integration.config.ts apps/api/src/routes/backfill-history.integration.test.ts`
Expected: 2 passed. (It needs a Docker daemon for Testcontainers.)

- [ ] **Step 3: GATE**

If any assertion fails because of the product's behavior (past timestamps rewritten or refused, timeline in arrival order, `startedAt` not the earliest, or the 6-day journey swept), **stop here and report to Jorge** with the failing assertion and its output. Do not change product code to make it pass and do not continue to Task 2: the backfill design depends on all three. If a failure is the test's own mistake (a wrong field name, a response shape), fix the test and rerun.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/backfill-history.integration.test.ts
git commit -m "test(api): backfilled history keeps its timestamps, order and retention

The public demo writes five days of generated history. This proves the API
stores the timestamp an event was sent with, orders a timeline by it, and
that a 7-day sweep keeps six-day-old journeys while removing eight-day-old.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `READ_TOKEN` in packages/config

**Files:**
- Modify: `packages/config/src/schema.ts` (after `ADMIN_TOKEN`, line 75; the trailing `.refine`, lines 107-113)
- Modify: `packages/config/src/secret-files.ts:17-21`
- Modify: `packages/config/src/insecure-defaults.ts` (the `for` list in `findInsecureDefaults`)
- Test: `packages/config/src/load.test.ts`, `secret-files.test.ts`, `insecure-defaults.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/config/src/load.test.ts`:

```ts
describe("READ_TOKEN", () => {
  const READ_TOKEN = "read-token-for-tests-000000000000";

  it("is optional, and absent means no reader principal exists", () => {
    expect(loadServerEnv(validEnv).READ_TOKEN).toBeUndefined();
  });

  it("reads blank as unset, as Compose passes an unset variable", () => {
    expect(loadServerEnv({ ...validEnv, READ_TOKEN: "  " }).READ_TOKEN).toBeUndefined();
  });

  it("trims, as ADMIN_TOKEN does", () => {
    expect(loadServerEnv({ ...validEnv, READ_TOKEN: ` ${READ_TOKEN}\n` }).READ_TOKEN).toBe(
      READ_TOKEN
    );
  });

  it("refuses one shorter than 32 characters", () => {
    expect(attempt({ ...validEnv, READ_TOKEN: "short" })).toContain("READ_TOKEN");
  });

  it("refuses the admin token reused as the read token", () => {
    expect(attempt({ ...validEnv, READ_TOKEN: validEnv.ADMIN_TOKEN })).toContain(
      "READ_TOKEN: must differ from ADMIN_TOKEN"
    );
  });
});
```

Append to `packages/config/src/secret-files.test.ts` (add the `node:fs`, `node:os`, `node:path` imports at the top if the file lacks them):

```ts
describe("READ_TOKEN_FILE", () => {
  it("reads READ_TOKEN from the file it names, trailing newline removed", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wayscribe-read-token-")), "read-token");
    writeFileSync(path, `${"r".repeat(40)}\n`, "utf8");
    expect(resolveSecretFiles({ READ_TOKEN_FILE: path })["READ_TOKEN"]).toBe("r".repeat(40));
  });

  it("is listed with the other settings that may come from a file", () => {
    expect(SECRET_FILE_SETTINGS).toContain("READ_TOKEN");
  });
});
```

Append to `packages/config/src/insecure-defaults.test.ts`:

```ts
describe("READ_TOKEN", () => {
  it("is flagged when it is a published default", () => {
    expect(
      findInsecureDefaults({ READ_TOKEN: "local-admin-token-000000000000000" }).map(
        (finding) => finding.variable
      )
    ).toEqual(["READ_TOKEN"]);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/config`
Expected: FAIL on every new case (`READ_TOKEN` is not in the schema, not a file setting, not checked).

- [ ] **Step 3: Implement**

In `packages/config/src/schema.ts`, directly after the `ADMIN_TOKEN: z.string().trim().min(32),` line:

```ts
    // The reader principal's token (ADR-070): search and read routes only.
    // Unset means no reader exists. Trimmed and at least 32 characters for the
    // reasons ADMIN_TOKEN is; blank is unset because Compose passes an unset
    // variable as an empty string.
    READ_TOKEN: z.preprocess(blankAsUnset, z.string().trim().min(32).optional()),
```

Replace the final `.refine(...)` call (the METRICS_PORT one) with the same refine followed by a second one:

```ts
  .refine((env) => env.METRICS_PORT === undefined || env.METRICS_PORT !== env.PORT, {
    path: ["METRICS_PORT"],
    message: "must differ from PORT. Metrics are served on their own port, never beside ingestion."
  })
  .refine((env) => env.READ_TOKEN === undefined || env.READ_TOKEN !== env.ADMIN_TOKEN, {
    path: ["READ_TOKEN"],
    message:
      "must differ from ADMIN_TOKEN. The read token may be held by a web app that serves the public; the admin token can delete."
  });
```

In `packages/config/src/secret-files.ts`:

```ts
export const SECRET_FILE_SETTINGS = [
  "ENCRYPTION_KEY",
  "ENCRYPTION_KEY_PREVIOUS",
  "ADMIN_TOKEN",
  "READ_TOKEN"
] as const;
```

In `packages/config/src/insecure-defaults.ts`, the loop list becomes:

```ts
  for (const variable of ["ENCRYPTION_KEY", "ENCRYPTION_KEY_PREVIOUS", "ADMIN_TOKEN", "READ_TOKEN"]) {
```

and update the comment above the loop: "It does not trim ADMIN_TOKEN or READ_TOKEN, but a published token with stray whitespace around it is no more secret, so that is flagged as well."

- [ ] **Step 4: Run the package tests, then the whole unit suite**

Run: `pnpm vitest run packages/config && pnpm test`
Expected: PASS. If an existing test asserts `SECRET_FILE_SETTINGS` equals the three-element list, update its expectation to the four-element list. `tests/security-review.test.ts` reads `serverEnvSchema.shape.ADMIN_TOKEN`; `.refine` keeps `.shape` in Zod 4, so it must still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config
git commit -m "feat(config): READ_TOKEN, readable from READ_TOKEN_FILE

Optional, at least 32 characters, never equal to ADMIN_TOKEN, and checked
against the published defaults like the other secrets (ADR-070).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The `reader` principal

**Files:**
- Modify: `apps/api/src/principal.ts` (whole file shown)
- Create: `apps/api/src/reader-principal.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseApiKeys } from "./auth.js";
import { principalEnvironmentId, principalProjectId, resolvePrincipal } from "./principal.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const READ_TOKEN = "read-token-for-tests-000000000000";

describe("the reader principal", () => {
  let container: TestDatabase;
  let db: Knex;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const resolve = (token: string, options: { readToken?: string; project?: string } = {}) =>
    resolvePrincipal({
      db,
      apiKeys: databaseApiKeys(db, keyring, (error) => {
        throw error;
      }),
      adminToken: ADMIN_TOKEN,
      readToken: "readToken" in options ? options.readToken : READ_TOKEN,
      authorizationHeader: `Bearer ${token}`,
      requestedProjectId: options.project
    });

  it("resolves the read token to a reader of the only project, across its environments", async () => {
    const result = await resolve(READ_TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.kind).toBe("reader");
    expect(principalProjectId(result.principal)).toBe(projectA);
    expect(principalEnvironmentId(result.principal)).toBeUndefined();
  });

  it("is not a reader when no read token is configured", async () => {
    const result = await resolve(READ_TOKEN, { readToken: undefined });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("answers a reader naming no project, among several, as an admin is answered", async () => {
    projectB = await insertReturningId(db, "projects", { name: "B", slug: "b" });
    expect(await resolve(READ_TOKEN)).toMatchObject({ ok: false, status: 404 });
    const named = await resolve(READ_TOKEN, { project: projectB });
    expect(named.ok && named.principal).toMatchObject({ kind: "reader", projectId: projectB });
  });

  it("still resolves the admin token to an admin", async () => {
    const result = await resolve(ADMIN_TOKEN, { project: projectA });
    expect(result.ok && result.principal.kind).toBe("admin");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run --config vitest.integration.config.ts apps/api/src/reader-principal.integration.test.ts`
Expected: FAIL (type error on `readToken`, or the read token resolves to 401).

- [ ] **Step 3: Implement — replace `apps/api/src/principal.ts` with**

```ts
import type { ApiKeyContext } from "@wayscribe/database";
import { timingSafeEqual } from "node:crypto";
import type { Knex } from "knex";
import { authenticatePresentedKey, bearerToken, type ApiKeyAuthenticator } from "./auth.js";

/**
 * Who is making a request.
 *
 * An API key identifies one project and one environment and may ingest. An admin
 * identifies the operator, reads across every environment of a named project, and
 * may not ingest — ingestion writes into a specific environment and an admin
 * token names none, so accepting it there would mean guessing (ADR-029).
 *
 * A reader reads exactly what an admin reads, payloads included, and may call
 * nothing else: `reader-routes.ts` refuses it every route outside an allowlist
 * before the route runs (ADR-070).
 */
export type Principal =
  | { kind: "apiKey"; context: ApiKeyContext }
  | { kind: "admin"; projectId: string }
  | { kind: "reader"; projectId: string };

export type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403 | 404; code: string; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNAUTHORIZED = {
  ok: false as const,
  status: 401 as const,
  code: "unauthorized",
  message: "A valid API key is required."
};

export interface ResolveOptions {
  db: Knex;
  apiKeys: ApiKeyAuthenticator;
  adminToken: string;
  /** READ_TOKEN, or undefined when this installation has no reader (ADR-070). */
  readToken?: string | undefined;
  authorizationHeader: string | undefined;
  /** Which project an admin or reader is asking about. Ignored for API keys. */
  requestedProjectId?: string | undefined;
}

/**
 * Resolve a bearer token to a principal.
 *
 * The admin token, then the read token, are checked first and in constant time.
 * Every failure returns the same message, so the response cannot be used to
 * distinguish an unknown key from a revoked one or a near-miss token.
 */
export async function resolvePrincipal(options: ResolveOptions): Promise<PrincipalResult> {
  const presented = bearerToken(options.authorizationHeader);
  if (presented === undefined) return UNAUTHORIZED;

  if (constantTimeEquals(presented, options.adminToken)) {
    return resolveNamedProject("admin", options.db, options.requestedProjectId);
  }
  if (options.readToken !== undefined && constantTimeEquals(presented, options.readToken)) {
    return resolveNamedProject("reader", options.db, options.requestedProjectId);
  }

  const context = await authenticatePresentedKey(presented, options.apiKeys);
  if (context === undefined) return UNAUTHORIZED;

  return { ok: true, principal: { kind: "apiKey", context } };
}

/**
 * An admin or reader names the project it wants. That is not an escalation — both
 * read any project by definition — but the project must exist. Returning an empty
 * result set instead would read as "this record has no events", which is a
 * different and far more misleading answer than "wrong project".
 */
async function resolveNamedProject(
  kind: "admin" | "reader",
  db: Knex,
  requestedProjectId: string | undefined
): Promise<PrincipalResult> {
  const projectId = requestedProjectId ?? (await onlyProjectId(db));

  if (projectId === undefined) {
    return {
      ok: false,
      status: 404,
      code: "project_not_found",
      message: "Specify a project: none was named and there is not exactly one."
    };
  }

  const exists: unknown = UUID_PATTERN.test(projectId)
    ? await db("projects").where({ id: projectId }).first("id")
    : undefined;
  if (exists === undefined) {
    return {
      ok: false,
      status: 404,
      code: "project_not_found",
      message: "Project not found."
    };
  }

  return { ok: true, principal: { kind, projectId } };
}

/**
 * The project an admin is asking about, or undefined when it cannot be settled.
 *
 * Exported for callers that authenticate the admin token themselves — replay
 * does, because it must refuse an API key outright rather than resolve one
 * (ADR-032), and `/v1/projects` does because it answers before a project can be
 * named.
 */
export async function resolveAdminProjectId(
  db: Knex,
  requestedProjectId: string | undefined
): Promise<string | undefined> {
  const projectId = requestedProjectId ?? (await onlyProjectId(db));
  // Not a uuid cannot be a project, and PostgreSQL would answer the lookup with
  // an error, a 500, rather than with nothing.
  if (projectId === undefined || !UUID_PATTERN.test(projectId)) return undefined;

  const exists: unknown = await db("projects").where({ id: projectId }).first("id");
  return exists === undefined ? undefined : projectId;
}

/** Convenience for the common single-project install: no selector needed. */
async function onlyProjectId(db: Knex): Promise<string | undefined> {
  const rows: unknown = await db("projects").select("id").limit(2);
  const projects = rows as { id: string }[];
  return projects.length === 1 ? projects[0]?.id : undefined;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The project a principal reads from. */
export function principalProjectId(principal: Principal): string {
  return principal.kind === "apiKey" ? principal.context.projectId : principal.projectId;
}

/**
 * The environment a principal is limited to, or undefined for project-wide.
 *
 * Undefined means every environment of that one project. It never means every
 * project — every read query still filters on project_id (ADR-029).
 */
export function principalEnvironmentId(principal: Principal): string | undefined {
  return principal.kind === "apiKey" ? principal.context.environmentId : undefined;
}
```

- [ ] **Step 4: Run the new test and the existing principal test**

Run: `pnpm vitest run --config vitest.integration.config.ts apps/api/src/reader-principal.integration.test.ts apps/api/src/principal.integration.test.ts && pnpm --filter @wayscribe/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/principal.ts apps/api/src/reader-principal.integration.test.ts
git commit -m "feat(api): a reader principal resolved from READ_TOKEN

Scoped as an admin is for reads: one named project, every environment.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reader allowlist guard, route inventory, wiring, and the property test

**Files:**
- Create: `apps/api/src/reader-routes.ts`
- Modify: `apps/api/src/app.ts` (module augmentation, `BuildAppOptions`, hooks, registrations)
- Modify: `apps/api/src/routes/projects.ts`, `apps/api/src/routes/queries.ts:31-52`, `apps/api/src/server.ts:25-36`
- Create: `apps/api/src/reader-allowlist.test.ts`

- [ ] **Step 1: Write the failing property test**

```ts
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { READER_ROUTES } from "./reader-routes.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const READ_TOKEN = "read-token-for-tests-000000000000";

/**
 * No query here reaches a database. A handler that tries meets a TypeError,
 * which the error handler answers with 500: never 403, so "not refused" stays
 * distinguishable from "refused by the guard".
 */
const db = {} as Knex;

const routeKey = (method: string, url: string): string =>
  `${method === "HEAD" ? "GET" : method} ${url}`;
const concrete = (url: string): string => url.replace(/:[A-Za-z]+/g, "x");

/**
 * The reader allowlist as a property (ADR-070): every route Fastify registers
 * is called with the read token, and only allowlisted ones get past the guard.
 * A route added later is in the inventory the moment it is registered, so it
 * is refused here until somebody allowlists it on purpose.
 */
describe("the reader allowlist", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      readToken: READ_TOKEN,
      logLevel: "silent",
      otlpLogsEnabled: true
    });
    // Stand-ins for routes that do not exist yet. Key lifecycle is CLI-only
    // today (ROADMAP, "admin endpoints"); when it gets routes, they must be
    // refused to a reader exactly as these are.
    app.post("/v1/projects/:projectId/keys", () => ({ data: "created" }));
    app.delete("/v1/keys/:keyId", () => ({ data: "revoked" }));
    app.get("/v1/added-later", () => ({ data: "read" }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const asReader = (method: string, url: string) =>
    app.inject({
      method: method as "GET",
      url: concrete(url),
      headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
      ...(method === "GET" || method === "HEAD" ? {} : { payload: "{}" })
    });

  const registered = (): Set<string> =>
    new Set(app.registeredRoutes.map((route) => routeKey(route.method, route.url)));

  it("sees every route the API registers, including the ones this suite names", () => {
    const keys = registered();
    for (const expected of [
      "POST /v1/events",
      "POST /v1/events/batch",
      "POST /v1/logs",
      "POST /v1/replay-destinations",
      "GET /v1/replay-destinations",
      "POST /v1/replays",
      "GET /v1/replays/:replayId",
      "DELETE /v1/journeys/:journeyId",
      "POST /v1/erasures",
      "DELETE /v1/replay-destinations/:destinationId",
      "POST /v1/projects/:projectId/keys",
      "DELETE /v1/keys/:keyId",
      "GET /v1/added-later"
    ]) {
      expect(keys, expected).toContain(expected);
    }
  });

  it("allowlists only routes that exist, so the list cannot rot", () => {
    const keys = registered();
    for (const allowed of READER_ROUTES) expect(keys, allowed).toContain(allowed);
  });

  it("refuses a reader with 403 on every registered route that is not allowlisted", async () => {
    const refused = app.registeredRoutes.filter(
      (route) => !READER_ROUTES.has(routeKey(route.method, route.url))
    );
    expect(refused.length).toBeGreaterThan(10);
    for (const route of refused) {
      const response = await asReader(route.method, route.url);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      if (route.method !== "HEAD") {
        expect(response.json<{ error: { code: string } }>().error.code).toBe("forbidden");
      }
    }
  });

  it("lets a reader past the guard on every allowlisted route", async () => {
    const allowed = app.registeredRoutes.filter((route) =>
      READER_ROUTES.has(routeKey(route.method, route.url))
    );
    expect(allowed.length).toBeGreaterThanOrEqual(READER_ROUTES.size);
    for (const route of allowed) {
      const response = await asReader(route.method, route.url);
      expect(response.statusCode, `${route.method} ${route.url}`).not.toBe(403);
    }
  });

  it("leaves the admin token to each route's own check", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/added-later",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
  });

  it("does nothing when no read token is configured", async () => {
    const plain = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    plain.get("/v1/added-later", () => ({ data: "read" }));
    await plain.ready();
    const response = await plain.inject({
      method: "GET",
      url: "/v1/added-later",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
    await plain.close();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run apps/api/src/reader-allowlist.test.ts`
Expected: FAIL (`reader-routes.js` missing, `readToken` and `registeredRoutes` unknown).

- [ ] **Step 3: Create `apps/api/src/reader-routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { errorBody } from "./admin.js";
import { bearerToken } from "./auth.js";
import { constantTimeEquals } from "./principal.js";

/**
 * Every route a reader may call, as `METHOD /pattern` (ADR-070).
 *
 * An allowlist, not a denylist: a route added later is refused to a reader
 * until it is added here on purpose. `reader-allowlist.test.ts` calls every
 * registered route with the read token and fails on any that gets past the
 * guard without being listed. A `HEAD` request is checked as its `GET`.
 *
 * `/health` and `/ready` take no credential at all; they are listed so that
 * presenting the read token to them is not a refusal.
 */
export const READER_ROUTES: ReadonlySet<string> = new Set([
  "GET /health",
  "GET /ready",
  "GET /v1/projects",
  "GET /v1/search",
  "GET /v1/journeys",
  "GET /v1/journeys/:journeyId",
  "GET /v1/journeys/:journeyId/events",
  "GET /v1/events/:eventId"
]);

/** Whether a reader may call the route a request matched. Unmatched requests reach the 404 handler. */
export function readerMayCall(method: string, routeUrl: string | undefined): boolean {
  if (routeUrl === undefined) return true;
  return READER_ROUTES.has(`${method === "HEAD" ? "GET" : method} ${routeUrl}`);
}

/**
 * Refuse the read token on every route outside the allowlist, before the route
 * runs. Root-level, so it covers routes registered inside plugins (OTLP) too,
 * and runs before their own hooks.
 *
 * 403 rather than the 401 an API key gets from an admin route: the token is
 * valid, and the operator who issued it should be able to tell "this token
 * cannot do that" from "this token is wrong". It is not an authentication
 * failure, so the throttle does not count it.
 */
export function registerReaderGuard(app: FastifyInstance, readToken: string | undefined): void {
  if (readToken === undefined) return;
  app.addHook("onRequest", async (request, reply) => {
    const presented = bearerToken(request.headers.authorization);
    if (presented === undefined || !constantTimeEquals(presented, readToken)) return;
    if (readerMayCall(request.method, request.routeOptions.url)) return;
    await reply
      .code(403)
      .send(
        errorBody(
          "forbidden",
          "The read-only token may call search and read routes only.",
          request.id
        )
      );
  });
}
```

- [ ] **Step 4: Wire it into `apps/api/src/app.ts`**

Add the import:

```ts
import { registerReaderGuard } from "./reader-routes.js";
```

Extend the module augmentation and add the route type just above it:

```ts
/** One registered route, as the router knows it. */
export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Knex;
    metrics: ApiMetrics;
    /** Every route registered on this app, plugins included, in registration order. */
    registeredRoutes: readonly RegisteredRoute[];
  }
}
```

In `BuildAppOptions`, after `adminToken: string;`:

```ts
  /** READ_TOKEN. Undefined means no reader principal exists (ADR-070). */
  readToken?: string | undefined;
```

Immediately after the `const app = Fastify({ ... });` statement and before the `onResponse` hook, add the inventory (it must be registered before any route):

```ts
  // Every route, as registered, so the reader allowlist can be tested as a
  // property over all of them rather than over a list typed a second time.
  // Added before any route: an onRoute hook sees only routes after it.
  const registeredRoutes: RegisteredRoute[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      registeredRoutes.push({ method, url: route.url });
    }
  });
  app.decorate("registeredRoutes", registeredRoutes as readonly RegisteredRoute[]);
```

Directly after `registerAuthThrottle(app, { ... });`:

```ts
  registerReaderGuard(app, options.readToken);
```

Change the two registrations:

```ts
  registerProjectRoutes(app, options.adminToken, options.readToken);
  registerQueryRoutes(app, options.keyring, options.adminToken, warnUnknownKey, options.readToken);
```

- [ ] **Step 5: Accept the reader in `apps/api/src/routes/projects.ts`**

Change the signature and the check (keep the file's other code):

```ts
export function registerProjectRoutes(
  app: FastifyInstance,
  adminToken: string,
  /** READ_TOKEN: a reader lists projects as an admin does, to choose one (ADR-070). */
  readToken?: string | undefined
): void {
  app.get("/v1/projects", async (request, reply) => {
    const presented = bearerToken(request.headers.authorization);
    const allowed =
      presented !== undefined &&
      (constantTimeEquals(presented, adminToken) ||
        (readToken !== undefined && constantTimeEquals(presented, readToken)));

    if (!allowed) {
      // Same 401 for a wrong token and for a valid API key: telling an
      // API-key holder that this endpoint exists but is not for them is a
      // disclosure with no benefit.
      request.recordAuthenticationFailure();
      return reply.code(401).send(unauthorized(request.id));
    }

    const projects = await listProjects(app.db);
    return reply.send({ data: { items: projects } });
  });
}
```

Update the doc comment's last paragraph to "Admin and reader only. An API key is scoped to a single project by construction…".

- [ ] **Step 6: Thread `readToken` through `apps/api/src/routes/queries.ts`**

```ts
export function registerQueryRoutes(
  app: FastifyInstance,
  keyring: Keyring,
  adminToken: string,
  /** Told the id of a key a read needed and the keyring lacks. */
  warnUnknownKey: (keyId: string) => void,
  /** READ_TOKEN, or undefined when there is no reader (ADR-070). */
  readToken?: string | undefined
): void {
```

and in `authenticate`, pass it:

```ts
    const auth = await resolvePrincipal({
      db: app.db,
      apiKeys,
      adminToken,
      readToken,
      authorizationHeader: request.headers.authorization,
      requestedProjectId:
        (request.headers["x-wayscribe-project-id"] as string | undefined) ?? undefined
    });
```

- [ ] **Step 7: Pass it from `apps/api/src/server.ts`**

In the `buildApp({ ... })` call, after `adminToken: env.ADMIN_TOKEN,`:

```ts
  readToken: env.READ_TOKEN,
```

- [ ] **Step 8: Run the tests and type checks**

Run: `pnpm vitest run apps/api && pnpm --filter @wayscribe/api typecheck`
Expected: PASS, including every pre-existing `app.test.ts` case.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): refuse the read token on every route outside an allowlist

A root onRequest guard answers 403 to the read token on any route not
listed in READER_ROUTES, so a route added later is refused until it is
allowlisted on purpose. The test enumerates every route Fastify registers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Reader integration — reads succeed, writes change no rows

**Files:**
- Create: `apps/api/src/reader.integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const READ_TOKEN = "read-token-for-tests-000000000000";
const JOURNEY = "jrn_reader_0001";
const ACCOUNT = "0018Z00005RDR01";
const PHONE = "+1 555 0100";

/** Every table a write could leave a row in, audit_events included. */
const TABLES = [
  "projects",
  "environments",
  "api_keys",
  "journeys",
  "entity_aliases",
  "journey_events",
  "replay_destinations",
  "replay_runs",
  "audit_events"
] as const;

describe("a reader against a real database", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await insertReturningId(db, "projects", { name: "Demo", slug: "demo" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "demo",
        environmentName: "development",
        name: "demo"
      })
    ).apiKey;
    app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      readToken: READ_TOKEN,
      logLevel: "silent",
      otlpLogsEnabled: true,
      replayAllowedHosts: ["localhost"]
    });

    const event = (id: string, operation: string, name: string, extra: object) => ({
      protocolVersion: "0.1",
      event: {
        id,
        journeyId: JOURNEY,
        environment: "development",
        service: "demo-integration",
        entity: { type: "customer", id: ACCOUNT },
        operation,
        name,
        timestamp: new Date().toISOString(),
        ...extra
      }
    });
    const ingested = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        events: [
          event("evt_reader_1", "transformed", "transform-salesforce-account", {
            input: { Id: ACCOUNT, Phone: PHONE },
            output: { externalId: ACCOUNT, phone: null }
          }),
          event("evt_reader_2", "identified", "identify", { aliases: { phone: PHONE } })
        ]
      }
    });
    expect(ingested.statusCode, ingested.body).toBeLessThan(300);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const asReader = (method: string, url: string, payload?: object) =>
    app.inject({
      method: method as "GET",
      url,
      headers: { authorization: `Bearer ${READ_TOKEN}` },
      ...(payload === undefined ? {} : { payload })
    });

  const counts = async (): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const table of TABLES) {
      const row: unknown = await db(table).count({ n: "*" }).first();
      result[table] = Number((row as { n: string }).n);
    }
    return result;
  };

  it("reads projects, search, the journey, its events and an event with its diff", async () => {
    expect((await asReader("GET", "/v1/projects")).statusCode).toBe(200);

    const search = await asReader("GET", `/v1/search?q=${encodeURIComponent(PHONE)}`);
    expect(search.statusCode, search.body).toBe(200);
    expect(
      search.json<{ data: { items: { journeyId: string }[] } }>().data.items.map((i) => i.journeyId)
    ).toContain(JOURNEY);

    expect((await asReader("GET", "/v1/journeys")).statusCode).toBe(200);
    expect((await asReader("GET", `/v1/journeys/${JOURNEY}`)).statusCode).toBe(200);
    expect((await asReader("GET", `/v1/journeys/${JOURNEY}/events`)).statusCode).toBe(200);

    const detail = await asReader("GET", "/v1/events/evt_reader_1");
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ data: { payloadDiff: unknown } }>().data.payloadDiff).not.toBeNull();
  });

  it("is refused ingestion, OTLP, replay, deletion and erasure, and they leave no row anywhere", async () => {
    const before = await counts();

    const attempts: [string, string, object | undefined][] = [
      ["POST", "/v1/events", { protocolVersion: "0.1", event: {} }],
      ["POST", "/v1/events/batch", { events: [] }],
      ["POST", "/v1/logs", { resourceLogs: [] }],
      ["POST", "/v1/replay-destinations", { name: "x", baseUrl: "http://localhost:9" }],
      ["GET", "/v1/replay-destinations", undefined],
      [
        "POST",
        "/v1/replays",
        { eventId: "evt_reader_1", destinationId: "x", path: "/", method: "POST" }
      ],
      ["GET", "/v1/replays/x", undefined],
      ["DELETE", `/v1/journeys/${JOURNEY}`, undefined],
      ["POST", "/v1/erasures", { value: PHONE }],
      ["DELETE", "/v1/replay-destinations/x", undefined]
    ];
    for (const [method, url, payload] of attempts) {
      const response = await asReader(method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }

    expect(await counts()).toEqual(before);
  });

  it("counts would have caught a write: an admin deletion adds an audit row", async () => {
    const before = await counts();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/journeys/${JOURNEY}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const after = await counts();
    expect(after["audit_events"]).toBeGreaterThan(before["audit_events"] ?? 0);
    expect(after["journeys"]).toBeLessThan(before["journeys"] ?? 0);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run --config vitest.integration.config.ts apps/api/src/reader.integration.test.ts`
Expected: PASS (Tasks 3 and 4 already implement the behavior). If the admin deletion returns a status other than 204, read `apps/api/src/routes/deletions.ts` for its success status and use that; the property under test is the audit row.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/reader.integration.test.ts
git commit -m "test(api): a reader reads payloads and diffs and can write nothing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `doctor` warns in anonymous read-only mode

**Files:**
- Modify: `packages/database/src/doctor.ts` (after line 203; `secretsIn`, lines 816-831; new exported function beside `statementTimeoutResult`)
- Test: `packages/database/src/doctor.test.ts`

- [ ] **Step 1: Write the failing tests** (append; add `anonymousReadOnlyResult` and `secretsIn` to the file's import from `./doctor.js`)

```ts
describe("anonymousReadOnlyResult", () => {
  it("warns, naming the setting and what it exposes, when the mode is on", () => {
    const result = anonymousReadOnlyResult({ WEB_ANONYMOUS_READ_ONLY: "true" });
    expect(result?.status).toBe("WARN");
    expect(result?.check).toBe("Anonymous read-only web");
    expect(result?.detail).toContain("WEB_ANONYMOUS_READ_ONLY is true");
    expect(result?.detail).toContain("every recorded payload");
  });

  it("says nothing when the mode is off or unset, so ordinary output is unchanged", () => {
    expect(anonymousReadOnlyResult({})).toBeNull();
    expect(anonymousReadOnlyResult({ WEB_ANONYMOUS_READ_ONLY: "false" })).toBeNull();
  });
});

describe("secretsIn", () => {
  it("scrubs READ_TOKEN from doctor's output like the other secrets", () => {
    const token = "read-token-for-tests-000000000000";
    expect(secretsIn({ READ_TOKEN: token }, undefined)).toContain(token);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run packages/database/src/doctor.test.ts`
Expected: FAIL (`anonymousReadOnlyResult` is not exported; `READ_TOKEN` not scrubbed).

- [ ] **Step 3: Implement**

Beside `statementTimeoutResult`, add:

```ts
/**
 * A warning while the web app would sign every visitor in as a reader.
 *
 * Only when the mode is on, so every other installation's output is unchanged.
 * Read from this environment, like the statement timeout: the demo overlay sets
 * it on the API container too, which is where doctor runs.
 */
export function anonymousReadOnlyResult(
  env: Record<string, string | undefined>
): CheckResult | null {
  if (env["WEB_ANONYMOUS_READ_ONLY"] !== "true") return null;
  return warn(
    "Anonymous read-only web",
    "WEB_ANONYMOUS_READ_ONLY is true here, so a web app started with this environment signs every visitor in as a reader with no login. Anyone who can reach it can search and read every recorded payload of the project.",
    "Turn it off unless this is a public demo holding only generated data (docs/DEMO_HOSTING.md): set WEB_ANONYMOUS_READ_ONLY=false or remove it."
  );
}
```

In `runDoctor`, directly after `results.push(statementTimeoutResult(env));`:

```ts
  const anonymous = anonymousReadOnlyResult(env);
  if (anonymous !== null) results.push(anonymous);
```

In `secretsIn`, add `env["READ_TOKEN"],` after `env["ADMIN_TOKEN"],`.

- [ ] **Step 4: Run**

Run: `pnpm vitest run packages/database/src/doctor.test.ts && pnpm --filter @wayscribe/database typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/doctor.ts packages/database/src/doctor.test.ts
git commit -m "feat(doctor): warn while the web app is in anonymous read-only mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web configuration — `READ_TOKEN`, `READ_TOKEN_FILE`, `WEB_ANONYMOUS_READ_ONLY`

**Files:**
- Modify: `apps/web/src/lib/config.ts` (whole file shown)
- Test: `apps/web/src/lib/config.test.ts`, `apps/web/src/lib/startup.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `config.test.ts`; import `apiToken`, `apiTokenName`, `sessionSigner` from `./config`)

```ts
describe("anonymous read-only mode", () => {
  const ADMIN = "admin-token-for-tests-00000000000000";
  const READ = "read-token-for-tests-000000000000000";
  const base = { API_URL: "http://api:8080" };

  it("requires READ_TOKEN", () => {
    expect(() => loadWebConfig({ ...base, WEB_ANONYMOUS_READ_ONLY: "true" })).toThrow(
      /READ_TOKEN: is required when WEB_ANONYMOUS_READ_ONLY is true/
    );
  });

  it("refuses to start holding ADMIN_TOKEN as well", () => {
    expect(() =>
      loadWebConfig({ ...base, WEB_ANONYMOUS_READ_ONLY: "true", READ_TOKEN: READ, ADMIN_TOKEN: ADMIN })
    ).toThrow(/ADMIN_TOKEN: must not be set when WEB_ANONYMOUS_READ_ONLY is true/);
  });

  it("reads a blank ADMIN_TOKEN as unset, which is how the demo overlay clears it", () => {
    const config = loadWebConfig({
      ...base,
      WEB_ANONYMOUS_READ_ONLY: "true",
      READ_TOKEN: READ,
      ADMIN_TOKEN: ""
    });
    expect(apiToken(config)).toBe(READ);
    expect(apiTokenName(config)).toBe("READ_TOKEN");
  });

  it("reads READ_TOKEN from READ_TOKEN_FILE", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wayscribe-web-read-")), "read-token");
    writeFileSync(path, `${READ}\n`, "utf8");
    const config = loadWebConfig({ ...base, WEB_ANONYMOUS_READ_ONLY: "true", READ_TOKEN_FILE: path });
    expect(config.READ_TOKEN).toBe(READ);
  });

  it("leaves the operator mode as it was: ADMIN_TOKEN is required and is what the API is sent", () => {
    expect(() => loadWebConfig(base)).toThrow(/ADMIN_TOKEN/);
    const config = loadWebConfig({ ...base, ADMIN_TOKEN: ADMIN });
    expect(config.WEB_ANONYMOUS_READ_ONLY).toBe(false);
    expect(apiToken(config)).toBe(ADMIN);
  });

  it("signs reader sessions with the read token under the reader label, admin sessions as before", () => {
    expect(sessionSigner({ WEB_ANONYMOUS_READ_ONLY: "true", READ_TOKEN: READ })).toEqual({
      secret: READ,
      label: "wayscribe/web-session-anonymous-reader",
      principal: "reader"
    });
    expect(sessionSigner({ ADMIN_TOKEN: ADMIN })).toEqual({
      secret: ADMIN,
      label: "flight-recorder/web-session",
      principal: "admin"
    });
    expect(sessionSigner({ WEB_ANONYMOUS_READ_ONLY: "true" })).toBeNull();
  });
});
```

(If `config.test.ts` lacks them, add `import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";`.)

Append to `startup.test.ts`:

```ts
it("refuses to start in anonymous read-only mode without READ_TOKEN", () => {
  const errors: string[] = [];
  const exits: number[] = [];
  const allowed = refuseToStartMisconfigured(
    { API_URL: "http://api:8080", WEB_ANONYMOUS_READ_ONLY: "true" },
    { exit: (code) => exits.push(code), error: (message) => errors.push(message) }
  );
  expect(allowed).toBe(false);
  expect(exits).toEqual([1]);
  expect(errors.join("\n")).toContain("READ_TOKEN");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/web/src/lib/config.test.ts apps/web/src/lib/startup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Replace `apps/web/src/lib/config.ts` with**

```ts
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { OPERATOR_SESSION_LABEL, READER_SESSION_LABEL, type WebPrincipal } from "./session";

/** The most a `*_FILE` setting may hold, as in packages/config. */
const MAX_SECRET_FILE_BYTES = 65_536;

/** The tokens this app may read from a file named by `<NAME>_FILE`. */
const TOKEN_SETTINGS = ["ADMIN_TOKEN", "READ_TOKEN"] as const;
type TokenSetting = (typeof TOKEN_SETTINGS)[number];

const blankAsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// Trimmed, exactly as packages/config trims them for the API. The two must
// agree byte for byte: the API compares the value against the Authorization
// header and this app derives its session signing key from it, so a token
// file with a leading space or a byte-order mark would otherwise leave a token
// nobody can type at the login form, with nothing said about why. Blank is
// unset: Compose passes an unset variable as "", and the demo overlay clears
// ADMIN_TOKEN that way.
const token = z.preprocess(blankAsUnset, z.string().trim().min(32).optional());

const schema = z
  .object({
    ADMIN_TOKEN: token,
    // The reader principal's token (ADR-070). Required in anonymous read-only
    // mode, where it is the only token this app holds.
    READ_TOKEN: token,
    // Every visitor is signed in as a reader, with no login page (ADR-069).
    WEB_ANONYMOUS_READ_ONLY: z
      .preprocess(blankAsUnset, z.enum(["true", "false"]).default("false"))
      .transform((value) => value === "true"),
    // http or https only. `z.url()` alone takes any scheme, so `api:8080`, the
    // host and port without one, was read as a URL with the scheme `api:`; the
    // app started, passed its health check, and could reach nothing.
    API_URL: z.url({
      protocol: /^https?$/i,
      error: "must be an http:// or https:// URL, such as http://api:8080"
    }),
    // How many reverse proxies in front of the web app append to X-Forwarded-For.
    // 0 keys the login limiter on the socket and ignores the header, which any
    // client can set. Blank counts as unset, as Compose passes an unset variable.
    TRUSTED_PROXY_COUNT: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(0).max(10).default(0)
    )
  })
  .superRefine((env, context) => {
    if (env.WEB_ANONYMOUS_READ_ONLY) {
      if (env.READ_TOKEN === undefined) {
        context.addIssue({
          code: "custom",
          path: ["READ_TOKEN"],
          message:
            "is required when WEB_ANONYMOUS_READ_ONLY is true. The web app signs every visitor in as a reader with it."
        });
      }
      if (env.ADMIN_TOKEN !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_TOKEN"],
          message:
            "must not be set when WEB_ANONYMOUS_READ_ONLY is true. A web app that serves the public holds the read token only."
        });
      }
      return;
    }
    if (env.ADMIN_TOKEN === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_TOKEN"],
        message:
          "is required. The login form compares against it and sessions are signed with it."
      });
    }
  });

export type WebConfig = z.infer<typeof schema>;

/**
 * Fail at boot with the offending variable named, mirroring packages/config.
 * `startup.ts` calls this once when the server starts and exits on the error.
 *
 * A web app that starts without its token would render a login page that can
 * never succeed — a failure that looks like a forgotten password rather than a
 * misconfiguration.
 */
export function loadWebConfig(source: Record<string, string | undefined>): WebConfig {
  const result = schema.safeParse(withTokensFromFiles(source));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid web configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export const webConfig = (): WebConfig => loadWebConfig(process.env);

/**
 * The token this app sends to the API: the read token in anonymous read-only
 * mode, the admin token otherwise. Server-side only; it never reaches the
 * browser (ADR-029, ADR-070).
 */
export function apiToken(config: WebConfig): string {
  const value = config.WEB_ANONYMOUS_READ_ONLY ? config.READ_TOKEN : config.ADMIN_TOKEN;
  // loadWebConfig refuses a configuration without the token its mode needs.
  if (value === undefined) throw new Error(`Invalid web configuration: ${apiTokenName(config)} is not set.`);
  return value;
}

/** The name of the setting `apiToken` read, for messages. */
export function apiTokenName(config: WebConfig): TokenSetting {
  return config.WEB_ANONYMOUS_READ_ONLY ? "READ_TOKEN" : "ADMIN_TOKEN";
}

/** Whether every visitor is signed in as a reader. Exact, as the schema reads it. */
export function anonymousReadOnly(
  source: Record<string, string | undefined> = process.env
): boolean {
  return source["WEB_ANONYMOUS_READ_ONLY"] === "true";
}

/** What signs and verifies this app's session cookies, and whom they sign in. */
export interface SessionSigner {
  secret: string;
  label: string;
  principal: WebPrincipal;
}

/**
 * The session signer for this app's mode, or `null` when it has no token to
 * sign with. The two modes use different secrets and different HKDF labels, so
 * a session from one never verifies in the other, even if somebody set the two
 * tokens to the same value.
 */
export function sessionSigner(
  source: Record<string, string | undefined> = process.env
): SessionSigner | null {
  if (anonymousReadOnly(source)) {
    const secret = sessionToken(source, "READ_TOKEN");
    return secret === null ? null : { secret, label: READER_SESSION_LABEL, principal: "reader" };
  }
  const secret = sessionAdminToken(source);
  return secret === null ? null : { secret, label: OPERATOR_SESSION_LABEL, principal: "admin" };
}

/**
 * The admin token a session is verified against, or `null` when this app has
 * none to verify against.
 *
 * `null` rather than `""` because a caller must not verify against an empty
 * key. `signSession` derives its key from whatever string it is given, so an
 * empty token verifies a cookie anyone can sign with an empty token, and the
 * gate would admit it: a misconfiguration would become a way in rather than a
 * way out.
 */
export function sessionAdminToken(
  source: Record<string, string | undefined> = process.env
): string | null {
  return sessionToken(source, "ADMIN_TOKEN");
}

function sessionToken(
  source: Record<string, string | undefined>,
  name: TokenSetting
): string | null {
  let value: string | undefined;
  try {
    value = withTokenFromFile(source, name)[name];
  } catch {
    // A misconfigured file leaves no token. This app refuses to start on the
    // mistake (`startup.ts`), so it is only reached when the file changes
    // under a running server.
    return null;
  }
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function withTokensFromFiles(
  source: Record<string, string | undefined>
): Record<string, string | undefined> {
  return TOKEN_SETTINGS.reduce((resolved, name) => withTokenFromFile(resolved, name), source);
}

/**
 * A token read from the file `<NAME>_FILE` names.
 *
 * The rules are `packages/config`'s `resolveSecretFiles`, restated here because
 * this app deliberately depends on no workspace package. Whitespace at the end
 * goes; an empty file is refused; giving both the variable and the file is
 * refused; a path that is not a regular file is refused before it is opened,
 * since reading a named pipe would hang this process. No message holds the value.
 */
function withTokenFromFile(
  source: Record<string, string | undefined>,
  name: TokenSetting
): Record<string, string | undefined> {
  const fileVariable = `${name}_FILE`;
  const path = source[fileVariable]?.trim() ?? "";
  if (path === "") return source;
  if ((source[name]?.trim() ?? "") !== "") {
    throw new Error(
      `Invalid web configuration:\n  ${name} and ${fileVariable} are both set. ` +
        "Set one: nothing on a running container would say which value had won."
    );
  }

  const unreadable = (error: unknown): Error => {
    const code = (error as { code?: unknown }).code;
    return new Error(
      `Invalid web configuration:\n  ${fileVariable} names a file that could not be read${
        typeof code === "string" ? ` (${code})` : ""
      }: ${path}`
    );
  };

  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw unreadable(error);
  }
  if (!stats.isFile()) {
    throw new Error(
      `Invalid web configuration:\n  ${fileVariable} does not name a regular file: ${path}`
    );
  }
  if (stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(
      `Invalid web configuration:\n  ${fileVariable} names a file of ${String(stats.size)} bytes, ` +
        `more than the ${String(MAX_SECRET_FILE_BYTES)} a setting may be read from: ${path}`
    );
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw unreadable(error);
  }

  const value = contents.trimEnd();
  if (value === "") {
    throw new Error(
      `Invalid web configuration:\n  ${fileVariable} names a file with nothing in it: ${path}`
    );
  }
  return { ...source, [name]: value, [fileVariable]: undefined };
}
```

This imports from `./session`, which Task 8 extends with `OPERATOR_SESSION_LABEL`, `READER_SESSION_LABEL` and `WebPrincipal`. Do Task 8 Step 3's `session.ts` change in the same working tree before running Step 4 here, or temporarily commit Tasks 7 and 8 together.

- [ ] **Step 4: Run, after Task 8 Step 3**

Run: `pnpm vitest run apps/web/src/lib && pnpm --filter @wayscribe/web typecheck`
Expected: the new cases PASS. Existing `config.test.ts` cases that asserted the exact message for a missing `ADMIN_TOKEN` may now see "ADMIN_TOKEN: is required. …": update those expectations to that message. Existing callers of `config.ADMIN_TOKEN` fail the type check; Task 8 fixes them.

(Commit together with Task 8.)

---

### Task 8: Web sessions carry a principal; one resolver; the API token follows the mode

**Files:**
- Modify: `apps/web/src/lib/session.ts` (whole file shown)
- Create: `apps/web/src/lib/web-session.ts`, `apps/web/src/lib/web-session.test.ts`
- Modify: `apps/web/app/(authenticated)/layout.tsx`, `apps/web/src/lib/current-project.ts`, `apps/web/src/lib/request-session.ts`, `apps/web/src/lib/api.ts` (lines 219, 244, 369, 427, 446), `apps/web/app/api/login/route.ts`, `apps/web/app/login/page.tsx`, `apps/web/app/api/select-project/route.ts`
- Test: `apps/web/src/lib/session.test.ts`

- [ ] **Step 1: Write the failing tests** — create `apps/web/src/lib/web-session.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { OPERATOR_SESSION_LABEL, READER_SESSION_LABEL, signSession } from "./session";
import { ANONYMOUS_SESSION_MS, resolveSession } from "./web-session";

const ADMIN = "admin-token-for-tests-00000000000000";
const READ = "read-token-for-tests-000000000000000";
const NOW = 1_800_000_000_000;
const operator = { ADMIN_TOKEN: ADMIN };
const anonymous = { WEB_ANONYMOUS_READ_ONLY: "true", READ_TOKEN: READ };

describe("resolveSession", () => {
  it("signs every visitor in as a reader in anonymous read-only mode", () => {
    expect(resolveSession(undefined, NOW, anonymous)).toEqual({
      projectId: "",
      expiresAt: NOW + ANONYMOUS_SESSION_MS,
      principal: "reader"
    });
  });

  it("keeps the project a reader chose", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000, principal: "reader" },
      READER_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, anonymous)).toEqual({
      projectId: "p1",
      expiresAt: NOW + 1000,
      principal: "reader"
    });
  });

  it("never verifies an operator-mode cookie in anonymous mode: it starts a fresh reader session", () => {
    const cookie = signSession(READ, { projectId: "p1", expiresAt: NOW + 1000 }, OPERATOR_SESSION_LABEL);
    expect(resolveSession(cookie, NOW, anonymous)).toMatchObject({ projectId: "", principal: "reader" });
  });

  it("refuses a cookie under the reader label that claims to be an admin", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000, principal: "admin" },
      READER_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, anonymous)).toMatchObject({ projectId: "", principal: "reader" });
  });

  it("never verifies a reader cookie in operator mode, even with the same secret", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000, principal: "reader" },
      READER_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, { ADMIN_TOKEN: READ })).toBeNull();
  });

  it("requires a cookie in operator mode and reads an existing one as an admin's", () => {
    expect(resolveSession(undefined, NOW, operator)).toBeNull();
    const legacy = signSession(ADMIN, { projectId: "", expiresAt: NOW + 1000 });
    expect(resolveSession(legacy, NOW, operator)).toEqual({
      projectId: "",
      expiresAt: NOW + 1000,
      principal: "admin"
    });
  });

  it("admits nobody when the mode's token is missing", () => {
    expect(resolveSession(undefined, NOW, { WEB_ANONYMOUS_READ_ONLY: "true" })).toBeNull();
    expect(resolveSession(undefined, NOW, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/web/src/lib/web-session.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Replace `apps/web/src/lib/session.ts` with**

```ts
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "wayscribe_session";

/** Who a session signs in. Only an admin sees replay and delete. */
export type WebPrincipal = "admin" | "reader";

/**
 * The HKDF label for sessions signed with the admin token. It predates the
 * rename to Wayscribe and must not change: it determines the signing key, so
 * renaming it ends every session (ADR-057).
 */
export const OPERATOR_SESSION_LABEL = "flight-recorder/web-session";

/**
 * The HKDF label for anonymous read-only mode, keyed from the read token
 * (ADR-070). Distinct from the operator label so a session from one mode never
 * verifies in the other, even if both tokens held the same value.
 */
export const READER_SESSION_LABEL = "wayscribe/web-session-anonymous-reader";

export interface SessionPayload {
  projectId: string;
  /** Unix milliseconds. */
  expiresAt: number;
  /** Absent in cookies issued before principals existed, which were all an admin's. */
  principal?: WebPrincipal;
}

export interface VerifiedSession {
  projectId: string;
  expiresAt: number;
  principal: WebPrincipal;
}

/**
 * Derive the cookie signing key from a token.
 *
 * The same HKDF pattern the API uses for its three subkeys. The web application
 * therefore needs one secret rather than two, and rotating the token
 * invalidates every existing session — which is correct behavior, not an
 * inconvenience (ADR-029).
 */
function signingKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", label, 32));
}

/**
 * Sign a session payload.
 *
 * Signed, not encrypted: nothing in the payload is secret, and what matters is
 * that it cannot be altered. A user who decodes their own cookie learns only
 * which project they are already looking at, and whom they are signed in as.
 */
export function signSession(
  secret: string,
  payload: SessionPayload,
  label: string = OPERATOR_SESSION_LABEL
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(secret, label, body)}`;
}

export function verifySession(
  secret: string,
  cookie: string,
  now: number,
  label: string = OPERATOR_SESSION_LABEL
): VerifiedSession | null {
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = cookie.slice(0, separator);
  const presented = cookie.slice(separator + 1);

  const expected = Buffer.from(sign(secret, label, body), "utf8");
  const actual = Buffer.from(presented, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  const { projectId, expiresAt, principal } = payload as Record<string, unknown>;
  if (typeof projectId !== "string" || typeof expiresAt !== "number") return null;
  if (expiresAt <= now) return null;

  const resolved: unknown =
    principal ?? (label === READER_SESSION_LABEL ? "reader" : "admin");
  if (resolved !== "admin" && resolved !== "reader") return null;
  // A key derived from the read token can only ever sign a reader in.
  if (label === READER_SESSION_LABEL && resolved !== "reader") return null;

  return { projectId, expiresAt, principal: resolved };
}

function sign(secret: string, label: string, body: string): string {
  return createHmac("sha256", signingKey(secret, label)).update(body, "utf8").digest("base64url");
}
```

Create `apps/web/src/lib/web-session.ts`:

```ts
import { sessionSigner } from "./config";
import { verifySession, type VerifiedSession } from "./session";

/** How long an anonymous reader's implicit session lasts. */
export const ANONYMOUS_SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * The session behind a request, or null when nobody is signed in.
 *
 * The one place a cookie is verified. In anonymous read-only mode every
 * visitor is a reader: a request with no cookie, or with one that does not
 * verify under the reader key, gets a fresh reader session rather than the
 * login page (ADR-069). A cookie exists in that mode only once a reader picks
 * a project.
 *
 * No signer means no token to verify against, and nothing is verified:
 * verifying against an empty key would admit a cookie signed with an empty
 * key, turning a misconfiguration into a way in.
 */
export function resolveSession(
  cookie: string | undefined,
  now: number,
  source: Record<string, string | undefined> = process.env
): VerifiedSession | null {
  const signer = sessionSigner(source);
  if (signer === null) return null;
  const verified =
    cookie === undefined ? null : verifySession(signer.secret, cookie, now, signer.label);
  if (verified !== null) return verified;
  if (signer.principal === "reader") {
    return { projectId: "", expiresAt: now + ANONYMOUS_SESSION_MS, principal: "reader" };
  }
  return null;
}
```

- [ ] **Step 4: Use the resolver everywhere a session is read or written**

`apps/web/app/(authenticated)/layout.tsx` — replace the imports of `sessionAdminToken` and `verifySession` and the body:

```tsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import { anonymousReadOnly } from "../../src/lib/config";
import { SESSION_COOKIE_NAME } from "../../src/lib/session";
import { resolveSession } from "../../src/lib/web-session";
import { DemoBanner } from "../components/DemoBanner";
import { SiteNav } from "../components/SiteNav";
import { VersionFooter } from "../components/VersionFooter";

// (keep the existing doc comment, adding:) In anonymous read-only mode every
// visitor is signed in as a reader and sees the demo banner (ADR-069).
export default async function AuthenticatedLayout({
  children
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = resolveSession(cookie, Date.now());

  if (session === null) redirect("/login");

  return (
    <>
      {anonymousReadOnly() ? <DemoBanner /> : null}
      <SiteNav />
      {children}
      <VersionFooter />
    </>
  );
}
```

(`DemoBanner` is created in Task 9 Step 3; create it before running tests.)

`apps/web/src/lib/current-project.ts` — replace the imports of `sessionAdminToken`, `verifySession` with `resolveSession` and `VerifiedSession`, add `currentSession`, and use it:

```ts
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { listProjects, type ProjectSummary } from "./api";
import { SESSION_COOKIE_NAME, type VerifiedSession } from "./session";
import { resolveSession } from "./web-session";

/**
 * The session behind the current page, or a redirect to the login page.
 * Pages that need to know whom they are showing to (replay, delete) call this.
 */
export async function currentSession(): Promise<VerifiedSession> {
  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const session = resolveSession(cookie, Date.now());
  if (session === null) redirect("/login");
  return session;
}
```

and in `currentProject()` replace everything from `const cookie = …` through `if (session === null) redirect("/login");` with:

```ts
  const session = await currentSession();
```

`apps/web/src/lib/request-session.ts`:

```ts
import type { NextRequest } from "next/server";
import { webConfig } from "./config";
import { SESSION_COOKIE_NAME, type VerifiedSession } from "./session";
import { resolveSession } from "./web-session";

// (keep the existing doc comment)
export function requestSession(request: NextRequest, now = Date.now()): VerifiedSession | null {
  // Loaded first so a misconfigured app still throws here, as it always has,
  // rather than reading as "not signed in".
  webConfig();
  return resolveSession(request.cookies.get(SESSION_COOKIE_NAME)?.value, now);
}
```

`apps/web/src/lib/api.ts` — import `apiToken` and `apiTokenName` from `./config`; at lines 219, 369 and 427 replace `` `Bearer ${config.ADMIN_TOKEN}` `` with `` `Bearer ${apiToken(config)}` ``; at lines 244 and 446 replace the message with:

```ts
      `The API rejected this request. The web and API containers may hold different ${apiTokenName(config)} values.`
```

`apps/web/app/api/login/route.ts` — import `apiToken` from the config module. After `const config = webConfig();`:

```ts
  // Nobody signs in in anonymous read-only mode: everybody already is a reader.
  if (config.WEB_ANONYMOUS_READ_ONLY) return seeOther("/");
  const adminToken = apiToken(config);
```

then use `adminToken` in place of both `config.ADMIN_TOKEN` uses, and sign with the principal:

```ts
    signSession(adminToken, { projectId: "", expiresAt: now + SESSION_DURATION_MS, principal: "admin" }),
```

`apps/web/app/login/page.tsx` — at the top of `LoginPage`, before reading `searchParams`:

```tsx
  // Every visitor is already signed in as a reader (ADR-069).
  if (anonymousReadOnly()) redirect("/");
```

with `import { redirect } from "next/navigation";` and `import { anonymousReadOnly } from "../../src/lib/config";`.

`apps/web/app/api/select-project/route.ts` — replace `import { webConfig } …` with `import { sessionSigner } from "../../../src/lib/config";`, drop `const config = webConfig();`, and replace the cookie value:

```ts
  const signer = sessionSigner();
  if (signer === null) return seeOther("/login");
  const response = seeOther(next);
  response.cookies.set(
    SESSION_COOKIE_NAME,
    signSession(
      signer.secret,
      { projectId, expiresAt: session.expiresAt, principal: session.principal },
      signer.label
    ),
```

- [ ] **Step 5: Update existing session expectations**

In `apps/web/src/lib/session.test.ts` (and any other test asserting `verifySession(...)` with `toEqual({ projectId, expiresAt })`), add `principal: "admin"` to the expected object. Do not change what is signed.

- [ ] **Step 6: Run the web suites and the type check**

Run: `pnpm vitest run apps/web && pnpm --filter @wayscribe/web typecheck`
Expected: PASS. `layout.test.tsx`'s forged-cookie cases must still redirect: an operator-mode app with no `ADMIN_TOKEN` has no signer, so `resolveSession` returns null.

- [ ] **Step 7: Commit (with Task 7)**

```bash
git add apps/web
git commit -m "feat(web): anonymous read-only mode signs every visitor in as a reader

WEB_ANONYMOUS_READ_ONLY=true needs READ_TOKEN and refuses ADMIN_TOKEN.
Sessions carry a principal; the reader key derives from READ_TOKEN under
its own HKDF label, so a session never verifies across modes. The API is
sent the token of the mode. With the mode off, login is unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Banner, and replay and delete hidden by principal

**Files:**
- Create: `apps/web/app/components/DemoBanner.tsx`, `apps/web/app/components/DemoBanner.test.tsx`
- Modify: `apps/web/app/globals.css`, `apps/web/app/components/EventDetail.tsx`, `apps/web/app/components/JourneyTimeline.tsx` (props at line 23; render at line 386), `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx`, `apps/web/app/(authenticated)/journeys/[journeyId]/replay/page.tsx`, `apps/web/app/(authenticated)/journeys/[journeyId]/delete/page.tsx`, `apps/web/app/api/replay/route.ts`, `apps/web/app/api/journeys/[journeyId]/delete/route.ts`
- Test: `apps/web/app/components/EventDetail.test.tsx`, `apps/web/app/(authenticated)/layout.test.tsx`, new `apps/web/app/api/journeys/[journeyId]/delete/reader.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/app/components/DemoBanner.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoBanner, DEMO_SEARCH } from "./DemoBanner";

describe("DemoBanner", () => {
  it("says what this is, suggests the pinned search, and links the pilot address and the site", () => {
    render(<DemoBanner />);
    expect(screen.getByText("Public demo. Read-only, sample data.")).toBeTruthy();
    expect(DEMO_SEARCH).toBe("+1 555 0100");
    expect(screen.getByRole("link", { name: DEMO_SEARCH }).getAttribute("href")).toBe(
      "/?q=%2B1%20555%200100"
    );
    expect(
      screen.getByRole("link", { name: /pilot/i }).getAttribute("href")
    ).toBe("mailto:pilots@wayscribe.dev");
    expect(screen.getByRole("link", { name: "wayscribe.dev" }).getAttribute("href")).toBe(
      "https://wayscribe.dev"
    );
  });
});
```

(If `@testing-library/react` is not what the other `.test.tsx` files use, follow their render helper instead; check `apps/web/vitest.setup.tsx`.)

Append to `apps/web/app/components/EventDetail.test.tsx`, using the event fixture this file already renders that has `hasInput: true`:

```tsx
it("offers replay to an admin and hides it from a reader", () => {
  const { unmount } = render(<EventDetail event={EVENT_WITH_INPUT} canReplay />);
  expect(screen.queryByRole("link", { name: /Replay this input/ })).not.toBeNull();
  unmount();
  render(<EventDetail event={EVENT_WITH_INPUT} canReplay={false} />);
  expect(screen.queryByRole("link", { name: /Replay this input/ })).toBeNull();
});
```

(`EVENT_WITH_INPUT` stands for that existing fixture's name in the file.)

Append to `apps/web/app/(authenticated)/layout.test.tsx`:

```tsx
describe("anonymous read-only mode", () => {
  it("renders for a visitor with no cookie and shows the demo banner", async () => {
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
    vi.stubEnv("READ_TOKEN", "read-token-for-tests-000000000000000");
    vi.stubEnv("ADMIN_TOKEN", "");
    cookiesMock.mockResolvedValue({ get: () => undefined });
    const element = await AuthenticatedLayout({ children: null });
    const children = (element.props as { children: unknown[] }).children;
    expect(
      children.some(
        (child) =>
          typeof child === "object" &&
          child !== null &&
          (child as { type?: unknown }).type === DemoBanner
      )
    ).toBe(true);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("shows no banner with the mode off", async () => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    presenting(signSession(ADMIN_TOKEN, { projectId: "", expiresAt: Date.now() + 60_000 }));
    const element = await AuthenticatedLayout({ children: null });
    const children = (element.props as { children: unknown[] }).children;
    expect(children.some((child) => (child as { type?: unknown } | null)?.type === DemoBanner)).toBe(false);
  });
});
```

(add `import { DemoBanner } from "../components/DemoBanner";`).

`apps/web/app/api/journeys/[journeyId]/delete/reader.test.ts`:

```ts
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { deleteJourneyMock } = vi.hoisted(() => ({ deleteJourneyMock: vi.fn() }));
vi.mock("../../../../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteJourney: deleteJourneyMock
}));

import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  deleteJourneyMock.mockReset();
});

describe("deleting as a reader", () => {
  it("is refused with 403 before the API is called", async () => {
    vi.stubEnv("WEB_ANONYMOUS_READ_ONLY", "true");
    vi.stubEnv("READ_TOKEN", "read-token-for-tests-000000000000000");
    vi.stubEnv("API_URL", "http://api:8080");
    const body = new FormData();
    body.set("entityType", "customer");
    const request = new NextRequest("http://localhost:3000/api/journeys/jrn_1/delete", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body
    });
    const response = await POST(request, { params: Promise.resolve({ journeyId: "jrn_1" }) });
    expect(response.status).toBe(403);
    expect(deleteJourneyMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run apps/web`
Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

`apps/web/app/components/DemoBanner.tsx`:

```tsx
import Link from "next/link";
import type { ReactElement } from "react";

/** The pinned failed journey's phone number, recreated on every reset (deploy/demo). */
export const DEMO_SEARCH = "+1 555 0100";

/**
 * Shown on every page in anonymous read-only mode (ADR-069). Rendered from the
 * mode, not the principal: it describes the instance, not the visitor.
 */
export function DemoBanner(): ReactElement {
  return (
    <aside className="demo-banner" aria-label="About this demo">
      <p>
        <strong>Public demo. Read-only, sample data.</strong> Try a search for{" "}
        <Link href={`/?q=${encodeURIComponent(DEMO_SEARCH)}`}>{DEMO_SEARCH}</Link>, open the
        failed journey, and read what its transform step changed.{" "}
        <a href="mailto:pilots@wayscribe.dev">Ask about a pilot</a> ·{" "}
        <a href="https://wayscribe.dev">wayscribe.dev</a>
      </p>
    </aside>
  );
}
```

Append to `apps/web/app/globals.css` (a class, never an inline style: the CSP forbids inline styles):

```css
.demo-banner {
  border-bottom: 1px solid var(--border, #d0d7de);
  background: var(--surface-muted, #f6f8fa);
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
}
.demo-banner p {
  margin: 0;
}
```

(Use the variable names `globals.css` already defines for border and muted surface if they differ.)

`EventDetail.tsx` — add the prop with a default that keeps every existing caller unchanged:

```tsx
export function EventDetail({
  event,
  notice = null,
  canReplay = true
}: {
  event: EventDetailData;
  /** Rendered under the heading and its meta line, where the eye already is. */
  notice?: DetailNotice | null;
  /** False for a reader: replay is an admin's act (ADR-070). */
  canReplay?: boolean;
}) {
```

and change the replay block's condition from `{!event.hasInput ? null : (` to `{!event.hasInput || !canReplay ? null : (`.

`JourneyTimeline.tsx` — add to `JourneyTimelineProps`:

```ts
  /** Whether the viewer may replay: false for a reader (ADR-070). */
  canReplay: boolean;
```

and at the render (line 386): `<EventDetail event={detail} notice={detailNotice} canReplay={props.canReplay} />`.

Journey page `app/(authenticated)/journeys/[journeyId]/page.tsx` — import `currentSession` alongside `requireProjectId` from `current-project`, and after `const projectId = await requireProjectId(…);`:

```tsx
    // By principal, not by the anonymous setting: a reader sees the same page
    // whichever mode signed it in (ADR-070).
    const canOperate = (await currentSession()).principal === "admin";
```

wrap the delete paragraph:

```tsx
        {canOperate ? (
          <p className="muted">
            <Link href={`/journeys/${encodeURIComponent(journeyId)}/delete`}>
              Delete this journey
            </Link>
          </p>
        ) : null}
```

and pass `canReplay={canOperate}` to `<JourneyTimeline … />`.

Replay page and delete page (`…/replay/page.tsx`, `…/delete/page.tsx`) — at the start of each page function, before anything reaches the API:

```tsx
  // Not offered to a reader, and not reachable by typing the URL either.
  if ((await currentSession()).principal !== "admin") notFound();
```

importing `currentSession` from `src/lib/current-project` and `notFound` from `next/navigation` (relative paths as in each file's existing imports). In `replay/page.test.tsx`, mock `currentSession` to resolve `{ projectId: "", expiresAt: Date.now() + 60_000, principal: "admin" }` wherever that file already mocks `current-project`, so its existing cases keep passing, and add one case where it resolves `principal: "reader"` and the page calls `notFound`.

Route handlers `app/api/replay/route.ts` and `app/api/journeys/[journeyId]/delete/route.ts` — directly after the `if (session === null) { … }` block:

```ts
  if (session.principal !== "admin") {
    return NextResponse.json(
      { error: { code: "forbidden", message: "A read-only session cannot do this." } },
      { status: 403 }
    );
  }
```

(`NextResponse` is already imported in both.)

- [ ] **Step 4: Run the web suites and the type check**

Run: `pnpm vitest run apps/web && pnpm --filter @wayscribe/web typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): demo banner, and replay and delete hidden from a reader

Hidden by the session's principal, not by the setting; the pages answer
404 and the route handlers 403 to a reader who types the URL.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Generated history and the pinned journey (pure)

**Files:**
- Modify: `apps/demo/package.json` (dependencies)
- Create: `apps/demo/src/history.ts`, `apps/demo/src/history.test.ts`

- [ ] **Step 1: Add the two workspace dependencies**

In `apps/demo/package.json` `dependencies`, add `"@wayscribe/payload-security": "workspace:*"` and `"@wayscribe/protocol": "workspace:*"`, then run `pnpm install` so `pnpm-lock.yaml` records the links. (`normalizeSearchValue` is the pipeline's own normalization; `PROTOCOL_VERSION` and `MAX_BATCH_EVENTS` are the contract's own constants.)

- [ ] **Step 2: Write the failing test** — `apps/demo/src/history.test.ts`

```ts
import { normalizeSearchValue } from "@wayscribe/payload-security";
import { describe, expect, it } from "vitest";
import {
  generateHistory,
  historyEnvelopes,
  loopAccount,
  PINNED_ACCOUNT_ID,
  PINNED_JOURNEY_ID,
  PINNED_PHONE,
  PINNED_TRANSFORM_EVENT_ID,
  pinnedEnvelopes,
  type HistoryEnvelope
} from "./history.js";

/** mulberry32: a seeded generator, so a failure here is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const NOW = new Date("2026-10-07T04:05:00.000Z");
const DAY_MS = 86_400_000;
const options = { now: NOW, count: 300, days: 5, failureRate: 0.2, random: seeded(7) };

const eventsOf = (envelopes: HistoryEnvelope[]) => envelopes.map((envelope) => envelope.event);

describe("generateHistory", () => {
  it("makes the requested number of journeys, all inside the window and before now", () => {
    const history = generateHistory(options);
    expect(history).toHaveLength(300);
    for (const customer of history) {
      const events = eventsOf(historyEnvelopes(customer, "development"));
      for (const event of events) {
        const at = Date.parse(event.timestamp);
        expect(at).toBeGreaterThanOrEqual(NOW.getTime() - 5 * DAY_MS);
        expect(at).toBeLessThan(NOW.getTime());
      }
    }
  });

  it("refuses to emit a duplicate rather than let two journeys share an identifier", () => {
    // A generator stuck on one value makes every candidate collide with the first.
    expect(() =>
      generateHistory({ ...options, count: 2, random: () => 0, maxAttempts: 50 })
    ).toThrow(/Generated only 1 of 2/);
  });

  it("never repeats an identifier on the normalized form the pipeline searches, nor the pinned ones", () => {
    const history = generateHistory(options);
    const seen = new Set([PINNED_PHONE, PINNED_ACCOUNT_ID].map(normalizeSearchValue));
    for (const customer of history) {
      for (const value of [customer.account.Id, customer.internalCustomerId, customer.account.Phone]) {
        const key = normalizeSearchValue(value);
        expect(seen.has(key), value).toBe(false);
        seen.add(key);
      }
    }
  });

  it("fails about a fifth of journeys, the ones whose account lacks Phone__c", () => {
    const history = generateHistory(options);
    const failed = history.filter((customer) => customer.fails);
    expect(failed.length / history.length).toBeGreaterThan(0.12);
    expect(failed.length / history.length).toBeLessThan(0.28);
    for (const customer of history) {
      expect(customer.account.Phone__c === undefined).toBe(customer.fails);
    }
  });
});

describe("historyEnvelopes", () => {
  it("records the live services' steps in time order, ending failed or completed", () => {
    const [failing] = generateHistory({ ...options, failureRate: 1 });
    const [passing] = generateHistory({ ...options, failureRate: 0 });
    for (const [customer, last] of [
      [failing, "failed"],
      [passing, "completed"]
    ] as const) {
      if (customer === undefined) throw new Error("no customer generated");
      const events = eventsOf(historyEnvelopes(customer, "development"));
      const times = events.map((event) => Date.parse(event.timestamp));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(events[0]?.name).toBe("receive-salesforce-webhook");
      expect(events.at(-1)?.operation).toBe(last);
      const transform = events.find((event) => event.operation === "transformed");
      expect(transform?.input).toEqual(customer.account);
      expect((transform?.output as { phone: unknown }).phone).toBe(
        customer.fails ? null : customer.account.Phone__c
      );
    }
  });
});

describe("pinnedEnvelopes", () => {
  it("is the failed journey for +1 555 0100, searchable by the phone, with the phone diff", () => {
    const events = eventsOf(pinnedEnvelopes(NOW, "development"));
    expect(new Set(events.map((event) => event.journeyId))).toEqual(new Set([PINNED_JOURNEY_ID]));
    const identify = events.find((event) => event.operation === "identified");
    expect(identify?.aliases?.["phone"]).toBe(PINNED_PHONE);
    const transform = events.find((event) => event.id === PINNED_TRANSFORM_EVENT_ID);
    expect((transform?.input as { Phone: string }).Phone).toBe(PINNED_PHONE);
    expect((transform?.output as { phone: unknown }).phone).toBeNull();
    expect(events.at(-1)?.operation).toBe("failed");
    expect(Date.parse(events.at(-1)?.timestamp ?? "")).toBeLessThan(NOW.getTime());
  });
});

describe("loopAccount", () => {
  it("fails about a fifth of runs and gives each run its own account id", () => {
    const random = seeded(11);
    const accounts = Array.from({ length: 1000 }, (_, i) =>
      loopAccount(new Date(NOW.getTime() + i), random, 0.2)
    );
    const failing = accounts.filter((account) => account.Phone__c === undefined).length;
    expect(failing / accounts.length).toBeGreaterThan(0.15);
    expect(failing / accounts.length).toBeLessThan(0.25);
    expect(new Set(accounts.map((account) => normalizeSearchValue(account.Id))).size).toBe(1000);
    expect(accounts.map((account) => account.Phone)).not.toContain(PINNED_PHONE);
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `pnpm vitest run apps/demo/src/history.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement `apps/demo/src/history.ts`**

```ts
import { createHash } from "node:crypto";
import { normalizeSearchValue } from "@wayscribe/payload-security";
import { PROTOCOL_VERSION } from "@wayscribe/protocol";
import { TEST_ACCOUNT, type SalesforceAccount } from "./account.js";
import { transformAccount } from "./transform.js";

/**
 * Generated history for the public demo (deploy/demo, ADR-069).
 *
 * The live services stamp every event with the current time, so history cannot
 * come from them. These are the same journeys written straight to the ingestion
 * API with past timestamps: the same services, step names and payloads, and the
 * real, deliberately broken `transformAccount`, so the diff a visitor reads is
 * the one the live stack would record.
 */

export const PINNED_PHONE = "+1 555 0100";
export const PINNED_ACCOUNT_ID = "0018Z00005PIN01";
export const PINNED_JOURNEY_ID = "jrn_demo_pinned_5550100";
export const PINNED_TRANSFORM_EVENT_ID = "evt_demo_pinned_5550100_transform";

/**
 * Backfilled internal customer IDs start here. The live sequence starts at
 * 18492 (customers.ts) and grows by about 1,440 a day, so the two never meet,
 * and `18492` stays the search case DEMO_SCENARIO.md section 9 names.
 */
export const HISTORY_INTERNAL_ID_START = 500_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const FIRST_NAMES = [
  "Avery", "Blake", "Casey", "Devon", "Emerson", "Finley", "Harper", "Jordan", "Kendall", "Logan",
  "Morgan", "Parker", "Quinn", "Reese", "Rowan", "Sawyer", "Skyler", "Taylor", "Riley", "Hayden"
];
const LAST_NAMES = [
  "Alvarez", "Brooks", "Chen", "Delgado", "Ellis", "Fischer", "Garcia", "Hughes", "Ibarra", "Jensen",
  "Kowalski", "Lambert", "Moreno", "Nakamura", "Okafor", "Patel", "Quintero", "Russo", "Silva", "Turner"
];
const AREA_CODES = ["212", "312", "415", "512", "617", "919"];
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface HistoryCustomer {
  account: SalesforceAccount;
  internalCustomerId: string;
  fails: boolean;
  startedAt: Date;
}

export interface HistoryOptions {
  now: Date;
  count: number;
  days: number;
  failureRate: number;
  random: () => number;
  /** Gives up rather than loop forever on a generator that cannot produce new values. */
  maxAttempts?: number;
}

/** One envelope as `POST /v1/events/batch` takes it. */
export interface HistoryEnvelope {
  protocolVersion: string;
  event: HistoryEvent;
}

export interface HistoryEvent {
  id: string;
  journeyId: string;
  environment: string;
  service: string;
  entity: { type: "customer"; id: string };
  operation: string;
  name: string;
  timestamp: string;
  aliases?: Record<string, string>;
  displayableAliases?: string[];
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code?: string };
  metadata?: Record<string, unknown>;
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)] as T;

export function customerName(random: () => number): string {
  return `${pick(FIRST_NAMES, random)} ${pick(LAST_NAMES, random)}`;
}

/** `+1 AAA 555 NNNN`: never the pinned `+1 555 0100`, which has no area code. */
export function phoneNumber(random: () => number): string {
  const line = String(Math.floor(random() * 10_000)).padStart(4, "0");
  return `+1 ${pick(AREA_CODES, random)} 555 ${line}`;
}

function salesforceId(random: () => number): string {
  let suffix = "";
  for (let i = 0; i < 10; i += 1) suffix += pick([...ID_ALPHABET], random);
  return `0018Z${suffix}`;
}

/**
 * About `count` customers whose journeys start inside the past `days` days.
 *
 * Identifiers are deduplicated on `normalizeSearchValue`, the form the pipeline
 * searches and correlates on: two values that normalize alike would land in one
 * journey's search results, and the history would no longer be what it claims.
 * The pinned journey's values and the reference account are reserved.
 */
export function generateHistory(options: HistoryOptions): HistoryCustomer[] {
  const taken = new Set(
    [PINNED_PHONE, PINNED_ACCOUNT_ID, TEST_ACCOUNT.Id, TEST_ACCOUNT.Phone].map(normalizeSearchValue)
  );
  const maxAttempts = options.maxAttempts ?? options.count * 50;
  const span = options.days * DAY_MS;
  const customers: HistoryCustomer[] = [];

  for (let attempts = 0; customers.length < options.count; attempts += 1) {
    if (attempts >= maxAttempts) {
      throw new Error(
        `Generated only ${String(customers.length)} of ${String(options.count)} distinct customers.`
      );
    }
    const id = salesforceId(options.random);
    const phone = phoneNumber(options.random);
    const internalCustomerId = String(HISTORY_INTERNAL_ID_START + customers.length);
    const keys = [id, phone, internalCustomerId].map(normalizeSearchValue);
    if (keys.some((key) => taken.has(key))) continue;
    for (const key of keys) taken.add(key);

    const fails = options.random() < options.failureRate;
    const name = customerName(options.random);
    const status = options.random() < 0.85 ? "Active" : "Prospect";
    // Inside the window, and finished at least an hour before now so the
    // newest history never looks like the live loop's traffic.
    const startedAt = new Date(
      options.now.getTime() - span + Math.floor(options.random() * (span - HOUR_MS))
    );
    const base = { Id: id, Name: name, Phone: phone, Status__c: status };
    customers.push({
      account: fails ? base : { ...base, Phone__c: phone },
      internalCustomerId,
      fails,
      startedAt
    });
  }

  return customers.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

/** One loop run's account: a new id each millisecond, failing at `failureRate`. */
export function loopAccount(
  now: Date,
  random: () => number,
  failureRate = 0.2
): SalesforceAccount {
  const phone = phoneNumber(random);
  const base = {
    Id: `001LP${now.getTime().toString(36).toUpperCase()}`,
    Name: customerName(random),
    Phone: phone,
    Status__c: "Active"
  };
  return random() < failureRate ? base : { ...base, Phone__c: phone };
}

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);

interface Step {
  offsetMs: number;
  service: "demo-integration" | "demo-worker";
  operation: string;
  name: string;
  fields?: Partial<HistoryEvent>;
}

/** The steps the live integration and worker record, with their usual spacing. */
function stepsFor(
  customer: HistoryCustomer,
  extraAliases: Record<string, string>
): Step[] {
  const { account } = customer;
  const transformed = transformAccount(account);
  const messageId = `msg-${hash(account.Id)}`;
  const message = { customer: transformed, internalCustomerId: Number(customer.internalCustomerId) };
  const rejected = {
    status: 422,
    body: { error: { code: "phone_required", message: "A phone number is required." } }
  };
  const steps: Step[] = [
    { offsetMs: 0, service: "demo-integration", operation: "received", name: "receive-salesforce-webhook", fields: { input: account } },
    { offsetMs: 12, service: "demo-integration", operation: "transformed", name: "transform-salesforce-account", fields: { input: account, output: transformed, durationMs: 1 } },
    { offsetMs: 35, service: "demo-integration", operation: "persisted", name: "persist-customer", fields: { input: transformed, output: Number(customer.internalCustomerId), durationMs: 18 } },
    {
      offsetMs: 40,
      service: "demo-integration",
      operation: "identified",
      name: "identify",
      fields: {
        aliases: {
          salesforceAccountId: account.Id,
          internalCustomerId: customer.internalCustomerId,
          ...extraAliases
        },
        ...(Object.keys(extraAliases).length === 0 ? {} : { displayableAliases: Object.keys(extraAliases) })
      }
    },
    { offsetMs: 55, service: "demo-integration", operation: "published", name: "publish-customer-updated", fields: { input: message, output: { messageId }, durationMs: 9 } },
    { offsetMs: 260, service: "demo-worker", operation: "consumed", name: "consume-customer-updated", fields: { input: message, metadata: { messageId } } }
  ];

  if (!customer.fails) {
    steps.push(
      { offsetMs: 290, service: "demo-worker", operation: "delivered", name: "deliver-customer-to-target", fields: { input: transformed, output: { status: 201, body: { id: account.Id } }, durationMs: 21 } },
      { offsetMs: 300, service: "demo-worker", operation: "completed", name: "finish" }
    );
    return steps;
  }

  steps.push(
    { offsetMs: 290, service: "demo-worker", operation: "delivered", name: "deliver-customer-to-target", fields: { input: transformed, output: rejected, durationMs: 19, error: { message: "deliver-customer-to-target reported a failed result.", code: "result_failed" } } },
    { offsetMs: 3_310, service: "demo-worker", operation: "retried", name: "retry-customer-delivery", fields: { input: transformed, output: rejected, durationMs: 17, metadata: { attempt: 2 }, error: { message: "retry-customer-delivery reported a failed result.", code: "result_failed" } } },
    { offsetMs: 6_330, service: "demo-worker", operation: "retried", name: "retry-customer-delivery", fields: { input: transformed, output: rejected, durationMs: 18, metadata: { attempt: 3 }, error: { message: "retry-customer-delivery reported a failed result.", code: "result_failed" } } },
    { offsetMs: 9_400, service: "demo-worker", operation: "failed", name: "move-message-to-dead-letter", fields: { error: { message: "Delivery failed on every attempt; the message moved to the dead-letter queue." }, metadata: { queue: "customer-updates-dlq", messageId } } }
  );
  return steps;
}

function envelopesFor(
  customer: HistoryCustomer,
  environment: string,
  ids: { journeyId: string; eventId: (index: number, step: Step) => string },
  extraAliases: Record<string, string> = {}
): HistoryEnvelope[] {
  return stepsFor(customer, extraAliases).map((step, index) => ({
    protocolVersion: PROTOCOL_VERSION,
    event: {
      id: ids.eventId(index, step),
      journeyId: ids.journeyId,
      environment,
      service: step.service,
      entity: { type: "customer", id: customer.account.Id },
      operation: step.operation,
      name: step.name,
      timestamp: new Date(customer.startedAt.getTime() + step.offsetMs).toISOString(),
      ...step.fields
    }
  }));
}

/** One backfilled journey's events. Ids are derived, so a rerun is idempotent. */
export function historyEnvelopes(customer: HistoryCustomer, environment: string): HistoryEnvelope[] {
  const key = hash(`history:${customer.account.Id}`);
  return envelopesFor(customer, environment, {
    journeyId: `jrn_hist_${key}`,
    eventId: (index) => `evt_hist_${key}_${String(index)}`
  });
}

/**
 * The journey the banner points at: `+1 555 0100`, failed, half an hour old.
 * The phone is an alias, so the search finds it, and is marked displayable so
 * the alias list shows it in full. Recreated with the same ids on every reset,
 * which the smoke check relies on.
 */
export function pinnedEnvelopes(now: Date, environment: string): HistoryEnvelope[] {
  const customer: HistoryCustomer = {
    account: { Id: PINNED_ACCOUNT_ID, Name: "Dana Whitfield", Phone: PINNED_PHONE, Status__c: "Active" },
    internalCustomerId: String(HISTORY_INTERNAL_ID_START - 1),
    fails: true,
    startedAt: new Date(now.getTime() - 30 * 60 * 1000)
  };
  return envelopesFor(
    customer,
    environment,
    {
      journeyId: PINNED_JOURNEY_ID,
      eventId: (index, step) =>
        step.operation === "transformed"
          ? PINNED_TRANSFORM_EVENT_ID
          : `evt_demo_pinned_5550100_${String(index)}`
    },
    { phone: PINNED_PHONE }
  );
}
```

(Run `pnpm format` afterwards; Prettier will reflow the step literals.)

- [ ] **Step 5: Run**

Run: `pnpm vitest run apps/demo/src/history.test.ts && pnpm --filter @wayscribe/demo typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/demo pnpm-lock.yaml
git commit -m "feat(demo): generated history and the pinned +1 555 0100 journey

Same services, steps and payloads as the live stack, past timestamps,
identifiers deduplicated on the pipeline's normalized form.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Backfill entry point

**Files:**
- Create: `apps/demo/src/backfill.ts`, `apps/demo/src/batches.ts`, `apps/demo/src/batches.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/demo/src/batches.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { backfillWindowProblem, inBatches } from "./batches.js";

describe("inBatches", () => {
  it("splits into batches of at most the size, keeping order", () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("backfillWindowProblem", () => {
  it("refuses a window retention would sweep before the next nightly reset", () => {
    expect(backfillWindowProblem(5, 7)).toBeNull();
    expect(backfillWindowProblem(6, 7)).toMatch(/DEMO_HISTORY_DAYS/);
    expect(backfillWindowProblem(7, 7)).toMatch(/DEMO_HISTORY_DAYS/);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm vitest run apps/demo/src/batches.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`apps/demo/src/batches.ts`:

```ts
export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * History must outlive a day of waiting for the next reset: the oldest journey
 * is `days` old when written and `days + 1` just before the next nightly reset,
 * which must still be inside retention.
 */
export function backfillWindowProblem(days: number, retentionDays: number): string | null {
  return days + 1 < retentionDays
    ? null
    : `DEMO_HISTORY_DAYS=${String(days)} would be swept by the ${String(retentionDays)}-day retention before the next nightly reset. Keep it below ${String(retentionDays - 1)}.`;
}
```

`apps/demo/src/backfill.ts`:

```ts
import { MAX_BATCH_EVENTS } from "@wayscribe/protocol";
import { backfillWindowProblem, inBatches } from "./batches.js";
import { optionalEnv, requiredEnv } from "./env.js";
import { generateHistory, historyEnvelopes, pinnedEnvelopes } from "./history.js";

/**
 * Writes the public demo's history once, after bootstrap: the pinned journey
 * first, so the smoke check can pass as early as possible, then about 300
 * journeys over the past five days. Exits non-zero on any refusal, so a reset
 * that produced a half-empty demo fails loudly (deploy/demo/host/reset.sh).
 */
const endpoint = optionalEnv("WAYSCRIBE_ENDPOINT", "http://api:8080");
const apiKey = requiredEnv("WAYSCRIBE_API_KEY");
const environment = optionalEnv("WAYSCRIBE_ENVIRONMENT", "development");
const count = positive("DEMO_HISTORY_JOURNEYS", "300");
const days = positive("DEMO_HISTORY_DAYS", "5");
const retentionDays = positive("DEFAULT_RETENTION_DAYS", "7");

function positive(name: string, fallback: string): number {
  const value = Number.parseInt(optionalEnv(name, fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const problem = backfillWindowProblem(days, retentionDays);
if (problem !== null) throw new Error(problem);

const now = new Date();
const envelopes = [
  ...pinnedEnvelopes(now, environment),
  ...generateHistory({ now, count, days, failureRate: 0.2, random: Math.random }).flatMap(
    (customer) => historyEnvelopes(customer, environment)
  )
];

let stored = 0;
for (const batch of inBatches(envelopes, MAX_BATCH_EVENTS)) {
  const response = await fetch(`${endpoint}/v1/events/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ events: batch })
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: { results?: { status: string; error?: { code?: string } }[] };
  };
  const rejected = (body.data?.results ?? []).filter((result) => result.status === "rejected");
  if (!response.ok || rejected.length > 0) {
    throw new Error(
      `The API refused backfill: HTTP ${String(response.status)}, ${String(rejected.length)} rejected (${rejected
        .map((result) => result.error?.code ?? "unknown")
        .join(", ")}).`
    );
  }
  stored += batch.length;
}
console.log(`[backfill] stored ${String(stored)} events: the pinned journey and ${String(count)} over ${String(days)} days`);
```

- [ ] **Step 4: Run** — `pnpm vitest run apps/demo && pnpm --filter @wayscribe/demo typecheck && pnpm --filter @wayscribe/demo build` → PASS, and `apps/demo/dist/backfill.js` exists.

- [ ] **Step 5: Commit**

```bash
git add apps/demo
git commit -m "feat(demo): backfill entry point for the public demo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Loop mode for `source`

**Files:**
- Modify: `apps/demo/src/source.ts`

- [ ] **Step 1: Implement** — add to `apps/demo/src/source.ts`, before `await app.listen(…)`:

```ts
import { loopAccount } from "./history.js";

/**
 * The public demo's live traffic: one new customer every DEMO_LOOP_INTERVAL_MS
 * (60000 there), about a fifth of them without `Phone__c`, so they take the
 * 422, retry, dead-letter path. Unset or 0, as everywhere else, means no loop.
 * A failed trigger is logged and the loop goes on: the integration may still be
 * starting.
 */
const loopIntervalMs = Number.parseInt(optionalEnv("DEMO_LOOP_INTERVAL_MS", "0"), 10);
if (Number.isInteger(loopIntervalMs) && loopIntervalMs > 0) {
  setInterval(() => {
    const account = loopAccount(new Date(), Math.random);
    void fetch(`${integrationUrl}/webhooks/salesforce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(account)
    })
      .then((response) => {
        app.log.info({ status: response.status, account: account.Id }, "loop trigger");
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error }, "loop trigger failed; the next one runs on schedule");
      });
  }, loopIntervalMs);
  app.log.info({ intervalMs: loopIntervalMs }, "loop mode on");
}
```

(Place the `import` with the file's other imports.) The loop's account generator is tested in Task 10 (`loopAccount`); this wiring is exercised by the CI overlay job (Task 18), whose stack runs it.

- [ ] **Step 2: Run** — `pnpm --filter @wayscribe/demo typecheck && pnpm vitest run apps/demo` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/demo/src/source.ts
git commit -m "feat(demo): loop mode, one generated customer a minute

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The shared smoke check

**Files:**
- Create: `deploy/demo/smoke-check.sh`, `deploy/demo/wait-for-smoke.sh`

- [ ] **Step 1: Write `deploy/demo/smoke-check.sh`**

```sh
#!/bin/sh
# The public demo's smoke check, shared by the CI overlay job, the deploy job,
# the nightly reset and the uptime timer (docs/DEMO_HOSTING.md).
#
#   sh deploy/demo/smoke-check.sh https://demo.wayscribe.dev
#
# Loads the home page through Caddy, searches +1 555 0100 through the web app,
# and opens the pinned failed journey on its transform step, where the phone
# diff is. Sends a fixed User-Agent so the visit notifier does not count it.
#
# No `cmd | grep -q`: under pipefail that reports false failures when grep
# exits early. Every response is captured, then matched with `case`.
set -eu

BASE="${1:?usage: smoke-check.sh <base-url>}"
BASE="${BASE%/}"
USER_AGENT="wayscribe-smoke/1"
PINNED_PHONE="+1 555 0100"
PINNED_QUERY="%2B1%20555%200100"
# apps/demo/src/history.ts: PINNED_JOURNEY_ID and PINNED_TRANSFORM_EVENT_ID.
# tests/demo-overlay.test.ts fails if these drift from it.
PINNED_JOURNEY_ID="jrn_demo_pinned_5550100"
PINNED_TRANSFORM_EVENT_ID="evt_demo_pinned_5550100_transform"

JAR=$(mktemp)
trap 'rm -f "${JAR}"' EXIT

fail() {
  echo "smoke-check: $1" >&2
  exit 1
}

fetch() {
  curl --silent --show-error --fail --location --max-time 20 \
    --user-agent "${USER_AGENT}" --cookie "${JAR}" --cookie-jar "${JAR}" "$1"
}

home=$(fetch "${BASE}/") || fail "the home page did not load from ${BASE}/"
case "${home}" in
  *"Public demo. Read-only, sample data."*) ;;
  *) fail "the home page has no demo banner" ;;
esac

results=$(fetch "${BASE}/?q=${PINNED_QUERY}") || fail "the search for ${PINNED_PHONE} did not load"
case "${results}" in
  *"${PINNED_JOURNEY_ID}"*) ;;
  *) fail "the search for ${PINNED_PHONE} did not list ${PINNED_JOURNEY_ID}" ;;
esac

journey=$(fetch "${BASE}/journeys/${PINNED_JOURNEY_ID}?event=${PINNED_TRANSFORM_EVENT_ID}") ||
  fail "the pinned journey did not load"
case "${journey}" in
  *"What changed"*) ;;
  *) fail "the pinned journey's transform step shows no diff" ;;
esac
case "${journey}" in
  *"${PINNED_PHONE}"*) ;;
  *) fail "the diff does not show ${PINNED_PHONE}" ;;
esac

echo "smoke-check: ok ${BASE}"
```

- [ ] **Step 2: Write `deploy/demo/wait-for-smoke.sh`**

```sh
#!/bin/sh
# Run the smoke check until it passes or the deadline passes. Never unbounded.
#
#   sh deploy/demo/wait-for-smoke.sh <base-url> <deadline-seconds>
set -eu

BASE="${1:?usage: wait-for-smoke.sh <base-url> <deadline-seconds>}"
DEADLINE_SECONDS="${2:?usage: wait-for-smoke.sh <base-url> <deadline-seconds>}"
HERE=$(dirname "$0")
started=$(date +%s)

while :; do
  if output=$(sh "${HERE}/smoke-check.sh" "${BASE}" 2>&1); then
    echo "${output}"
    exit 0
  fi
  now=$(date +%s)
  if [ $((now - started)) -ge "${DEADLINE_SECONDS}" ]; then
    echo "wait-for-smoke: still failing after ${DEADLINE_SECONDS}s: ${output}" >&2
    exit 1
  fi
  sleep 10
done
```

- [ ] **Step 3: Check syntax** — `sh -n deploy/demo/smoke-check.sh && sh -n deploy/demo/wait-for-smoke.sh && chmod +x deploy/demo/*.sh`. If `shellcheck` is installed, `shellcheck deploy/demo/*.sh` must report nothing. Behavior is exercised end to end by the CI overlay job (Task 18).

- [ ] **Step 4: Commit**

```bash
git add deploy/demo/smoke-check.sh deploy/demo/wait-for-smoke.sh
git commit -m "feat(deploy): the demo smoke check, shared by CI, deploy and uptime

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Visit notifier — pure functions and tests

The notifier runs on Node 22.12, the oldest Node the repository supports, with Node's own type stripping (`--experimental-strip-types`), so it is TypeScript with **erasable syntax only**: no `enum`, no `namespace`, no parameter properties, and type-only imports written `import type`. Relative imports carry the `.ts` extension.

**Files:**
- Create: `deploy/demo/visit-notifier/notifier.ts`
- Create: `tests/visit-notifier.test.ts`
- Modify: `tsconfig.json` (root): include `deploy/**/*.ts`, allow `.ts` import extensions

- [ ] **Step 1: Let the root project type-check and lint deploy/**

In the root `tsconfig.json`:

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"],
    // deploy/demo/visit-notifier runs under Node's type stripping, which needs
    // the real file extension on relative imports. Allowed because this
    // project never emits.
    "allowImportingTsExtensions": true
  },
  "include": ["*.config.ts", "tests/**/*.ts", "deploy/**/*.ts"]
}
```

- [ ] **Step 2: Write the failing test** — `tests/visit-notifier.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import {
  browserFamily,
  closeWindowIfOver,
  createState,
  handleRecord,
  newYorkTime,
  osFamily,
  parseCaddyLine,
  sendToNtfy,
  type AccessRecord
} from "../deploy/demo/visit-notifier/notifier.ts";

const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const T0 = Date.parse("2026-10-07T14:00:00.000Z"); // 10:00 AM in New York (EDT)
const MINUTE = 60_000;

/** A line as Caddy's JSON access log writes it. */
function caddyLine(overrides: {
  ts?: number;
  ip?: string;
  ua?: string;
  uri?: string;
  method?: string;
  status?: number;
  referer?: string;
}): string {
  const headers: Record<string, string[]> = { "User-Agent": [overrides.ua ?? SAFARI] };
  if (overrides.referer !== undefined) headers["Referer"] = [overrides.referer];
  return JSON.stringify({
    level: "info",
    ts: (overrides.ts ?? T0) / 1000,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "172.18.0.1",
      client_ip: overrides.ip ?? "203.0.113.7",
      proto: "HTTP/2.0",
      method: overrides.method ?? "GET",
      host: "demo.wayscribe.dev",
      uri: overrides.uri ?? "/",
      headers
    },
    status: overrides.status ?? 200
  });
}

const record = (overrides: Parameters<typeof caddyLine>[0]): AccessRecord => {
  const parsed = parseCaddyLine(caddyLine(overrides));
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
};

let saltCount = 0;
const newSalt = (): string => `salt-${String(++saltCount)}`;
const handle = (state: ReturnType<typeof createState>, input: AccessRecord, now = input.at) =>
  handleRecord(state, input, { now, ownHost: "demo.wayscribe.dev", newSalt });

describe("parseCaddyLine", () => {
  it("reads the client address, agent, path without its query, status and referrer", () => {
    expect(
      parseCaddyLine(caddyLine({ uri: "/?q=%2B1%20555%200100", referer: "https://news.ycombinator.com/item?id=1" }))
    ).toEqual({
      at: T0,
      clientIp: "203.0.113.7",
      userAgent: SAFARI,
      method: "GET",
      path: "/",
      status: 200,
      referer: "https://news.ycombinator.com/item?id=1"
    });
  });

  it("returns null for a line that is not an access record", () => {
    expect(parseCaddyLine("not json")).toBeNull();
    expect(parseCaddyLine(JSON.stringify({ level: "info", msg: "serving" }))).toBeNull();
  });
});

describe("handleRecord", () => {
  it("notifies a first visit with New York time, landing path, referrer host and browser family", () => {
    const state = createState(T0, newSalt);
    const messages = handle(state, record({ uri: "/journeys/jrn_x?event=e", referer: "https://news.ycombinator.com/" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("10:00 AM ET");
    expect(messages[0]?.body).toContain("/journeys/jrn_x");
    expect(messages[0]?.body).not.toContain("event=e");
    expect(messages[0]?.body).toContain("news.ycombinator.com");
    expect(messages[0]?.body).toContain("Safari on macOS");
  });

  it("never sends a search term", () => {
    const state = createState(T0, newSalt);
    const [message] = handle(state, record({ uri: "/?q=%2B1%20555%200100" }));
    expect(message?.body).not.toContain("555");
    expect(message?.body).not.toContain("q=");
  });

  it("says direct when there is no referrer or it is the demo itself", () => {
    const state = createState(T0, newSalt);
    expect(handle(state, record({}))[0]?.body).toContain("direct");
    expect(
      handle(state, record({ ip: "198.51.100.2", referer: "https://demo.wayscribe.dev/" }))[0]?.body
    ).toContain("direct");
  });

  it("does not notify a repeat from the same client within six hours, and does after", () => {
    const state = createState(T0, newSalt);
    expect(handle(state, record({}))).toHaveLength(1);
    expect(handle(state, record({ ts: T0 + 5 * 60 * MINUTE }))).toHaveLength(0);
    expect(handle(state, record({ ts: T0 + 11 * 60 * MINUTE + 1 }))).toHaveLength(1);
  });

  it("ignores assets, API and health requests, non-GET, errors, the smoke check and bots", () => {
    const state = createState(T0, newSalt);
    for (const ignored of [
      record({ uri: "/_next/static/chunks/app.js" }),
      record({ uri: "/favicon.ico" }),
      record({ uri: "/robots.txt" }),
      record({ uri: "/health" }),
      record({ uri: "/api/events/evt_1" }),
      record({ method: "POST", uri: "/api/select-project" }),
      record({ status: 404, uri: "/nope" }),
      record({ ua: "wayscribe-smoke/1" }),
      record({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }),
      record({ ua: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" }),
      record({ ua: "" })
    ]) {
      expect(handle(state, ignored), ignored.path + " " + ignored.userAgent).toEqual([]);
    }
  });

  it("sends ten in an hour, then one mute notice on the eleventh, then a summary when the hour ends", () => {
    const state = createState(T0, newSalt);
    const sent: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      for (const message of handle(state, record({ ip: `203.0.113.${String(i + 10)}`, ts: T0 + i * MINUTE }))) {
        sent.push(message.title);
      }
    }
    expect(sent.filter((title) => title === "Demo visit")).toHaveLength(10);
    expect(sent.filter((title) => title === "Demo visits muted")).toHaveLength(1);
    expect(sent).toHaveLength(11);

    expect(closeWindowIfOver(state, T0 + 59 * MINUTE)).toEqual([]);
    const summary = closeWindowIfOver(state, T0 + 60 * MINUTE);
    expect(summary).toEqual([{ title: "Demo visits", body: "4 more visits in the last hour." }]);
    // A new hour starts clean.
    expect(handle(state, record({ ip: "192.0.2.1", ts: T0 + 61 * MINUTE }))).toHaveLength(1);
  });

  it("names the minute the mute ends in New York time", () => {
    const state = createState(T0, newSalt);
    let notice = "";
    for (let i = 0; i < 11; i += 1) {
      for (const message of handle(state, record({ ip: `203.0.113.${String(i + 10)}` }))) {
        if (message.title === "Demo visits muted") notice = message.body;
      }
    }
    expect(notice).toContain(`Muted until ${newYorkTime(T0 + 60 * MINUTE)}`);
    expect(newYorkTime(T0 + 60 * MINUTE)).toBe("11:00 AM ET");
  });

  it("rotates its salt daily and holds no raw address", () => {
    const state = createState(T0, newSalt);
    handle(state, record({}));
    const firstSalt = state.salt;
    expect(JSON.stringify([...state.seen.keys()])).not.toContain("203.0.113.7");
    handle(state, record({ ip: "198.51.100.9", ts: T0 + 24 * 60 * MINUTE }));
    expect(state.salt).not.toBe(firstSalt);
  });
});

describe("family names", () => {
  it("reads browser and OS families", () => {
    expect(browserFamily(SAFARI)).toBe("Safari");
    expect(osFamily(SAFARI)).toBe("macOS");
    expect(browserFamily(CHROME_WINDOWS)).toBe("Chrome");
    expect(osFamily(CHROME_WINDOWS)).toBe("Windows");
  });
});

describe("sendToNtfy", () => {
  it("logs and drops a message when ntfy is unreachable, and never throws", async () => {
    const log = vi.fn();
    const failing = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    await expect(
      sendToNtfy({ title: "Demo visit", body: "x" }, { url: "https://ntfy.sh", topic: "t", fetch: failing as unknown as typeof fetch, log })
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("message dropped"));
  });

  it("logs and drops when ntfy answers an error", async () => {
    const log = vi.fn();
    const refusing = vi.fn(() => Promise.resolve(new Response("no", { status: 500 })));
    await expect(
      sendToNtfy({ title: "Demo visit", body: "x" }, { url: "https://ntfy.sh/", topic: "t", fetch: refusing as unknown as typeof fetch, log })
    ).resolves.toBe(false);
    expect(refusing).toHaveBeenCalledWith("https://ntfy.sh/t", expect.objectContaining({ method: "POST" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("500"));
  });
});
```

- [ ] **Step 3: Run to see it fail** — `pnpm vitest run tests/visit-notifier.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement `deploy/demo/visit-notifier/notifier.ts`**

```ts
import { createHash } from "node:crypto";

/**
 * Visit notifications for the public demo (docs/DEMO_HOSTING.md). Demo
 * infrastructure, not product code: nothing in apps/ or packages/ tracks
 * visitors.
 *
 * Runs on Node 22.12 with type stripping, so erasable TypeScript only: no
 * enums, namespaces or parameter properties.
 */

export const SMOKE_USER_AGENT_PREFIX = "wayscribe-smoke/";
export const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const HOURLY_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;
const MAX_REMEMBERED_CLIENTS = 100_000;

export interface AccessRecord {
  /** Unix milliseconds. */
  at: number;
  clientIp: string;
  userAgent: string;
  method: string;
  /** Without the query: a search's query string is what was searched. */
  path: string;
  status: number;
  referer: string | null;
}

export interface Message {
  title: string;
  body: string;
}

export interface NotifierState {
  saltDay: string;
  /** Held in memory only, replaced daily; the client key is a hash under it. */
  salt: string;
  /** Client key to the last time it was seen. No address is kept. */
  seen: Map<string, number>;
  windowStart: number | null;
  sentInWindow: number;
  suppressedInWindow: number;
}

type CaddyHeaders = Record<string, unknown> | undefined;

function firstHeader(headers: CaddyHeaders, name: string): string | null {
  const value = headers?.[name];
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

export function pathOnly(uri: string): string {
  const cut = uri.search(/[?#]/);
  return cut === -1 ? uri : uri.slice(0, cut);
}

/** One line of Caddy's JSON access log, or null for anything else. */
export function parseCaddyLine(line: string): AccessRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const entry = parsed as { ts?: unknown; status?: unknown; request?: unknown };
  if (typeof entry.request !== "object" || entry.request === null) return null;
  const request = entry.request as {
    client_ip?: unknown;
    remote_ip?: unknown;
    method?: unknown;
    uri?: unknown;
    headers?: CaddyHeaders;
  };
  const clientIp =
    typeof request.client_ip === "string"
      ? request.client_ip
      : typeof request.remote_ip === "string"
        ? request.remote_ip
        : null;
  if (
    clientIp === null ||
    typeof request.method !== "string" ||
    typeof request.uri !== "string" ||
    typeof entry.status !== "number"
  ) {
    return null;
  }
  const at =
    typeof entry.ts === "number"
      ? Math.round(entry.ts * 1000)
      : typeof entry.ts === "string"
        ? Date.parse(entry.ts)
        : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return {
    at,
    clientIp,
    userAgent: firstHeader(request.headers, "User-Agent") ?? "",
    method: request.method,
    path: pathOnly(request.uri),
    status: entry.status,
    referer: firstHeader(request.headers, "Referer")
  };
}

const NOT_PAGES = ["/_next/", "/api/", "/health", "/favicon", "/robots.txt"];
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/** A page a person asked for: not an asset, API, health check or error. */
export function isPageRequest(record: AccessRecord): boolean {
  if (record.method !== "GET") return false;
  if (record.status < 200 || record.status >= 400) return false;
  if (NOT_PAGES.some((prefix) => record.path.startsWith(prefix))) return false;
  return !FILE_EXTENSION.test(record.path);
}

const ROBOT = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|lighthouse/i;

/** Not the smoke check (CI, deploy, uptime), and not a self-declared robot. */
export function isCountedAgent(userAgent: string): boolean {
  if (userAgent.trim() === "") return false;
  if (userAgent.startsWith(SMOKE_USER_AGENT_PREFIX)) return false;
  return !ROBOT.test(userAgent);
}

export function clientKey(salt: string, clientIp: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}\n${clientIp}\n${userAgent}`, "utf8").digest("hex");
}

export function browserFamily(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other browser";
}

export function osFamily(userAgent: string): string {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return "other OS";
}

export function referrerHost(referer: string | null, ownHost: string): string {
  if (referer === null) return "direct";
  try {
    const host = new URL(referer).hostname;
    return host === "" || host === ownHost ? "direct" : host;
  } catch {
    return "direct";
  }
}

const NEW_YORK_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit"
});

export function newYorkTime(at: number): string {
  // ICU 72 and later (Node 20+) put a narrow no-break space before AM/PM.
  return `${NEW_YORK_CLOCK.format(at).replace(/ /g, " ")} ET`;
}

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export function createState(now: number, newSalt: () => string): NotifierState {
  return {
    saltDay: utcDay(now),
    salt: newSalt(),
    seen: new Map(),
    windowStart: null,
    sentInWindow: 0,
    suppressedInWindow: 0
  };
}

/**
 * Ends the hour if it is over and returns the summary owed, if any. Called on
 * every record and once a minute, so a quiet hour still gets its summary.
 */
export function closeWindowIfOver(state: NotifierState, now: number): Message[] {
  if (state.windowStart === null || now < state.windowStart + HOUR_MS) return [];
  const suppressed = state.suppressedInWindow;
  state.windowStart = null;
  state.sentInWindow = 0;
  state.suppressedInWindow = 0;
  return suppressed === 0
    ? []
    : [
        {
          title: "Demo visits",
          body: `${String(suppressed)} more visit${suppressed === 1 ? "" : "s"} in the last hour.`
        }
      ];
}

function rotateSaltIfNewDay(state: NotifierState, now: number, newSalt: () => string): void {
  const day = utcDay(now);
  if (day === state.saltDay) return;
  state.saltDay = day;
  state.salt = newSalt();
  // Keys under the old salt can never match again.
  state.seen.clear();
}

function forgetOld(state: NotifierState, now: number): void {
  for (const [key, last] of state.seen) {
    if (now - last >= DEDUPE_WINDOW_MS) state.seen.delete(key);
  }
  if (state.seen.size > MAX_REMEMBERED_CLIENTS) state.seen.clear();
}

function visitMessage(record: AccessRecord, ownHost: string): Message {
  return {
    title: "Demo visit",
    body: [
      newYorkTime(record.at),
      `Landed on ${record.path}`,
      `From ${referrerHost(record.referer, ownHost)}`,
      `${browserFamily(record.userAgent)} on ${osFamily(record.userAgent)}`
    ].join("\n")
  };
}

/** What one access-log record should send, updating the state. */
export function handleRecord(
  state: NotifierState,
  record: AccessRecord,
  options: { now: number; ownHost: string; newSalt: () => string }
): Message[] {
  const out = closeWindowIfOver(state, options.now);
  if (!isPageRequest(record) || !isCountedAgent(record.userAgent)) return out;

  rotateSaltIfNewDay(state, options.now, options.newSalt);
  forgetOld(state, options.now);
  const key = clientKey(state.salt, record.clientIp, record.userAgent);
  const last = state.seen.get(key);
  state.seen.set(key, options.now);
  if (last !== undefined && options.now - last < DEDUPE_WINDOW_MS) return out;

  if (state.windowStart === null) state.windowStart = options.now;
  if (state.sentInWindow < HOURLY_LIMIT) {
    state.sentInWindow += 1;
    out.push(visitMessage(record, options.ownHost));
    return out;
  }
  state.suppressedInWindow += 1;
  if (state.suppressedInWindow === 1) {
    out.push({
      title: "Demo visits muted",
      body: `More than ${String(HOURLY_LIMIT)} visits this hour. Muted until ${newYorkTime(state.windowStart + HOUR_MS)}; a summary follows.`
    });
  }
  return out;
}

export interface SendOptions {
  url: string;
  topic: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  timeoutMs?: number;
}

/** POST one message to ntfy. Logs and drops on any failure; never throws. */
export async function sendToNtfy(message: Message, options: SendOptions): Promise<boolean> {
  const target = `${options.url.replace(/\/+$/, "")}/${encodeURIComponent(options.topic)}`;
  try {
    const response = await options.fetch(target, {
      method: "POST",
      headers: { Title: message.title, Tags: "eyes" },
      body: message.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000)
    });
    if (!response.ok) {
      options.log(`visit-notifier: ntfy answered ${String(response.status)}; message dropped`);
      return false;
    }
    return true;
  } catch (error) {
    options.log(
      `visit-notifier: ntfy unreachable (${error instanceof Error ? error.name : "error"}); message dropped`
    );
    return false;
  }
}
```

- [ ] **Step 5: Run**

Run: `pnpm vitest run tests/visit-notifier.test.ts && pnpm exec tsc -p tsconfig.json --noEmit && pnpm lint`
Expected: PASS. Then prove it parses on the oldest Node without a build step: if Node 22.12 is available (`npx --yes node@22.12.0 --version`), run `npx --yes node@22.12.0 --experimental-strip-types -e 'import("./deploy/demo/visit-notifier/notifier.ts").then(m => console.log(typeof m.handleRecord))'` from the repo root; expected output `function`. If it is not available locally, the CI overlay job (Task 18) proves it by running the container.

- [ ] **Step 6: Commit**

```bash
git add deploy/demo/visit-notifier/notifier.ts tests/visit-notifier.test.ts tsconfig.json
git commit -m "feat(deploy): visit notifier rules for the public demo

Page requests only, smoke check and robots excluded, a 6-hour dedupe on a
daily-salted hash of address and agent, ten a hour then a mute notice and
a summary, New York times, no search terms, ntfy failures dropped.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Visit notifier — log tailing entry point and image

**Files:**
- Create: `deploy/demo/visit-notifier/main.ts`, `deploy/demo/visit-notifier/Dockerfile`

- [ ] **Step 1: Write `deploy/demo/visit-notifier/main.ts`**

```ts
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  closeWindowIfOver,
  createState,
  handleRecord,
  parseCaddyLine,
  sendToNtfy,
  type Message
} from "./notifier.ts";

/**
 * Tails Caddy's access log and posts visits to ntfy. A separate process that
 * only reads a file, so it can never block or slow Caddy. Starts at the end of
 * the log: a restart does not replay old visits. Follows Caddy's roll, which
 * renames the file and starts a new one.
 */
const logPath = process.env["ACCESS_LOG"] ?? "/logs/access.log";
const ntfyUrl = process.env["NTFY_URL"] ?? "https://ntfy.sh";
const topic = process.env["NTFY_TOPIC"] ?? "";
const ownHost = process.env["DEMO_HOST"] ?? "";
if (topic === "") {
  console.error("visit-notifier: NTFY_TOPIC is not set");
  process.exit(1);
}

const newSalt = (): string => randomBytes(32).toString("hex");
const state = createState(Date.now(), newSalt);
const log = (line: string): void => {
  console.error(line);
};

function send(messages: Message[]): void {
  for (const message of messages) {
    void sendToNtfy(message, { url: ntfyUrl, topic, fetch, log });
  }
}

let first = true;
let inode = -1;
let offset = 0;
let partial = "";
let decoder = new StringDecoder("utf8");
const CHUNK_BYTES = 1_048_576;

function poll(): void {
  let stats;
  try {
    stats = statSync(logPath);
  } catch {
    first = false; // Not written yet: read it from the start once it is.
    return;
  }
  if (stats.ino !== inode || stats.size < offset) {
    offset = first ? stats.size : 0;
    inode = stats.ino;
    partial = "";
    decoder = new StringDecoder("utf8");
  }
  first = false;
  if (stats.size === offset) return;

  const fd = openSync(logPath, "r");
  try {
    const length = Math.min(stats.size - offset, CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    offset += read;
    const lines = (partial + decoder.write(buffer.subarray(0, read))).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseCaddyLine(line);
      if (record !== null) send(handleRecord(state, record, { now: Date.now(), ownHost, newSalt }));
    }
  } finally {
    closeSync(fd);
  }
}

console.log(`visit-notifier: watching ${logPath}`);
setInterval(poll, 1000);
setInterval(() => {
  send(closeWindowIfOver(state, Date.now()));
}, 60_000);
```

- [ ] **Step 2: Write `deploy/demo/visit-notifier/Dockerfile`**

```dockerfile
# Node 22.12, the oldest Node this repository supports, running the TypeScript
# sources directly with Node's type stripping. No build step and no packages.
FROM node:22.12.0-alpine
WORKDIR /app
COPY notifier.ts main.ts ./
USER node
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "main.ts"]
```

Pin the base image by digest, as the repository pins its builders: run `docker buildx imagetools inspect node:22.12.0-alpine` and change the `FROM` line to `FROM node:22.12.0-alpine@sha256:<the index digest it prints>`.

- [ ] **Step 3: Check** — `pnpm exec tsc -p tsconfig.json --noEmit && pnpm lint` → PASS. The container itself is exercised by Task 18.

- [ ] **Step 4: Commit**

```bash
git add deploy/demo/visit-notifier
git commit -m "feat(deploy): visit notifier sidecar that tails Caddy's access log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Caddy and the demo overlay

**Files:**
- Create: `deploy/demo/caddy/Dockerfile`, `deploy/demo/caddy/Caddyfile`, `deploy/demo/compose.yaml`
- Create: `tests/demo-overlay.test.ts`

- [ ] **Step 1: Write the failing static test** — `tests/demo-overlay.test.ts`

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

interface Service {
  ports?: unknown[];
  restart?: string;
  environment?: Record<string, unknown>;
  build?: unknown;
  image?: string;
  command?: string[];
}

const services = (path: string): Record<string, Service> =>
  (
    parse(read(path), { merge: true, logLevel: "error" }) as {
      services?: Record<string, Service>;
    }
  ).services ?? {};

const BASE_FILES = [
  "infrastructure/compose.published.yaml",
  "infrastructure/compose.bundled.yaml",
  "infrastructure/compose.demo.yaml"
];
const overlay = services("deploy/demo/compose.yaml");
const ONE_SHOT = new Set(["migrate", "demo-bootstrap", "demo-history"]);

describe("the public demo overlay", () => {
  it("publishes no host port for any service but Caddy", () => {
    for (const file of BASE_FILES) {
      for (const [name, service] of Object.entries(services(file))) {
        if ((service.ports ?? []).length === 0) continue;
        expect(overlay[name]?.ports, `${name} from ${file} keeps a host port`).toEqual([]);
      }
    }
    for (const [name, service] of Object.entries(overlay)) {
      if (name === "caddy") continue;
      expect(service.ports ?? [], `${name} publishes a port`).toEqual([]);
    }
  });

  it("restarts every long-running service unless stopped", () => {
    const names = new Set([
      ...BASE_FILES.flatMap((file) => Object.keys(services(file))),
      ...Object.keys(overlay)
    ]);
    for (const name of names) {
      if (ONE_SHOT.has(name)) continue;
      expect(overlay[name]?.restart, name).toBe("unless-stopped");
    }
  });

  it("runs the web app in anonymous read-only mode holding no admin token", () => {
    expect(overlay["web"]?.environment?.["WEB_ANONYMOUS_READ_ONLY"]).toBe("true");
    expect(overlay["web"]?.environment?.["ADMIN_TOKEN"]).toBe("");
    expect(String(overlay["web"]?.environment?.["READ_TOKEN"])).toContain("READ_TOKEN");
  });

  it("runs the demo services from the published, signed demo image", () => {
    for (const name of ["demo-bootstrap", "demo-target", "demo-integration", "demo-worker", "demo-source", "demo-history"]) {
      expect(overlay[name]?.image, name).toMatch(
        /^registry\.gitlab\.com\/jojithedev\/wayscribe\/demo:\$\{WAYSCRIBE_VERSION/
      );
      expect(overlay[name]?.build, name).toBeNull();
    }
  });

  it("smoke-checks the pinned journey the backfill writes", () => {
    const history = read("apps/demo/src/history.ts");
    const smoke = read("deploy/demo/smoke-check.sh");
    for (const constant of ["PINNED_JOURNEY_ID", "PINNED_TRANSFORM_EVENT_ID"]) {
      const value = new RegExp(`export const ${constant} = "([^"]+)"`).exec(history)?.[1];
      expect(value, constant).toBeDefined();
      expect(smoke).toContain(`${constant}="${value ?? ""}"`);
    }
  });

  it("tells robots to stay out and rate-limits by client", () => {
    const caddyfile = read("deploy/demo/caddy/Caddyfile");
    expect(caddyfile).toContain('X-Robots-Tag "noindex, nofollow"');
    expect(caddyfile).toContain("Disallow: /");
    expect(caddyfile).toMatch(/rate_limit/);
    expect(caddyfile).toContain("format json");
  });
});
```

- [ ] **Step 2: Run to see it fail** — `pnpm vitest run tests/demo-overlay.test.ts` → FAIL (files missing).

- [ ] **Step 3: Write `deploy/demo/caddy/Dockerfile`**

```dockerfile
# Caddy with the rate-limit module: stock Caddy has no rate limiter. Built on
# the demo VM from the release tag's checkout; not a product image.
FROM caddy:2.11.7-builder-alpine AS build
RUN xcaddy build v2.11.7 \
    --with github.com/mholt/caddy-ratelimit@v0.1.1-0.20260612195517-5625512f24f6

FROM caddy:2.11.7-alpine
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
```

Pin both base images by digest the same way as Task 15 Step 2 (`docker buildx imagetools inspect caddy:2.11.7-builder-alpine` and `caddy:2.11.7-alpine`).

- [ ] **Step 4: Write `deploy/demo/caddy/Caddyfile`**

```caddyfile
{
	# The rate-limit module's directive has no default order.
	order rate_limit before reverse_proxy
}

# demo.wayscribe.dev on the VM, with a certificate Caddy obtains itself (the
# Cloudflare record is DNS only). ":80" in CI, plain HTTP.
{$DEMO_SITE_ADDRESS} {
	encode zstd gzip

	header {
		X-Robots-Tag "noindex, nofollow"
		-Server
	}

	handle /robots.txt {
		respond <<ROBOTS
			User-agent: *
			Disallow: /
			ROBOTS 200
	}

	# Per client address. 300 a minute: a journey page polls every two seconds
	# and a page load fetches about twenty assets. Hashed static assets are
	# immutable and not counted.
	@limited not path /_next/static/*
	rate_limit @limited {
		zone per_client {
			key {remote_host}
			events 300
			window 1m
		}
	}

	reverse_proxy web:3000

	# Read by the visit notifier and by Jorge. Kept 7 days. 0644 inside a
	# directory only root can reach on the host (docs/DEMO_HOSTING.md).
	log {
		output file /var/log/caddy/access.log {
			roll_size 50MiB
			roll_keep 14
			roll_keep_for 168h
			mode 0644
		}
		format json
	}
}
```

- [ ] **Step 5: Write `deploy/demo/compose.yaml`**

```yaml
# The public demo at demo.wayscribe.dev (ADR-069, docs/DEMO_HOSTING.md).
# Layered over the published stack, the bundled database and the demo services:
#
#   docker compose --env-file /etc/wayscribe-demo/env \
#     -f infrastructure/compose.published.yaml \
#     -f infrastructure/compose.bundled.yaml \
#     -f infrastructure/compose.demo.yaml \
#     -f deploy/demo/compose.yaml up -d
#
# Compose resolves relative paths from the first file's directory,
# infrastructure/, so paths here start with ../deploy/demo.
#
# Nothing here is part of an install: it lives outside infrastructure/ and
# deploy/helm, so no file a customer runs carries demo pieces.
#
# Only Caddy publishes ports. `!reset []` removes the loopback ports the base
# files publish (Compose 2.24 or newer).

x-demo-image: &demo-image
  image: registry.gitlab.com/jojithedev/wayscribe/demo:${WAYSCRIBE_VERSION:?set WAYSCRIBE_VERSION to the release tag}
  build: !reset null

services:
  api:
    ports: !reset []
    restart: unless-stopped
    environment:
      READ_TOKEN: ${READ_TOKEN:?set READ_TOKEN in the demo env file}
      # Read by doctor, which runs in this container and warns while it is true.
      WEB_ANONYMOUS_READ_ONLY: "true"

  web:
    ports: !reset []
    restart: unless-stopped
    environment:
      WEB_ANONYMOUS_READ_ONLY: "true"
      READ_TOKEN: ${READ_TOKEN:?set READ_TOKEN in the demo env file}
      # A public web container holds no admin token; blank reads as unset.
      ADMIN_TOKEN: ""
      # Caddy appends X-Forwarded-For.
      TRUSTED_PROXY_COUNT: "1"

  postgres:
    ports: !reset []
    restart: unless-stopped

  elasticmq:
    ports: !reset []
    restart: unless-stopped

  demo-bootstrap:
    <<: *demo-image
    environment:
      # The real key, over the published default the env_file supplies.
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?set ENCRYPTION_KEY in the demo env file}

  demo-target:
    <<: *demo-image
    ports: !reset []
    restart: unless-stopped

  demo-integration:
    <<: *demo-image
    ports: !reset []
    restart: unless-stopped

  demo-worker:
    <<: *demo-image
    restart: unless-stopped

  demo-source:
    <<: *demo-image
    ports: !reset []
    restart: unless-stopped
    environment:
      DEMO_LOOP_INTERVAL_MS: "60000"

  # Runs once after bootstrap: the pinned journey, then five days of history.
  demo-history:
    <<: *demo-image
    command: ["node", "apps/demo/dist/backfill.js"]
    restart: "no"
    environment:
      WAYSCRIBE_ENDPOINT: http://api:8080
      WAYSCRIBE_API_KEY: ${DEMO_API_KEY:?set DEMO_API_KEY in the demo env file}
      WAYSCRIBE_ENVIRONMENT: development
      DEMO_HISTORY_JOURNEYS: "300"
      DEMO_HISTORY_DAYS: "5"
      DEFAULT_RETENTION_DAYS: ${DEFAULT_RETENTION_DAYS:-7}
    depends_on:
      demo-bootstrap:
        condition: service_completed_successfully
      api:
        condition: service_healthy

  caddy:
    build: ../deploy/demo/caddy
    image: wayscribe-demo-caddy:local
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      DEMO_SITE_ADDRESS: ${DEMO_SITE_ADDRESS:?set DEMO_SITE_ADDRESS in the demo env file}
    # Bind mounts, not named volumes: `down -v` at every reset must not delete
    # the certificate (Let's Encrypt allows 5 duplicates a week) or the log.
    volumes:
      - ${DEMO_DATA_DIR:?set DEMO_DATA_DIR in the demo env file}/caddy-data:/data
      - ${DEMO_DATA_DIR}/caddy-config:/config
      - ${DEMO_DATA_DIR}/caddy-logs:/var/log/caddy
    restart: unless-stopped
    depends_on:
      web:
        condition: service_healthy

  visit-notifier:
    build: ../deploy/demo/visit-notifier
    image: wayscribe-demo-visit-notifier:local
    environment:
      ACCESS_LOG: /logs/access.log
      NTFY_URL: ${NTFY_URL:-https://ntfy.sh}
      NTFY_TOPIC: ${NTFY_VISIT_TOPIC:?set NTFY_VISIT_TOPIC in the demo env file}
      DEMO_HOST: ${DEMO_SITE_ADDRESS}
    volumes:
      - ${DEMO_DATA_DIR}/caddy-logs:/logs:ro
    read_only: true
    restart: unless-stopped
    depends_on:
      caddy:
        condition: service_started
```

- [ ] **Step 6: Run** — `pnpm vitest run tests/demo-overlay.test.ts` → PASS. Then validate the merged file without starting anything (no secrets involved; dummy values):

```bash
env WAYSCRIBE_VERSION=v0.0.0 READ_TOKEN=x ENCRYPTION_KEY=x DEMO_API_KEY=x \
  DEMO_SITE_ADDRESS=:80 DEMO_DATA_DIR=/tmp/wsd NTFY_VISIT_TOPIC=t \
  docker compose -f infrastructure/compose.published.yaml -f infrastructure/compose.bundled.yaml \
  -f infrastructure/compose.demo.yaml -f deploy/demo/compose.yaml config --quiet
```

Expected: exit 0 and no output. (`config` reads files only; it builds and starts nothing.)

- [ ] **Step 7: Commit**

```bash
git add deploy/demo/caddy deploy/demo/compose.yaml tests/demo-overlay.test.ts
git commit -m "feat(deploy): Caddy and the compose overlay for the public demo

Only Caddy publishes ports; TLS, noindex, robots.txt, a per-client rate
limit and a JSON access log for the visit notifier. Demo services run the
published demo image; history is backfilled once after bootstrap.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: VM scripts and systemd units

**Files:**
- Create: `deploy/demo/host/lib.sh`, `reset.sh`, `deploy.sh`, `uptime.sh`, `setup.sh`
- Create: `deploy/demo/host/systemd/wayscribe-demo-reset.service`, `.timer`, `wayscribe-demo-uptime.service`, `.timer`, `wayscribe-demo-prune.service`, `.timer`

- [ ] **Step 1: `deploy/demo/host/lib.sh`**

```sh
# Shared by the demo host scripts. POSIX sh, sourced. Every parameter that a
# colon follows is braced ("${var}:x"): these lines get pasted into zsh, which
# reads "$var:x" as a modifier.
DEMO_ENV_FILE="${DEMO_ENV_FILE:-/etc/wayscribe-demo/env}"
DEMO_CHECKOUT="${DEMO_CHECKOUT:-/opt/wayscribe}"
DEMO_LOCK="${DEMO_LOCK:-/run/wayscribe-demo.lock}"
# The cosign the release pipeline signs with (scripts/attest-and-sign.sh).
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8"
REGISTRY="registry.gitlab.com/jojithedev/wayscribe"

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "${DEMO_ENV_FILE}"
  set +a
}

demo_compose() {
  docker compose --env-file "${DEMO_ENV_FILE}" \
    -f "${DEMO_CHECKOUT}/infrastructure/compose.published.yaml" \
    -f "${DEMO_CHECKOUT}/infrastructure/compose.bundled.yaml" \
    -f "${DEMO_CHECKOUT}/infrastructure/compose.demo.yaml" \
    -f "${DEMO_CHECKOUT}/deploy/demo/compose.yaml" "$@"
}

# notify <title> <body>: an alert through ntfy. Logs and drops on failure.
notify() {
  [ -n "${NTFY_ALERT_TOPIC:-}" ] || return 0
  curl --silent --show-error --max-time 10 --output /dev/null \
    -H "Title: $1" -H "Tags: warning" --data "$2" \
    "${NTFY_URL:-https://ntfy.sh}/${NTFY_ALERT_TOPIC}" ||
    echo "ntfy unreachable; alert dropped: $1" >&2
}

# verify_images <tag>: each pulled image's digest is signed by that tag's
# release pipeline. Verified by digest, so what runs is what was verified.
verify_images() {
  for name in api web demo; do
    ref=$(docker image inspect --format '{{index .RepoDigests 0}}' "${REGISTRY}/${name}:$1") ||
      return 1
    if ! docker run --rm "${COSIGN_IMAGE}" verify "${ref}" \
      --certificate-identity "https://gitlab.com/jojithedev/wayscribe//.gitlab-ci.yml@refs/tags/$1" \
      --certificate-oidc-issuer https://gitlab.com >/dev/null; then
      echo "cosign: ${ref} is not signed by the $1 release pipeline" >&2
      return 1
    fi
  done
}

site_url() {
  printf 'https://%s' "${DEMO_SITE_ADDRESS}"
}
```

- [ ] **Step 2: `deploy/demo/host/reset.sh`**

```sh
#!/bin/sh
# Rebuild the demo from nothing: the nightly reset (systemd), and the second
# half of every deploy (deploy.sh). Pull, verify signatures, rebuild Caddy and
# the notifier, wipe every volume, start, and wait for the smoke check.
set -eu
. "$(dirname "$0")/lib.sh"

if [ "${WAYSCRIBE_DEMO_LOCKED:-}" != "1" ]; then
  exec 9>"${DEMO_LOCK}"
  flock -w 900 9 || {
    echo "another reset or deploy holds ${DEMO_LOCK}" >&2
    exit 1
  }
fi
load_env

on_exit() {
  status=$?
  if [ "${status}" -ne 0 ]; then
    notify "Demo ${DEMO_ACTION:-reset} failed" \
      "${DEMO_ACTION:-reset} of ${WAYSCRIBE_VERSION} failed at $(date -u +%H:%M) UTC. A nightly reset retries every 30 minutes, up to three times. journalctl -u wayscribe-demo-reset"
  fi
}
trap on_exit EXIT

demo_compose pull --quiet --ignore-buildable
verify_images "${WAYSCRIBE_VERSION}"
demo_compose build caddy visit-notifier
demo_compose down --volumes --remove-orphans
demo_compose up --detach
sh "${DEMO_CHECKOUT}/deploy/demo/wait-for-smoke.sh" "$(site_url)" 600
```

- [ ] **Step 3: `deploy/demo/host/deploy.sh`** (installed by `setup.sh` as a copy at `/usr/local/sbin/wayscribe-demo-deploy`, so a checkout changing under a running deploy cannot change the script mid-run)

```sh
#!/bin/sh
# The deploy key's forced command (docs/DEMO_HOSTING.md), run through sudo:
#
#   command="sudo -n /usr/local/sbin/wayscribe-demo-deploy \"$SSH_ORIGINAL_COMMAND\"",restrict ssh-ed25519 ...
#
# Takes exactly one release tag. Checks it out, records it, and runs the reset,
# which pulls, verifies signatures and smoke-checks. Rollback is this, run for
# the previous tag; every deploy is a reset, so a database a newer release
# migrated never meets an older one.
set -eu
TAG="${1:-}"
if ! expr "${TAG}" : 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$' >/dev/null; then
  echo "usage: a release tag such as v0.3.0" >&2
  exit 2
fi

CHECKOUT=/opt/wayscribe
ENV_FILE=/etc/wayscribe-demo/env
exec 9>/run/wayscribe-demo.lock
flock -w 900 9 || {
  echo "a reset or deploy is running" >&2
  exit 1
}

git -C "${CHECKOUT}" fetch --quiet --depth 1 origin "refs/tags/${TAG}:refs/tags/${TAG}"
git -C "${CHECKOUT}" -c advice.detachedHead=false checkout --quiet "refs/tags/${TAG}"
sed -i "s/^WAYSCRIBE_VERSION=.*/WAYSCRIBE_VERSION=${TAG}/" "${ENV_FILE}"

WAYSCRIBE_DEMO_LOCKED=1 DEMO_ACTION=deploy exec sh "${CHECKOUT}/deploy/demo/host/reset.sh"
```

- [ ] **Step 4: `deploy/demo/host/uptime.sh`**

```sh
#!/bin/sh
# Every 5 minutes (systemd). Alerts when the demo goes down and when it comes
# back, not on every failed check. Skips while a reset or deploy runs: those
# report their own failures.
set -eu
. "$(dirname "$0")/lib.sh"
DOWN_MARKER=/run/wayscribe-demo.down

exec 9>"${DEMO_LOCK}"
flock -n 9 || exit 0
load_env

if output=$(sh "${DEMO_CHECKOUT}/deploy/demo/smoke-check.sh" "$(site_url)" 2>&1); then
  if [ -e "${DOWN_MARKER}" ]; then
    rm -f "${DOWN_MARKER}"
    notify "Demo recovered" "${output}"
  fi
  exit 0
fi

if [ ! -e "${DOWN_MARKER}" ]; then
  : >"${DOWN_MARKER}"
  notify "Demo is down" "${output}"
fi
exit 1
```

- [ ] **Step 5: `deploy/demo/host/setup.sh`** (Jorge runs it once on the VM; Task 20)

```sh
#!/bin/sh
# One-time setup of the demo VM: a fresh Ubuntu 24.04 Hetzner CX22, as root.
#
#   sh setup.sh "<deploy public key>" <release tag>
#
# Generates the secrets here, into a root-only file, and never prints them.
# Rerun it after a release changes deploy.sh or the systemd units; it keeps an
# existing env file.
set -eu
DEPLOY_KEY="${1:?usage: setup.sh \"<deploy public key>\" <release tag>}"
TAG="${2:?usage: setup.sh \"<deploy public key>\" <release tag>}"
if ! expr "${TAG}" : 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$' >/dev/null; then
  echo "the second argument must be a release tag such as v0.3.0" >&2
  exit 2
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends docker.io docker-compose-v2 git curl openssl ufw
systemctl enable --now docker

# Keys only. Docker-published ports bypass ufw; only Caddy publishes, on 80/443.
cat >/etc/ssh/sshd_config.d/10-wayscribe-demo.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh
ufw default deny incoming
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

CHECKOUT=/opt/wayscribe
if [ ! -d "${CHECKOUT}/.git" ]; then
  git clone --quiet --depth 1 --branch "${TAG}" https://gitlab.com/jojithedev/wayscribe.git "${CHECKOUT}"
fi

install -d -m 0700 /etc/wayscribe-demo /var/lib/wayscribe-demo
install -d -m 0700 /var/lib/wayscribe-demo/caddy-data /var/lib/wayscribe-demo/caddy-config
install -d -m 0755 /var/lib/wayscribe-demo/caddy-logs

if [ ! -f /etc/wayscribe-demo/env ]; then
  umask 077
  cat >/etc/wayscribe-demo/env <<EOF
WAYSCRIBE_VERSION=${TAG}
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
READ_TOKEN=$(openssl rand -hex 32)
DEMO_API_KEY=wsk_$(openssl rand -hex 16)
DEMO_SITE_ADDRESS=demo.wayscribe.dev
DEMO_DATA_DIR=/var/lib/wayscribe-demo
NTFY_URL=https://ntfy.sh
NTFY_VISIT_TOPIC=wayscribe-demo-visits-$(openssl rand -hex 8)
NTFY_ALERT_TOPIC=wayscribe-demo-alerts-$(openssl rand -hex 8)
EOF
  umask 022
fi

id wayscribe-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/sh wayscribe-deploy
install -d -m 0700 -o wayscribe-deploy -g wayscribe-deploy /home/wayscribe-deploy/.ssh
cat >/home/wayscribe-deploy/.ssh/authorized_keys <<EOF
command="sudo -n /usr/local/sbin/wayscribe-demo-deploy \"\$SSH_ORIGINAL_COMMAND\"",restrict ${DEPLOY_KEY}
EOF
chown wayscribe-deploy:wayscribe-deploy /home/wayscribe-deploy/.ssh/authorized_keys
chmod 0600 /home/wayscribe-deploy/.ssh/authorized_keys
install -m 0755 "${CHECKOUT}/deploy/demo/host/deploy.sh" /usr/local/sbin/wayscribe-demo-deploy
echo 'wayscribe-deploy ALL=(root) NOPASSWD: /usr/local/sbin/wayscribe-demo-deploy' \
  >/etc/sudoers.d/wayscribe-demo-deploy
chmod 0440 /etc/sudoers.d/wayscribe-demo-deploy
visudo -cf /etc/sudoers.d/wayscribe-demo-deploy

install -m 0644 "${CHECKOUT}"/deploy/demo/host/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wayscribe-demo-reset.timer wayscribe-demo-uptime.timer wayscribe-demo-prune.timer

sh "${CHECKOUT}/deploy/demo/host/reset.sh"
echo "Demo is up. Subscribe to the two ntfy topics named NTFY_VISIT_TOPIC and NTFY_ALERT_TOPIC in /etc/wayscribe-demo/env."
```

- [ ] **Step 6: systemd units** in `deploy/demo/host/systemd/`

`wayscribe-demo-reset.service`:

```ini
[Unit]
Description=Reset the Wayscribe public demo to generated data
Wants=network-online.target
After=docker.service network-online.target
# The first run and three retries, 30 minutes apart.
StartLimitIntervalSec=3h
StartLimitBurst=4

[Service]
Type=oneshot
ExecStart=/bin/sh /opt/wayscribe/deploy/demo/host/reset.sh
Restart=on-failure
RestartSec=30min
TimeoutStartSec=30min
```

`wayscribe-demo-reset.timer`:

```ini
[Unit]
Description=Reset the Wayscribe public demo nightly at 04:00 UTC

[Timer]
OnCalendar=*-*-* 04:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

`wayscribe-demo-uptime.service`:

```ini
[Unit]
Description=Smoke-check the Wayscribe public demo
After=docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh /opt/wayscribe/deploy/demo/host/uptime.sh
```

`wayscribe-demo-uptime.timer`:

```ini
[Unit]
Description=Smoke-check the Wayscribe public demo every 5 minutes

[Timer]
OnCalendar=*:0/5
Persistent=false

[Install]
WantedBy=timers.target
```

`wayscribe-demo-prune.service`:

```ini
[Unit]
Description=Prune unused Docker images on the demo VM
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker image prune --all --force --filter until=168h
```

`wayscribe-demo-prune.timer`:

```ini
[Unit]
Description=Prune unused Docker images weekly

[Timer]
OnCalendar=Sun *-*-* 05:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 7: Check** — `for f in deploy/demo/host/*.sh; do sh -n "$f" || exit 1; done && chmod +x deploy/demo/host/*.sh`; `shellcheck deploy/demo/host/*.sh` if installed (must be clean apart from the annotated `SC1090`). If `systemd-analyze` is available (Linux), `systemd-analyze verify deploy/demo/host/systemd/*` must print nothing about syntax.

- [ ] **Step 8: Commit**

```bash
git add deploy/demo/host
git commit -m "feat(deploy): demo VM setup, reset, deploy, uptime and prune

Every deploy is a reset; images are verified by digest with the release's
cosign; the nightly reset retries every 30 minutes up to three times and
alerts each failure; uptime alerts on state change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: CI — publish the demo image, the overlay job, the deploy job

**Files:**
- Modify: `.gitlab-ci.yml` (`publish-images` script ~line 820, `publish-images-rehearsal` script ~line 860; add two jobs after `demo:` and after `publish-images-rehearsal`)
- Create: `deploy/demo/ci/overlay-test.sh`

- [ ] **Step 1: Publish the demo image**

In `publish-images`' script, add a third argument, and update the comment "Both images are pushed…" to "Every image is pushed…":

```yaml
    - >-
      scripts/publish-image.sh "$CI_COMMIT_TAG"
      "apps/api/Dockerfile=$CI_REGISTRY_IMAGE/api"
      "apps/web/Dockerfile=$CI_REGISTRY_IMAGE/web"
      "apps/demo/Dockerfile=$CI_REGISTRY_IMAGE/demo"
```

and the same third line in `publish-images-rehearsal` with `$CI_REGISTRY_IMAGE/rehearsal/demo`.

- [ ] **Step 2: Write `deploy/demo/ci/overlay-test.sh`**

```sh
#!/bin/sh
# CI: the public demo overlay from images built here, behind a local Caddy on
# plain HTTP, under the docker:dind service. Proves the smoke check passes, that
# nothing but Caddy is reachable from outside the Compose network, that robots
# are told to stay out, that the rate limit bites, and that the visit notifier
# runs on Node 22.12 and drops a message when ntfy is unreachable.
#
# Generated secrets live in a temp file and are never printed.
set -eu

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
VERSION="${WAYSCRIBE_VERSION:?set WAYSCRIBE_VERSION}"
HOST="${DEMO_TEST_HOST:-docker}"
REGISTRY=registry.gitlab.com/jojithedev/wayscribe
ENV_FILE=$(mktemp)
trap 'rm -f "${ENV_FILE}"' EXIT

fail() {
  echo "overlay-test: $1" >&2
  exit 1
}

for name in api web demo; do
  docker build --quiet -f "${ROOT}/apps/${name}/Dockerfile" -t "${REGISTRY}/${name}:${VERSION}" "${ROOT}" >/dev/null
done

umask 077
cat >"${ENV_FILE}" <<EOF
WAYSCRIBE_VERSION=${VERSION}
ENCRYPTION_KEY=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
READ_TOKEN=$(openssl rand -hex 32)
DEMO_API_KEY=wsk_$(openssl rand -hex 16)
DEMO_SITE_ADDRESS=:80
DEMO_DATA_DIR=/tmp/wayscribe-demo-data
NTFY_URL=http://127.0.0.1:9
NTFY_VISIT_TOPIC=ci-never-sent
EOF
umask 022

compose() {
  docker compose --env-file "${ENV_FILE}" \
    -f "${ROOT}/infrastructure/compose.published.yaml" \
    -f "${ROOT}/infrastructure/compose.bundled.yaml" \
    -f "${ROOT}/infrastructure/compose.demo.yaml" \
    -f "${ROOT}/deploy/demo/compose.yaml" "$@"
}

compose config --quiet
compose up --detach
sh "${ROOT}/deploy/demo/wait-for-smoke.sh" "http://${HOST}" 600

# 1. Nothing but Caddy answers from outside the Compose network...
for port in 3000 3100 3200 3300 5432 8080 9324; do
  if curl --silent --max-time 5 --output /dev/null "http://${HOST}:${port}/"; then
    fail "port ${port} is reachable from outside the Compose network"
  fi
done
# ...while the API is up inside it, so the refusals above are the network's.
inside=$(compose exec -T caddy wget -qO- http://api:8080/health) || fail "the API does not answer inside the network"
case "${inside}" in
  *'"ok"'*) ;;
  *) fail "the API's /health inside the network said: ${inside}" ;;
esac

# 2. Robots stay out.
headers=$(curl --silent --show-error --head --user-agent wayscribe-smoke/1 "http://${HOST}/")
case "${headers}" in
  *[Xx]-[Rr]obots-[Tt]ag:*noindex*) ;;
  *) fail "no X-Robots-Tag: noindex on the home page" ;;
esac
robots=$(curl --silent --show-error --user-agent wayscribe-smoke/1 "http://${HOST}/robots.txt")
case "${robots}" in
  *"Disallow: /"*) ;;
  *) fail "robots.txt does not disallow everything" ;;
esac

# 3. A browser visit reaches the notifier, which runs on Node 22.12 and, with
#    ntfy unreachable, logs and drops the message.
curl --silent --output /dev/null \
  --user-agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15" \
  "http://${HOST}/"
dropped=no
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  logs=$(compose logs visit-notifier 2>&1)
  case "${logs}" in
    *"message dropped"*) dropped=yes; break ;;
  esac
  sleep 2
done
[ "${dropped}" = yes ] || fail "the visit notifier never reported a dropped message: ${logs}"
case "${logs}" in
  *"visit-notifier: watching"*) ;;
  *) fail "the visit notifier did not start" ;;
esac

# 4. The rate limit bites within one minute's allowance.
limited=no
i=0
while [ "${i}" -lt 400 ]; do
  code=$(curl --silent --output /dev/null --write-out '%{http_code}' --user-agent wayscribe-smoke/1 "http://${HOST}/health")
  if [ "${code}" = 429 ]; then
    limited=yes
    break
  fi
  i=$((i + 1))
done
[ "${limited}" = yes ] || fail "400 requests in a burst never met a 429"

echo "overlay-test: ok"
```

- [ ] **Step 3: Add the `demo-overlay` job** after the `demo:` job

```yaml
# The public demo's overlay (deploy/demo) from images built in this pipeline,
# behind a local Caddy on plain HTTP: the smoke check, no reachable port but
# Caddy's, noindex, the rate limit, and the visit notifier on Node 22.12.
# A new job: it must pass on two consecutive pipelines before it is trusted,
# because a first run has no cache and hides cache-state failures.
demo-overlay:
  stage: demo
  image: node:24-alpine
  services:
    - docker:dind
  variables:
    DOCKER_HOST: tcp://docker:2375
    DOCKER_TLS_CERTDIR: ""
    WAYSCRIBE_VERSION: "ci-$CI_COMMIT_SHORT_SHA"
    DEMO_TEST_HOST: docker
  # Five image builds, Caddy's a Go build, without a layer cache.
  timeout: 45m
  cache: {}
  before_script:
    - apk add --no-cache docker-cli docker-cli-compose curl openssl
  rules:
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/
    - if: $CI_COMMIT_BRANCH
      changes:
        - deploy/demo/**/*
        - apps/demo/**/*
        - apps/web/**/*
        - apps/api/src/**/*
        - infrastructure/compose.*.yaml
    - if: $CI_COMMIT_BRANCH
      when: manual
      allow_failure: true
  script:
    - sh deploy/demo/ci/overlay-test.sh
  after_script:
    - docker compose -p wayscribe down --volumes --remove-orphans
```

- [ ] **Step 4: Add the `deploy-demo` job** after `publish-images-rehearsal`

```yaml
# Deploy a release to demo.wayscribe.dev (docs/DEMO_HOSTING.md). Manual, on a
# protected v* tag only, after its images are published. The key is in a
# protected, masked variable (base64, because a multi-line key cannot be
# masked), and on the VM it can run one command: the deploy script, which
# takes the tag, verifies the images with cosign, resets the demo and runs the
# smoke check. This job runs the smoke check again from outside. Rollback is
# this job played on the previous tag's pipeline. Play it on every release, so
# the path stays exercised.
deploy-demo:
  stage: release
  image: alpine:3.22
  needs: ["publish-images"]
  <<: *release-rules
  when: manual
  resource_group: demo
  cache: {}
  before_script:
    - apk add --no-cache openssh-client curl
  script:
    - test -n "$DEMO_DEPLOY_SSH_KEY_B64" && test -n "$DEMO_SSH_KNOWN_HOSTS"
    - install -d -m 0700 "$HOME/.ssh"
    - printf '%s' "$DEMO_DEPLOY_SSH_KEY_B64" | base64 -d > "$HOME/.ssh/demo_deploy"
    - chmod 0600 "$HOME/.ssh/demo_deploy"
    - printf '%s\n' "$DEMO_SSH_KNOWN_HOSTS" > "$HOME/.ssh/known_hosts"
    - >-
      ssh -i "$HOME/.ssh/demo_deploy" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
      -o UserKnownHostsFile="$HOME/.ssh/known_hosts"
      wayscribe-deploy@demo.wayscribe.dev "$CI_COMMIT_TAG"
    - sh deploy/demo/smoke-check.sh https://demo.wayscribe.dev
  after_script:
    - rm -f "$HOME/.ssh/demo_deploy"
```

(Match the existing `publish-images` pattern exactly for how `<<: *release-rules` and `when: manual` sit together; if the pipeline editor's lint rejects `when` beside `rules`, move `when: manual` into the rule: `rules: [{ if: '$CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/', when: manual }]`.)

- [ ] **Step 5: Lint the CI file**

Run: `glab ci lint .gitlab-ci.yml` (or the project's CI Lint page). Expected: valid. Then `pnpm test` (the whole unit suite, since tests read `.gitlab-ci.yml`).

- [ ] **Step 6: Commit and run the overlay job twice**

```bash
chmod +x deploy/demo/ci/overlay-test.sh
git add .gitlab-ci.yml deploy/demo/ci/overlay-test.sh
git commit -m "ci: publish the demo image, test the demo overlay, deploy the demo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

Watch the branch pipeline's `demo-overlay` job with a deadline (poll at most every 60 s, give up after 60 minutes, and report). When it passes, start a second pipeline on the same commit (`glab ci run --branch <branch>` or "Run pipeline") and wait for `demo-overlay` to pass again. Both must be green. Also play `publish-images-rehearsal` on the branch once: it now builds three images, and the rehearsal is how a changed `publish-images` gets exercised before a tag.

---

### Task 19: Decisions, operations docs, and DEMO_HOSTING.md

**Files:**
- Modify: `docs/DECISIONS.md` (append ADR-069, ADR-070), `docs/ROADMAP.md` (lines 94-101 and 170-172), `docs/API_SPEC.md` (§1 Conventions, after the admin-token block ~line 26), `docs/OPERATIONS.md` (lines 697 and 719-722), `docs/SECURITY.md` (line 535), `CHANGELOG.md` (`[Unreleased]`)
- Create: `docs/DEMO_HOSTING.md`

- [ ] **Step 1: Append to `docs/DECISIONS.md`**

```markdown
## ADR-069: The public demo holds generated data only and accepts nothing from visitors

**Status:** Accepted, 2026-10-07. Clarifies the scope of `AGENTS.md`'s "hosted SaaS
infrastructure" and `docs/ROADMAP.md`'s "Not doing" entry for a hosted offering; both stand.

**Context.** Prospects, larger companies and government agencies among them, need to see
Wayscribe work in under a minute, from a link, without installing it. The reason Wayscribe
has no hosted offering is that it must never be custodian of customer payloads.

**Decision.** demo.wayscribe.dev runs the latest release on one small VM, from the published
Compose files plus an overlay in `deploy/demo/`. Every journey on it is generated: about 300
backfilled over the past five days, one new one a minute, and one pinned failed journey for
`+1 555 0100`, all written by the demo app with its own API key. A visitor can search and
read and can do nothing else: the web app runs in anonymous read-only mode (ADR-070), and no
route a visitor can reach ingests, replays or deletes. Nothing a visitor sends is stored
other than Caddy's access log, kept 7 days, and the visit notifications the operator
receives. The data is wiped and regenerated every night. The demo's pieces live in
`deploy/demo/` and a `demo` image; nothing in `infrastructure/` or `deploy/helm` that a
customer installs carries them.

**Consequences.** The demo never holds customer data, so the custody argument against a
hosted offering is untouched. The demo image is published and signed beside `api` and `web`.
A deploy is a manual job on a protected `v*` tag, and every deploy is a full reset.

**Rejected.** A managed Kubernetes cluster (cost, for a demo; the managed-cluster test of the
Helm chart stays on the roadmap). Visitor-triggered journeys (a visitor would supply data).
A per-visitor instance (cost and complexity for no gain over read-only).

## ADR-070: A reader principal reads one project, payloads included, and may call only allowlisted routes

**Status:** Accepted, 2026-10-07. Adds a third principal to ADR-029. Amends ADR-065 item 6:
that item's view-only capability excluded payloads; this one reads them. A payload-free
viewer is left to the SSO roles work.

**Context.** The public demo (ADR-069) needs a visitor to read the field diff that shows
where a value was lost, which is a payload. An admin token in a public web app would also
grant replay and deletion.

**Decision.** `READ_TOKEN` (at least 32 characters, never equal to `ADMIN_TOKEN`, readable
from `READ_TOKEN_FILE`, checked against the published defaults) resolves to a **reader**. A
reader's read scope is an admin's: one named project, or the only one, across all its
environments. A reader may call only the routes in `apps/api/src/reader-routes.ts`:
`GET /v1/projects`, `/v1/search`, `/v1/journeys`, `/v1/journeys/:journeyId`,
`/v1/journeys/:journeyId/events`, `/v1/events/:eventId`, and the credential-free `/health`
and `/ready`. A root `onRequest` guard answers every other route with 403 `forbidden` before
it runs, including routes added later, until they are allowlisted on purpose; a test calls
every registered route with the read token. A reader may list every project's name, as an
admin may, because the web app chooses the project from that list. No read is audited, and a
reader's refused requests write nothing.

The web app's `WEB_ANONYMOUS_READ_ONLY=true` signs every visitor in as a reader without a
login page. It holds only the read token and refuses to start if `ADMIN_TOKEN` is set too.
Its sessions are signed with a key derived from `READ_TOKEN` under the HKDF label
`wayscribe/web-session-anonymous-reader`, so a session from one mode never verifies in the
other. Replay and delete are hidden by the session's principal, not by the setting. `doctor`
warns while the setting is on.

**Consequences.** Anyone holding the read token can read every payload of the project. It is
for public demos of generated data, and for internal viewers who are trusted with payloads.

**Rejected.** Hiding controls in the web app with an admin token behind it (enforced in the
browser, not the API). A denylist of write routes (a new route would be open by default).
```

- [ ] **Step 2: `docs/ROADMAP.md`**

Replace the item at line 170:

```markdown
- ~~a read-only principal: journeys and timelines without payloads~~ **Built**, with one
  difference: the reader (`READ_TOKEN`, ADR-070) reads payloads, because the public demo's
  value is the diff. A payload-free viewer is left for the SSO roles work.
```

In the paragraph at lines 94-101, after "The ingestion controls and the view-only capability are not built yet.", add: "The reader principal (ADR-070) is related but reads payloads, so it does not discharge the payload-free capability ADR-065 describes."

- [ ] **Step 3: `docs/API_SPEC.md`** — after the "Authentication for reads, with the admin token" block in §1:

````markdown
Authentication for reads, with the read token:

```text
Authorization: Bearer <read-token>
```

The read token (`READ_TOKEN`, ADR-070) reads exactly what the admin token reads, payloads
included, on `GET /v1/projects`, `/v1/search`, `/v1/journeys`, `/v1/journeys/{journeyId}`,
`/v1/journeys/{journeyId}/events` and `/v1/events/{eventId}`. Every other route answers it
with `403` and the code `forbidden`, before the route runs.
````

- [ ] **Step 4: `docs/OPERATIONS.md`** — in the table row at line 697, change the list to "`ENCRYPTION_KEY_FILE`, `ENCRYPTION_KEY_PREVIOUS_FILE`, `ADMIN_TOKEN_FILE` and `READ_TOKEN_FILE`", and the same list in the paragraph at line 719. After that paragraph add:

```markdown
`READ_TOKEN` is optional. Set, it lets a reader principal search and read one project,
payloads included, and nothing else (ADR-070); it must differ from `ADMIN_TOKEN`. The web
app's `WEB_ANONYMOUS_READ_ONLY=true` signs every visitor in as that reader with no login;
it needs `READ_TOKEN`, refuses to start with `ADMIN_TOKEN` set, and is meant for a public
demo of generated data only (`docs/DEMO_HOSTING.md`). `doctor` warns while it is on.
```

- [ ] **Step 5: `docs/SECURITY.md`** line 535 — add `READ_TOKEN_FILE` to the list as in Step 4.

- [ ] **Step 6: `CHANGELOG.md`** — under `## [Unreleased]`, add:

```markdown
### Added

- A reader principal: `READ_TOKEN` (or `READ_TOKEN_FILE`) searches and reads one project,
  payloads included, and every other route answers it 403 (ADR-070).
- `WEB_ANONYMOUS_READ_ONLY=true` signs every web visitor in as a reader with no login, for
  a public demo of generated data. `doctor` warns while it is on.
- A `demo` image is published and signed beside `api` and `web`, and the public demo's
  deployment lives in `deploy/demo/` (ADR-069, `docs/DEMO_HOSTING.md`).
```

- [ ] **Step 7: Create `docs/DEMO_HOSTING.md`**

````markdown
# Hosting the public demo

demo.wayscribe.dev is a live, read-only Wayscribe holding generated data only (ADR-069).
This is how it is built, run, reset, deployed and rebuilt from nothing. Nothing here is
needed to run Wayscribe yourself.

## What runs

One Hetzner CX22 VM (2 vCPU, 4 GB, Ubuntu 24.04) runs, with Docker Compose:

- the published `api` and `web` images of one release, and the published `demo` image for
  the demo services, all verified with cosign before they start;
- PostgreSQL and ElasticMQ, with no host ports;
- Caddy, the only thing listening on the internet (80 and 443), with a certificate it
  obtains itself, a per-client rate limit, `X-Robots-Tag: noindex`, a `robots.txt` that
  disallows everything, and a JSON access log kept 7 days;
- `demo-history`, which once per reset writes the pinned failed journey for `+1 555 0100`
  and about 300 journeys over the past five days;
- `demo-source` in loop mode, one new customer a minute, about a fifth of them failing;
- `visit-notifier`, which reads Caddy's log and posts one ntfy message per new visitor.

The web app runs with `WEB_ANONYMOUS_READ_ONLY=true` and holds only `READ_TOKEN`, so every
visitor is a reader (ADR-070). The files are `infrastructure/compose.published.yaml`,
`compose.bundled.yaml`, `compose.demo.yaml` and `deploy/demo/compose.yaml`, in that order.

## Secrets

Generated on the VM by `deploy/demo/host/setup.sh` into `/etc/wayscribe-demo/env`
(root-only, mode 0600) and never committed or printed: `ENCRYPTION_KEY`, `ADMIN_TOKEN` (for
the CLI and `doctor` on the box; the web app does not hold it), `READ_TOKEN`,
`DEMO_API_KEY`, and the two ntfy topic names. They are separate from the CI variables,
which hold only the deploy key and the VM's host key.

## Reset

`wayscribe-demo-reset.timer` runs `deploy/demo/host/reset.sh` at 04:00 UTC: pull, verify
signatures, rebuild Caddy and the notifier, `down --volumes`, `up`, then wait up to ten
minutes for the smoke check. A failure alerts through ntfy and systemd retries every 30
minutes, up to three times, alerting each time. A reset that fails every retry leaves the
demo empty until fixed by hand; that is an accepted risk for a demo. Caddy's certificate
and the access log are host directories under `/var/lib/wayscribe-demo`, so a reset keeps
them. `wayscribe-demo-prune.timer` prunes unused images weekly.

## Uptime

`wayscribe-demo-uptime.timer` runs the smoke check (`deploy/demo/smoke-check.sh`) every 5
minutes and alerts when the demo goes down and when it recovers. The smoke check loads the
home page, searches `+1 555 0100`, and opens the pinned journey's transform step, checking
for the diff. It sends `User-Agent: wayscribe-smoke/1`, which the visit notifier ignores. It
skips while a reset or deploy is running. It cannot notice the VM itself going away; an
external HTTP monitor does that (optional step J6).

## Deploy and rollback

Play `deploy-demo` on a release tag's pipeline, after `publish-images`. It connects as
`wayscribe-deploy`, whose key can run only `/usr/local/sbin/wayscribe-demo-deploy <tag>`;
that checks out the tag, records `WAYSCRIBE_VERSION`, and runs the reset. The job then runs
the smoke check from outside and fails if it fails. **Rollback** is the same job played on
the previous tag's pipeline. Every deploy is a reset, so a database a newer release migrated
never meets an older one. Play it on every release, so the path stays exercised. If a
release changes `deploy/demo/host/deploy.sh` or the systemd units, rerun `setup.sh` on the
VM after deploying it (it keeps the existing env file).

## Visit notifications

One ntfy message per visit: the time in New York, the landing path without its query, the
referrer's host or "direct", and the browser and OS family. A visit is a page request (not
an asset, API, health or error response) from a client not seen in 6 hours. The client is a
hash of address and user agent under a salt held only in memory and replaced daily; no
address is stored. Search terms are never sent. At most 10 messages an hour, then one
"muted until" notice and, when the hour ends, a summary. If ntfy is unreachable the message
is logged and dropped; Caddy is never slowed.

## Rebuild from nothing

1. Jorge: steps J1 to J5 below.
2. On the VM as root: `git clone --depth 1 --branch <tag> https://gitlab.com/jojithedev/wayscribe.git /opt/wayscribe`
   then `sh /opt/wayscribe/deploy/demo/host/setup.sh "<deploy public key>" <tag>`.
3. Check `https://demo.wayscribe.dev` loads and shows the banner, and run
   `sh /opt/wayscribe/deploy/demo/smoke-check.sh https://demo.wayscribe.dev`.

## Jorge's manual steps

These need Jorge's accounts. Nothing automated performs them.

- **J1. VM.** Create the Hetzner account and a CX22 VM with Ubuntu 24.04, with your personal
  SSH public key. In the Hetzner Cloud Firewall allow inbound TCP 22, 80 and 443, and UDP
  443. Note its IPv4 and IPv6 addresses.
- **J2. DNS.** In Cloudflare, add `demo.wayscribe.dev` as an A record (and AAAA) to the VM,
  **DNS only (grey cloud), not proxied**, so Caddy obtains and serves its own certificate.
- **J3. Deploy key and setup.** On your machine: `ssh-keygen -t ed25519 -N "" -C wayscribe-demo-deploy -f demo-deploy`.
  On the VM, run the "Rebuild from nothing" step 2 with the contents of `demo-deploy.pub`
  and the release tag.
- **J4. CI variables.** In GitLab (Settings, CI/CD, Variables), add
  `DEMO_DEPLOY_SSH_KEY_B64` = `base64 < demo-deploy | tr -d '\n'`, **protected and
  masked**, and `DEMO_SSH_KNOWN_HOSTS` = the output of `ssh-keyscan -t ed25519 demo.wayscribe.dev`,
  protected, after checking its fingerprint against the one the VM's console shows
  (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Then delete the local private key
  file if you do not want a second copy.
- **J5. ntfy.** On the VM, `sudo sed -n 's/^NTFY_\(VISIT\|ALERT\)_TOPIC=//p' /etc/wayscribe-demo/env`
  prints the two topic names; subscribe to both in the ntfy app on your phone.
- **J6 (optional). External monitor.** Point a free HTTP keyword monitor at
  `https://demo.wayscribe.dev/` looking for "Public demo. Read-only, sample data.", with
  user agent `wayscribe-smoke/1`, to hear about the VM itself going down.
````

- [ ] **Step 8: Run the FULL unit suite** (docs pin claims across files)

Run: `pnpm test && pnpm format:check && pnpm lint`
Expected: PASS. If `tests/docs-links.test.ts` or `tests/docs-claims.test.ts` fails on the new document, fix the document (a broken link, an unpinned claim), not the test. If `tests/site.test.ts` requires every doc to be either published in `site/docs-manifest.json` or explicitly excluded, follow its message.

- [ ] **Step 9: Commit**

```bash
git add docs CHANGELOG.md
git commit -m "docs: ADR-069 public demo boundary, ADR-070 reader principal, demo hosting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: Jorge's manual steps (STOP)

- [ ] **Step 1: JORGE ONLY — J1 to J5 in `docs/DEMO_HOSTING.md`.** The executor stops here and reports: "Waiting on Jorge for demo hosting steps J1 to J5 (VM, DNS, deploy key and setup, CI variables, ntfy)." Do not create accounts, run `setup.sh`, add DNS records, or set CI variables.

- [ ] **Step 2: Merge decision.** Jorge reviews and merges the branch (the plan does not merge to `main`).

---

### Task 21: First deploy (GATE)

- [ ] **Step 1: JORGE ONLY — tag a release** that contains Tasks 2 to 19, and play `publish-images` on its pipeline. `setup.sh` (J3) runs against that tag.

- [ ] **Step 2: JORGE ONLY — play `deploy-demo`** on the same tag pipeline. It must pass (the remote reset's smoke check and the job's own).

- [ ] **Step 3: Verify from outside (executor, read-only)** — from any machine: `sh deploy/demo/smoke-check.sh https://demo.wayscribe.dev` → `smoke-check: ok`. Load the page in the browser pane, confirm the banner, search `+1 555 0100`, open the failed journey, select the transform step, and see the phone diff. Confirm `curl --silent --head https://demo.wayscribe.dev/` (captured, then matched) carries `x-robots-tag: noindex, nofollow`. **GATE:** if any of this fails, stop and report; Task 22 must not run, because it publishes links to the demo.

---

### Task 22: Public links (after the demo is live)

**Files:**
- Modify: `site/src/content/docs/index.mdx` (hero `actions`, lines 12-18; after `</figure>`)
- Modify: `README.md` (one line after the opening paragraph)
- Modify: `tests/site.test.ts` (one case in the landing `describe`)

- [ ] **Step 1: Write the failing site test** — add inside the `describe` that holds "shows the captioned demo…":

```ts
  it("links the live demo from the hero and beside the video", () => {
    const hero = landing.slice(landing.indexOf("actions:"), landing.indexOf("---", 4));
    expect(hero).toContain("text: Live demo");
    expect(hero).toContain("link: https://demo.wayscribe.dev");
    const afterVideo = landing.slice(landing.indexOf("</figure>"), landing.indexOf("## What it does"));
    expect(afterVideo).toContain("https://demo.wayscribe.dev");
  });
```

- [ ] **Step 2: Run to see it fail** — `pnpm vitest run tests/site.test.ts` → FAIL.

- [ ] **Step 3: Edit the landing page**

Hero actions become:

```yaml
  actions:
    - text: Install 0.2.2
      link: /docs/quick-start/#install-022-without-a-checkout
      icon: right-arrow
    - text: Live demo
      link: https://demo.wayscribe.dev
      icon: external
      variant: secondary
    - text: Watch the demo
      link: "#watch-the-demo"
      variant: minimal
```

(Keep the install version text as it is on `main` at the time; only the middle entry is new.)

After `</figure>`:

```mdx
Or [open the live demo](https://demo.wayscribe.dev): read-only, sample data, no sign-in.
Search `+1 555 0100`.
```

README, after the first paragraph:

```markdown
**Live demo:** [demo.wayscribe.dev](https://demo.wayscribe.dev), read-only with sample data and no sign-in.
```

- [ ] **Step 4: Run the FULL unit suite** — `pnpm test && pnpm format:check` → PASS. Then, in `site/`, run the site build the `site` CI job runs (its link check covers the new external link's syntax).

- [ ] **Step 5: Commit**

```bash
git add site/src/content/docs/index.mdx README.md tests/site.test.ts
git commit -m "docs(site): link the live demo from the landing page and README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec item | Task |
| --- | --- |
| Reader principal, `READ_TOKEN` ≥32, `READ_TOKEN_FILE`, insecure-defaults | 2, 3 |
| Allowlist, 403 for everything else incl. future routes | 4 (property test), 5 |
| Reader not audited; refused writes leave no `audit_events` | 5 |
| Read token never in the browser | 7 (`apiToken` server-side only), 8 |
| `WEB_ANONYMOUS_READ_ONLY`, HKDF from `READ_TOKEN` with distinct label, refuse start without `READ_TOKEN` | 7, 8 |
| Banner with pilot address and wayscribe.dev; landing hint for `+1 555 0100` | 9 |
| Replay/delete hidden by principal | 9 |
| Mode off unchanged | 7, 8 (existing tests kept green) |
| `doctor` warning | 6 |
| Loop ~60 s, ~20% failure | 10 (`loopAccount`), 12 |
| Backfill ~300 over 5 days; retention check first | 1 (gate), 10, 11 |
| Pinned `+1 555 0100` journey, recreated each reset | 10, 11, 16 |
| Dedupe on normalized form | 10 |
| Overlay, Caddy TLS, only web reachable, rate limit, statement timeout kept, noindex, robots, restart | 16 (statement timeout: unchanged from `compose.published.yaml`'s default 15000) |
| Hetzner, firewall 22/80/443, secrets on the VM, nightly reset, weekly prune | 17, 19, 20 |
| `deploy-demo`: manual, protected tags, SSH key protected+masked, cosign, smoke, rollback | 17, 18 |
| Smoke check shared, `wayscribe-smoke/1` | 13, 17, 18 |
| Visit notifier: rules, salt, filters, cap, NY time, ntfy drop, own topic, 7-day log | 14, 15, 16 |
| Failure handling: uptime every 5 min, reset retries ×3 with alerts | 17 |
| CI overlay test incl. API port unreachable; pass twice | 18 |
| Site button, README line, DEMO_HOSTING.md, two ADRs, ROADMAP | 19, 22 |
| Full unit suite for doc changes | 19, 22 |
| Jorge's manual steps marked and stopped at | 19 (doc), 20, 21 |
````
