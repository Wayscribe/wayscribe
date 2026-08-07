# Phase 2b-ii: Web Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer opens the browser, logs in with the admin token, searches a customer, and sees the exact transformation where `phone` became `null`.

**Architecture:** Four server-rendered routes in `apps/web`. The browser never contacts the API; server components call it with the admin token through one typed client. Event selection lives in the URL. Plain CSS modules, no framework.

**Tech Stack:** Next.js 15 App Router, React 19, Zod 4, Playwright, Vitest.

**Source spec:** `docs/superpowers/specs/2026-08-07-phase-2b-ii-interface-design.md`

---

## Conventions

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
```

**Run `pnpm lint` and `pnpm typecheck` before every commit.**

`apps/web` has no `typecheck` script by design — `next build` type checks the app. Lint
covers it through the root ESLint config, where `.tsx` files are exempt from
`explicit-function-return-type`.

Unit tests live under `apps/web/src/**` so the root Vitest include picks them up.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/config.ts` | Zod-parsed `ADMIN_TOKEN`, `API_URL` |
| `apps/web/src/lib/api.ts` | Typed API client; the only module knowing the contract |
| `apps/web/src/lib/session.ts` | Exists (2b-i) |
| `apps/web/src/lib/login-limiter.ts` | Exists (2b-i) |
| `apps/web/middleware.ts` | Auth gate |
| `apps/web/app/login/page.tsx` | Token form |
| `apps/web/app/api/login/route.ts` | Verify, throttle, set cookie |
| `apps/web/app/page.tsx` | Search |
| `apps/web/app/journeys/[journeyId]/page.tsx` | Timeline and detail |
| `apps/web/app/components/*.tsx` | Timeline, EventDetail, DiffTable, Explain |
| `apps/web/app/globals.css` | Design tokens |
| `apps/web/e2e/*.spec.ts` | Playwright |

---

## Task 1: Config and API client

**Files:**
- Create: `apps/web/src/lib/config.ts`, `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { loadWebConfig } from "./config.js";

const valid = { ADMIN_TOKEN: "admin-token-for-tests-0000000000", API_URL: "http://api:8080" };

describe("loadWebConfig", () => {
  it("parses a valid environment", () => {
    expect(loadWebConfig(valid).API_URL).toBe("http://api:8080");
  });

  it("names a missing variable", () => {
    const { API_URL: _omitted, ...without } = valid;
    expect(() => loadWebConfig(without)).toThrow(/API_URL/);
  });

  it("rejects a short admin token", () => {
    expect(() => loadWebConfig({ ...valid, ADMIN_TOKEN: "short" })).toThrow(/ADMIN_TOKEN/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run apps/web`
Expected: FAIL, cannot resolve `./config.js`.

- [ ] **Step 3: Implement config**

```typescript
import { z } from "zod";

const schema = z.object({
  ADMIN_TOKEN: z.string().min(32),
  API_URL: z.url()
});

export type WebConfig = z.infer<typeof schema>;

/**
 * Fail at boot with the offending variable named, mirroring packages/config.
 * A web app that starts without ADMIN_TOKEN would render a login page that can
 * never succeed.
 */
export function loadWebConfig(source: Record<string, string | undefined>): WebConfig {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid web configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export const webConfig = (): WebConfig => loadWebConfig(process.env);
```

- [ ] **Step 4: Implement the API client**

```typescript
import { webConfig } from "./config.js";

export interface SearchItem {
  journeyId: string;
  entity: { type: string; id: string | null };
  status: string;
  eventCount: number;
  startedAt: string;
  lastEventAt: string;
}

export interface JourneyDetail {
  journeyId: string;
  entity: { type: string; id: string | null };
  status: string;
  aliases: { type: string; displayValue: string | null }[];
  services: string[];
  eventCount: number;
  startedAt: string;
  completedAt: string | null;
  lastEventAt: string;
}

export interface EventListItem {
  id: string;
  operation: string;
  name: string;
  service: string;
  eventTimestamp: string;
  durationMs: number | null;
  hasInput: boolean;
  hasOutput: boolean;
  hasError: boolean;
}

export interface DiffChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface EventDetail extends EventListItem {
  journeyId: string;
  receivedAt: string;
  traceId: string | null;
  messageId: string | null;
  inputPayload: unknown;
  outputPayload: unknown;
  payloadDiff: { changes: DiffChange[]; truncated: boolean } | null;
  error: unknown;
}

export class ApiUnavailableError extends Error {
  public override readonly name = "ApiUnavailableError";
}

/**
 * The only module that knows the API contract.
 *
 * Runs server-side exclusively — the admin token is project-wide and must never
 * reach the browser (ADR-029). `cache: "no-store"` because a debugging tool
 * showing stale data is worse than one that is slightly slower.
 */
async function get<T>(path: string): Promise<T | null> {
  const config = webConfig();
  let response: Response;
  try {
    response = await fetch(`${config.API_URL}${path}`, {
      headers: { authorization: `Bearer ${config.ADMIN_TOKEN}` },
      cache: "no-store"
    });
  } catch (cause) {
    throw new ApiUnavailableError("The Flight Recorder API is unreachable.", { cause });
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ApiUnavailableError(`API responded ${String(response.status)}.`);
  }

  const body = (await response.json()) as { data: T };
  return body.data;
}

export async function search(query: string): Promise<SearchItem[]> {
  const data = await get<{ items: SearchItem[] }>(`/v1/search?q=${encodeURIComponent(query)}`);
  return data?.items ?? [];
}

export const getJourney = (journeyId: string): Promise<JourneyDetail | null> =>
  get<JourneyDetail>(`/v1/journeys/${encodeURIComponent(journeyId)}`);

export async function listEvents(journeyId: string): Promise<EventListItem[]> {
  const data = await get<{ items: EventListItem[] }>(
    `/v1/journeys/${encodeURIComponent(journeyId)}/events?limit=100`
  );
  return data?.items ?? [];
}

export const getEvent = (eventId: string): Promise<EventDetail | null> =>
  get<EventDetail>(`/v1/events/${encodeURIComponent(eventId)}`);
```

- [ ] **Step 5: Run, lint, commit**

```bash
pnpm vitest run apps/web
pnpm lint
git add apps/web
git commit -m "feat(web): add config parsing and typed API client"
```

---

## Task 2: Auth gate, login route, login page

**Files:**
- Create: `apps/web/middleware.ts`, `apps/web/app/api/login/route.ts`, `apps/web/app/login/page.tsx`

- [ ] **Step 1: Middleware**

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "./src/lib/session.js";

/**
 * One gate for every route. A per-page check is a check a new page can forget.
 *
 * Verification happens here rather than in each page so an unauthenticated
 * request never reaches code that would call the API.
 */
export function middleware(request: NextRequest): NextResponse {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const adminToken = process.env["ADMIN_TOKEN"] ?? "";
  const session =
    cookie === undefined ? null : verifySession(adminToken, cookie, Date.now());

  if (session === null) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except the login page, the login endpoint, and static assets.
  matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico).*)"]
};
```

- [ ] **Step 2: Login route handler**

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { webConfig } from "../../../src/lib/config.js";
import { LoginLimiter } from "../../../src/lib/login-limiter.js";
import { SESSION_COOKIE_NAME, signSession } from "../../../src/lib/session.js";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

// Module scope: one limiter per server process, which is the whole scope it
// claims to cover (ADR-029).
const limiter = new LoginLimiter();

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  const now = Date.now();
  const key = request.headers.get("x-forwarded-for") ?? "local";

  // The login form is a plain HTML POST, so failures must redirect back to the
  // page. Returning JSON would render a raw error object in the browser.
  if (limiter.isLocked(key, now)) {
    return NextResponse.redirect(new URL("/login?error=throttled", request.url), {
      status: 303
    });
  }

  const form = await request.formData();
  const presented = String(form.get("token") ?? "");

  if (!constantTimeEquals(presented, config.ADMIN_TOKEN)) {
    limiter.recordFailure(key, now);
    // One outcome regardless of cause: a near-miss must not read differently
    // from a wild guess.
    return NextResponse.redirect(new URL("/login?error=invalid", request.url), {
      status: 303
    });
  }

  limiter.recordSuccess(key);

  // Empty project means "the API resolves it", which it does when exactly one
  // project exists. Multi-project selection is a later concern and belongs in the
  // session payload when it arrives.
  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  response.cookies.set(SESSION_COOKIE_NAME, signSession(config.ADMIN_TOKEN, {
    projectId: "",
    expiresAt: now + SESSION_DURATION_MS
  }), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DURATION_MS / 1000
  });
  return response;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
```

- [ ] **Step 3: Login page**

```tsx
export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message =
    error === "throttled"
      ? "Too many attempts. Try again shortly."
      : error === "invalid"
        ? "Invalid token."
        : null;

  return (
    <main className="centered">
      <h1>Flight Recorder</h1>
      <p className="muted">
        Sign in with the admin token printed by <code>pnpm db:seed</code>.
      </p>
      {message === null ? null : <p className="error">{message}</p>}
      <form method="post" action="/api/login" className="stack">
        <label htmlFor="token">Admin token</label>
        <input id="token" name="token" type="password" autoComplete="off" required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Lint, build, commit**

```bash
pnpm lint && pnpm --filter @flight-recorder/web build
git add apps/web
git commit -m "feat(web): add auth gate, login route, and login page"
```

---

## Task 3: Shell and design tokens

**Files:**
- Modify: `apps/web/app/layout.tsx`
- Create: `apps/web/app/globals.css`

- [ ] **Step 1: Design tokens**

```css
:root {
  --bg: #ffffff;
  --fg: #16181d;
  --muted: #646b7a;
  --line: #e3e6ec;
  --accent: #3b5bdb;
  --removed-bg: #fdecec;
  --added-bg: #e9f7ef;
  --failed: #c0392b;
  --radius: 6px;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a;
    --fg: #e6e8ec;
    --muted: #9aa1b0;
    --line: #2a2e37;
    --accent: #91a7ff;
    --removed-bg: #3a1f22;
    --added-bg: #16301f;
    --failed: #ff8a80;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, sans-serif;
}
a { color: var(--accent); }
.muted { color: var(--muted); }
.mono { font-family: var(--mono); }
.centered { max-width: 26rem; margin: 12vh auto; padding: 0 1rem; }
.stack { display: flex; flex-direction: column; gap: 0.5rem; }
.shell { max-width: 76rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
input, button {
  font: inherit;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
}
button { background: var(--accent); color: #fff; border-color: transparent; cursor: pointer; }
```

- [ ] **Step 2: Layout imports it**

Modify `apps/web/app/layout.tsx` to `import "./globals.css";` and wrap children in
`<div className="shell">`.

- [ ] **Step 3: Commit**

```bash
pnpm lint && pnpm --filter @flight-recorder/web build
git add apps/web
git commit -m "feat(web): add design tokens and application shell"
```

---

## Task 4: Search page

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Implement**

```tsx
import Link from "next/link";
import { ApiUnavailableError, search } from "../src/lib/api.js";

export default async function SearchPage({
  searchParams
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  return (
    <main>
      <h1>Find a record</h1>
      <p className="muted">
        Search any identifier you have — a customer ID, an external reference, a trace or
        message ID. You do not need to know which system it came from.
      </p>

      <form method="get" className="search-row">
        <input name="q" defaultValue={query} placeholder="0018Z00002ABC" aria-label="Search" />
        <button type="submit">Search</button>
      </form>

      {query === "" ? (
        <p className="muted">Enter an identifier above to begin.</p>
      ) : (
        <Results query={query} />
      )}
    </main>
  );
}

async function Results({ query }: { query: string }) {
  let items;
  try {
    items = await search(query);
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    throw error;
  }

  if (items.length === 0) {
    return (
      <p className="muted">
        Nothing matched <span className="mono">{query}</span>. Identifiers are matched
        exactly, so partial values will not find a record.
      </p>
    );
  }

  return (
    <ul className="results">
      {items.map((item) => (
        <li key={item.journeyId}>
          <Link href={`/journeys/${item.journeyId}`}>
            <span className="mono">
              {item.entity.type}: {item.entity.id ?? "—"}
            </span>
          </Link>
          <span className={item.status === "failed" ? "status failed" : "status"}>
            {item.status}
          </span>
          <span className="muted">
            {item.eventCount} events · last activity {item.lastEventAt}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Add the styles** for `.search-row`, `.results`, `.status`, `.error` to
`globals.css`, following the existing token vocabulary.

- [ ] **Step 3: Lint, build, commit**

```bash
pnpm lint && pnpm --filter @flight-recorder/web build
git add apps/web
git commit -m "feat(web): add entity-first search page"
```

---

## Task 5: Journey page, timeline, diff table

**Files:**
- Create: `apps/web/app/journeys/[journeyId]/page.tsx`,
  `apps/web/app/components/DiffTable.tsx`, `apps/web/app/components/EventDetail.tsx`

- [ ] **Step 1: The diff table**

This is the differentiator (ADR-013), so it renders the structural diff directly.

```tsx
import type { DiffChange } from "../../src/lib/api.js";

function render(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/**
 * Renders the structural diff as-is: one row per changed path.
 *
 * Not a unified −/+ view. We compute {path, kind, before, after}, never a text
 * diff, and the input and output often use different field names — `Phone`
 * versus `phone` — so a single-column rendering would have to pick one and
 * mislead about the other.
 */
export function DiffTable({ changes }: { changes: DiffChange[] }) {
  if (changes.length === 0) {
    return <p className="muted">No fields changed between input and output.</p>;
  }

  return (
    <table className="diff">
      <thead>
        <tr>
          <th>Field</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={`${change.path}-${change.kind}`}>
            <td className="mono">{change.path}</td>
            <td className="mono removed">{render(change.before)}</td>
            <td className="mono added">{render(change.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Event detail**

```tsx
import type { EventDetail as Detail } from "../../src/lib/api.js";
import { DiffTable } from "./DiffTable.js";

export function EventDetail({ event }: { event: Detail }) {
  return (
    <section>
      <h2>{event.name}</h2>
      <p className="muted">
        {event.operation} · {event.service}
        {event.durationMs === null ? "" : ` · ${String(event.durationMs)} ms`}
      </p>

      {event.payloadDiff === null ? null : (
        <>
          <h3>What changed</h3>
          <p className="muted">
            The difference between what this step received and what it produced.
          </p>
          <DiffTable changes={event.payloadDiff.changes} />
          {event.payloadDiff.truncated ? (
            <p className="muted">Comparison truncated: too many changes to show.</p>
          ) : null}
        </>
      )}

      {event.error === null ? null : (
        <>
          <h3>Error</h3>
          <pre className="mono block">{JSON.stringify(event.error, null, 2)}</pre>
        </>
      )}

      <h3>Payloads</h3>
      {!event.hasInput && !event.hasOutput ? (
        <p className="muted">
          No payload captured. The environment&rsquo;s capture policy stores metadata only.
        </p>
      ) : (
        <div className="split">
          <div>
            <div className="label">Input</div>
            <pre className="mono block">{JSON.stringify(event.inputPayload, null, 2)}</pre>
          </div>
          <div>
            <div className="label">Output</div>
            <pre className="mono block">{JSON.stringify(event.outputPayload, null, 2)}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: The journey page**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent, getJourney, listEvents } from "../../../src/lib/api.js";
import { EventDetail } from "../../components/EventDetail.js";

export default async function JourneyPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { journeyId } = await params;
  const { event: selectedId } = await searchParams;

  const journey = await getJourney(journeyId);
  if (journey === null) notFound();

  const events = await listEvents(journeyId);
  // Default to the first event so the panel is never empty on arrival.
  const activeId = selectedId ?? events[0]?.id;
  const active = activeId === undefined ? null : await getEvent(activeId);

  return (
    <main>
      <h1 className="mono">
        {journey.entity.type}: {journey.entity.id ?? "—"}
      </h1>
      <p className="muted">
        {journey.status} · {journey.eventCount} events ·{" "}
        {journey.services.join(", ")}
      </p>

      {journey.aliases.length === 0 ? null : (
        <p className="muted">
          Also known as{" "}
          {journey.aliases.map((a) => `${a.type} ${a.displayValue ?? "—"}`).join(", ")}.
          These identifiers all refer to the same record.
        </p>
      )}

      <div className="journey">
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.id} className={event.id === activeId ? "active" : undefined}>
              <Link href={`/journeys/${journeyId}?event=${event.id}`}>
                <span className="mono time">{event.eventTimestamp.slice(11, 19)}</span>
                <span className={event.hasError ? "op failed" : "op"}>{event.operation}</span>
                <span className="muted">{event.service}</span>
              </Link>
            </li>
          ))}
        </ol>
        <div className="detail">
          {active === null ? (
            <p className="muted">This journey has no events yet.</p>
          ) : (
            <EventDetail event={active} />
          )}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Styles** for `.journey` (two-column grid, timeline scrolls
independently), `.timeline`, `.detail`, `.diff`, `.removed`, `.added`, `.block`,
`.split`, `.label`. Collapse `.journey` to one column below 60rem — master–detail is the
weakest layout on a narrow screen.

- [ ] **Step 5: Lint, build, commit**

```bash
pnpm lint && pnpm --filter @flight-recorder/web build
git add apps/web
git commit -m "feat(web): add journey timeline, event detail, and diff table"
```

---

## Task 6: Playwright

**Files:**
- Create: `playwright.config.ts`, `apps/web/e2e/journey.spec.ts`
- Modify: root `package.json` (`test:e2e`), `.gitlab-ci.yml`

- [ ] **Step 1: Install and configure**

```bash
pnpm add -Dw @playwright/test
pnpm exec playwright install --with-deps chromium
```

`playwright.config.ts`:

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 60_000,
  use: { baseURL: process.env["WEB_URL"] ?? "http://localhost:3000" },
  reporter: "list"
});
```

- [ ] **Step 2: The spec**

```typescript
import { expect, test } from "@playwright/test";

const ADMIN_TOKEN = process.env["ADMIN_TOKEN"] ?? "";
const API_URL = process.env["API_URL"] ?? "http://localhost:8080";
const API_KEY = process.env["FLIGHT_API_KEY"] ?? "";

const ENTITY_ID = "0018Z00002ABC";
const JOURNEY_ID = "jrn_e2e_demo";

/**
 * Seeds the reference journey by ingesting it.
 *
 * The demo services that would produce this data by running a genuinely broken
 * integration do not exist until Phase 5, so this test fabricates it. That is
 * why this suite proves the interface renders what the API returns, and not that
 * the product scenario works end to end.
 */
async function seed(): Promise<void> {
  const steps = [
    ["evt_1", "received", "receive-salesforce-webhook", "webhook-api", "10:31:02", {}],
    ["evt_2", "transformed", "transform-salesforce-account", "webhook-api", "10:31:04", {
      input: { Name: "Jorge Polanco", Phone: "+1 919 555 1234", Status__c: "Active" },
      output: { name: "Jorge Polanco", phone: null, status: "active" }
    }],
    ["evt_3", "persisted", "persist-customer", "webhook-api", "10:31:05", {}],
    ["evt_4", "published", "publish-customer-updated", "webhook-api", "10:31:06", {}],
    ["evt_5", "consumed", "consume-customer-updated", "sync-worker", "10:31:07", {}],
    ["evt_6", "delivered", "deliver-customer-to-target", "sync-worker", "10:31:09", {
      error: { message: "A phone number is required.", code: "phone_required" }
    }],
    ["evt_7", "retried", "retry-customer-delivery", "sync-worker", "10:31:39", {
      error: { message: "A phone number is required.", code: "phone_required" }
    }],
    ["evt_8", "failed", "move-message-to-dead-letter", "sync-worker", "10:34:38", {}]
  ] as const;

  for (const [id, operation, name, service, time, extra] of steps) {
    const response = await fetch(`${API_URL}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "0.1",
        event: {
          id,
          journeyId: JOURNEY_ID,
          environment: "development",
          service,
          entity: { type: "customer", id: ENTITY_ID },
          operation,
          name,
          timestamp: `2026-08-06T${time}.000Z`,
          aliases: { salesforceAccountId: ENTITY_ID },
          ...extra
        }
      })
    });
    if (!response.ok) throw new Error(`Seed failed for ${id}: ${String(response.status)}`);
  }
}

test.beforeAll(seed);

test("redirects an unauthenticated visit to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("rejects a wrong token", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#token", "not-the-admin-token-at-all-000000");
  await page.click("button[type=submit]");
  await expect(page.locator("body")).toContainText("Invalid token");
});

test("finds the customer and shows where phone became null", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await expect(page).toHaveURL("/");

  await page.fill("input[name=q]", ENTITY_ID);
  await page.click("button[type=submit]");
  await page.click(`text=customer: ${ENTITY_ID}`);

  // All eight steps, in order.
  await expect(page.locator(".timeline li")).toHaveCount(8);

  await page.click("text=transform-salesforce-account");
  const row = page.locator(".diff tbody tr", { hasText: "phone" }).first();
  await expect(row).toContainText("+1 919 555 1234");
  await expect(row).toContainText("null");
});

test("masks the alias display value", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.locator("body")).toContainText("0018…ABC");
});

test("renders an empty state for an unmatched search", async ({ page }) => {
  await page.goto("/login");
  await page.fill("#token", ADMIN_TOKEN);
  await page.click("button[type=submit]");
  await page.fill("input[name=q]", "no-such-identifier-anywhere");
  await page.click("button[type=submit]");
  await expect(page.locator("body")).toContainText("Nothing matched");
});
```

- [ ] **Step 3: Root script**

Add `"test:e2e": "playwright test"` to root `package.json`.

- [ ] **Step 4: Run against the live stack**

```bash
docker compose -f infrastructure/compose.yaml up -d --build
DATABASE_URL=... pnpm db:migrate
DATABASE_URL=... ENCRYPTION_KEY=... pnpm db:seed   # capture the printed key
ADMIN_TOKEN=... FLIGHT_API_KEY=<printed> pnpm test:e2e
```

Expected: 5 passing.

- [ ] **Step 5: Add the CI job**

`TESTING_STRATEGY.md` section 8 puts browser tests on protected branches or the release
workflow, not every push. Playwright here needs the whole stack — postgres, migrations,
seed, api, web — so it runs manually rather than blocking every commit.

Add to `.gitlab-ci.yml`:

```yaml
stages:
  - verify
  - test
  - integration
  - build
  - browser

e2e:
  stage: browser
  image: mcr.microsoft.com/playwright:v1.50.0-noble
  services:
    - postgres:17-alpine
  variables:
    POSTGRES_USER: flight
    POSTGRES_PASSWORD: flight
    POSTGRES_DB: flight
    DATABASE_URL: postgresql://flight:flight@postgres:5432/flight
    ENCRYPTION_KEY: ci-encryption-key-0000000000000000
    ADMIN_TOKEN: ci-admin-token-000000000000000000
  # Manual: this job builds and boots two applications, and a red pipeline on
  # every push for a suite that needs the full stack trains people to ignore it.
  when: manual
  allow_failure: true
  script:
    - pnpm db:migrate
    - pnpm build
    - pnpm test:e2e
```

Pin the Playwright image tag to the `@playwright/test` version installed in Step 1;
a mismatch between the browser image and the client is a common and confusing failure.

- [ ] **Step 6: Commit**

```bash
pnpm lint
git add . && git commit -m "test(web): add Playwright coverage for the reference journey"
```

---

## Task 7: Verify Phase 2b-ii

- [ ] **Step 1: Clean-clone pipeline**

```bash
CLEAN=$(mktemp -d)/fr && git clone -q --branch phase-2b-ii-interface . "$CLEAN" && cd "$CLEAN"
pnpm install --frozen-lockfile
for s in format:check lint typecheck test build; do
  pnpm "$s" >/dev/null 2>&1 && echo "$s OK" || echo "$s FAIL"
done
pnpm test:integration
```

- [ ] **Step 2: Visual confirmation**

Bring up the stack, log in, search `0018Z00002ABC`, and confirm the timeline and diff
render as designed. Take a screenshot for the merge request.

- [ ] **Step 3: Merge, confirm CI, tag**

```bash
git checkout main && git merge --no-ff phase-2b-ii-interface
git push origin main
glab ci list --per-page 1
git tag -a phase-2b-complete -m "Phase 2b: web interface"
git push origin phase-2b-complete
```

---

## Definition of done

Every checkbox, Task 7 passing, CI green.

**Not in this phase:** the demo services and the end-to-end product proof (Phase 5),
replay (Phase 6), the SDK (Phase 3), and propagation (Phase 4).
