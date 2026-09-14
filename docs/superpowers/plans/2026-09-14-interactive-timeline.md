# Interactive Journey Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the journey page's timeline a client-side React component that filters, walks with the keyboard, polls a live journey, and pages past the first hundred events, without changing what the server renders first.

**Architecture:** The existing server page keeps fetching the journey, the first page of events, and the first event's detail, then mounts one `"use client"` component that owns everything below the header. The browser talks only to two new Next route handlers that verify the session cookie and proxy the API server-side, so the admin token never leaves the server (ADR-029). Pure timeline logic lives in a React-free module and carries most of the unit tests.

**Tech Stack:** Next 15 app router, React 19, TypeScript, Vitest 4 (a new jsdom project), React Testing Library, Playwright.

Spec: `docs/superpowers/specs/2026-09-14-interactive-timeline-design.md`.

**Conventions that apply to every task:**

- Node 24 is not the machine default. Prefix every command with
  `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"` (once per shell).
- Run from the repository root `/Users/jorgepolanco/workspace/flight-recorder`.
- Before every commit: `pnpm format` (Prettier rewrites), `pnpm lint`, and
  `pnpm typecheck` must all pass. The CI `format` job runs `prettier --check`.
- Every commit message ends with the line
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `tsconfig.base.json` has `noUncheckedIndexedAccess`: `array[0]` is `T | undefined`.
- `.ts` files need explicit return types (lint rule); `.tsx` files do not.
- Work on a branch: `git checkout -b interactive-timeline` before Task 1.

---

## File structure

| File | Responsibility |
| --- | --- |
| `vitest.config.ts` (modify) | Two Vitest projects: the existing node one and a new jsdom one for `apps/web/**/*.test.tsx` |
| `apps/web/vitest.setup.tsx` (create) | jest-dom matchers, RTL cleanup, a plain-anchor mock of `next/link` |
| `apps/web/src/lib/timeline.ts` (create) | Pure logic: filters, neighbour, merge, services, count line |
| `apps/web/src/lib/timeline.test.ts` (create) | Its tests |
| `apps/web/src/lib/request-session.ts` (create) | Session cookie check and project resolution shared by route handlers |
| `apps/web/src/lib/request-session.test.ts` (create) | Its tests |
| `apps/web/src/lib/api.ts` (modify) | `listEvents` becomes single-page and returns `nextCursor` |
| `apps/web/app/api/replay/route.ts` (modify) | Uses `request-session.ts` |
| `apps/web/app/api/journeys/[journeyId]/events/route.ts` (create) | GET one page of events plus journey status and count |
| `apps/web/app/api/events/[eventId]/route.ts` (create) | GET one event's detail |
| `apps/web/app/components/DiffTable.tsx` (modify) | `collapsible` prop |
| `apps/web/app/components/DiffTable.test.tsx` (create) | Its tests |
| `apps/web/app/components/EventDetail.tsx` (modify) | Passes `collapsibleDiff` through |
| `apps/web/app/components/FilterBar.tsx` (create) | Service chips, failures toggle, live toggle, notices |
| `apps/web/app/components/TimelineList.tsx` (create) | The listbox of rows |
| `apps/web/app/components/JourneyTimeline.tsx` (create) | State owner: selection, keyboard, filters, load more, polling |
| `apps/web/app/components/JourneyTimeline.test.tsx` (create) | Its tests, with a mocked `fetch` |
| `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx` (modify) | Mounts the component |
| `apps/web/app/globals.css` (modify) | Chips, focus ring, plain button |
| `apps/web/e2e/journey.spec.ts` (modify) | One new browser test |
| `CHANGELOG.md` (modify) | Entry under Unreleased |

---

### Task 1: Test tooling for React components

**Files:**
- Modify: `vitest.config.ts`
- Create: `apps/web/vitest.setup.tsx`
- Create: `apps/web/app/components/DiffTable.test.tsx` (a smoke test only; Task 5 extends it)
- Modify: `package.json` (root devDependencies, via pnpm)

- [ ] **Step 1: Install the test-only dependencies at the workspace root**

```bash
pnpm add -Dw @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

Expected: `package.json` devDependencies gain the four packages; `pnpm-lock.yaml` changes. No runtime dependency changes.

- [ ] **Step 2: Write the smoke test that needs jsdom and JSX**

`apps/web/app/components/DiffTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffTable } from "./DiffTable";

describe("DiffTable", () => {
  it("renders one row per change", () => {
    render(
      <DiffTable
        changes={[
          { path: "Phone", kind: "removed", before: "+1 919 555 1234" },
          { path: "phone", kind: "added", after: null }
        ]}
      />
    );
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText('"+1 919 555 1234"')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to see it fail for lack of a DOM**

```bash
pnpm vitest run apps/web/app/components/DiffTable.test.tsx
```

Expected: no test found, because the root include pattern is `*.test.ts`, or a failure mentioning `document is not defined`.

- [ ] **Step 4: Split the Vitest config into two projects**

Replace the `test` block of `vitest.config.ts` (keep the `resolve.alias` block exactly as it is):

```ts
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["{apps,packages}/*/src/**/*.test.ts", "tests/**/*.test.ts"],
          // The demo suite needs a running Compose stack, so it must never join this
          // run: `pnpm test` has to work on a laptop with nothing up.
          exclude: ["**/node_modules/**", "**/*.integration.test.ts", "**/*.e2e.test.ts"],
          environment: "node",
          testTimeout: 10_000
        }
      },
      {
        // React components render into jsdom. Kept as a second project rather than
        // a per-file environment comment so a component test cannot silently run
        // under node and pass by never rendering.
        extends: true,
        esbuild: { jsx: "automatic" },
        test: {
          name: "web",
          include: ["apps/web/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "**/.next/**"],
          environment: "jsdom",
          setupFiles: ["apps/web/vitest.setup.tsx"],
          testTimeout: 10_000
        }
      }
    ]
  }
```

- [ ] **Step 5: Write the setup file**

`apps/web/vitest.setup.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

// `next/link` wants the app router context and warns without it. The components
// under test only need an anchor with the right href.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  )
}));
```

- [ ] **Step 6: Run the smoke test and the whole suite**

```bash
pnpm vitest run apps/web/app/components/DiffTable.test.tsx
pnpm test
```

Expected: the smoke test passes under the `web` project; `pnpm test` still reports 44 files and 427 tests in `node` plus 1 file and 1 test in `web`.

- [ ] **Step 7: Typecheck, lint, format, commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add -A
git commit -m "test(web): a jsdom Vitest project for React components

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

If `tsc` cannot find the jest-dom matcher types, add
`"types": ["@testing-library/jest-dom/vitest"]` to `compilerOptions` in
`apps/web/tsconfig.json` and rerun.

---

### Task 2: Pure timeline logic

**Files:**
- Create: `apps/web/src/lib/timeline.ts`
- Create: `apps/web/src/lib/timeline.test.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { EventListItem } from "./api";
import {
  NO_FILTERS,
  applyFilters,
  describeCount,
  mergeEvents,
  neighbour,
  services
} from "./timeline";

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id,
    operation: "received",
    name: `step-${id}`,
    service: "webhook-api",
    eventTimestamp: `2026-09-14T10:00:0${id.slice(-1)}.000Z`,
    receivedAt: `2026-09-14T10:00:0${id.slice(-1)}.500Z`,
    durationMs: null,
    hasInput: true,
    hasOutput: false,
    hasError: false,
    ...overrides
  };
}

const EVENTS = [
  event("evt_1"),
  event("evt_2", { service: "sync-worker" }),
  event("evt_3", { service: "sync-worker", hasError: true }),
  event("evt_4", { hasError: true })
];

describe("applyFilters", () => {
  it("returns everything with no filters, in order", () => {
    expect(applyFilters(EVENTS, NO_FILTERS).map((e) => e.id)).toEqual([
      "evt_1",
      "evt_2",
      "evt_3",
      "evt_4"
    ]);
  });

  it("narrows to one service", () => {
    expect(
      applyFilters(EVENTS, { service: "sync-worker", failuresOnly: false }).map((e) => e.id)
    ).toEqual(["evt_2", "evt_3"]);
  });

  it("narrows to failures, and combines with the service", () => {
    expect(applyFilters(EVENTS, { service: null, failuresOnly: true }).map((e) => e.id)).toEqual([
      "evt_3",
      "evt_4"
    ]);
    expect(
      applyFilters(EVENTS, { service: "sync-worker", failuresOnly: true }).map((e) => e.id)
    ).toEqual(["evt_3"]);
  });
});

describe("neighbour", () => {
  it("moves one step and stops at the edges", () => {
    expect(neighbour(EVENTS, "evt_2", "down")).toBe("evt_3");
    expect(neighbour(EVENTS, "evt_2", "up")).toBe("evt_1");
    expect(neighbour(EVENTS, "evt_4", "down")).toBe("evt_4");
    expect(neighbour(EVENTS, "evt_1", "up")).toBe("evt_1");
  });

  it("lands on the first visible event when the selection is not visible", () => {
    const failures = applyFilters(EVENTS, { service: null, failuresOnly: true });
    expect(neighbour(failures, "evt_1", "down")).toBe("evt_3");
    expect(neighbour(failures, null, "up")).toBe("evt_3");
  });

  it("returns null for an empty list", () => {
    expect(neighbour([], "evt_1", "down")).toBeNull();
  });
});

describe("mergeEvents", () => {
  it("unions by id and orders by timestamp then id", () => {
    const merged = mergeEvents([EVENTS[1]!, EVENTS[3]!], [EVENTS[0]!, EVENTS[2]!]);
    expect(merged.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3", "evt_4"]);
  });

  it("is idempotent, and a newer copy of an event replaces the older one", () => {
    const once = mergeEvents(EVENTS, EVENTS);
    expect(once).toHaveLength(4);
    const updated = mergeEvents(once, [event("evt_2", { hasError: true })]);
    expect(updated.find((e) => e.id === "evt_2")?.hasError).toBe(true);
    expect(updated).toHaveLength(4);
  });
});

describe("services", () => {
  it("lists distinct services in first-seen order", () => {
    expect(services(EVENTS)).toEqual(["webhook-api", "sync-worker"]);
  });
});

describe("describeCount", () => {
  it("states the plain count when everything is loaded and shown", () => {
    expect(describeCount({ visible: 10, loaded: 10, total: 10, complete: true })).toBe(
      "10 events"
    );
  });

  it("says how many are loaded when more exist", () => {
    expect(describeCount({ visible: 100, loaded: 100, total: 240, complete: false })).toBe(
      "showing 100 of 240 events"
    );
  });

  it("says how many are shown when a filter hides some", () => {
    expect(describeCount({ visible: 2, loaded: 10, total: 10, complete: true })).toBe(
      "2 of 10 events shown"
    );
  });

  it("never reports a total below what is loaded", () => {
    // A live journey can deliver events before the count catches up.
    expect(describeCount({ visible: 12, loaded: 12, total: 10, complete: true })).toBe(
      "12 events"
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run apps/web/src/lib/timeline.test.ts
```

Expected: FAIL, `Cannot find module './timeline'`.

- [ ] **Step 3: Implement the module**

`apps/web/src/lib/timeline.ts`:

```ts
import type { EventListItem } from "./api";

/**
 * Pure timeline logic, kept out of React so it can be tested without a DOM and
 * read without a component's state in the way.
 */

export interface TimelineFilters {
  /** A service name, or null for all of them. */
  service: string | null;
  failuresOnly: boolean;
}

export const NO_FILTERS: TimelineFilters = { service: null, failuresOnly: false };

/** The events a reader currently sees, in the order they already had. */
export function applyFilters(
  events: readonly EventListItem[],
  filters: TimelineFilters
): EventListItem[] {
  return events.filter(
    (event) =>
      (filters.service === null || event.service === filters.service) &&
      (!filters.failuresOnly || event.hasError)
  );
}

/**
 * The id one step up or down within the visible list.
 *
 * At an edge the selection stays put rather than wrapping: a reader pressing
 * ArrowDown at the bottom of a timeline is looking for more, and jumping to the
 * top would read as the list having changed. A selection that is no longer
 * visible (filtered out) resolves to the first visible event.
 */
export function neighbour(
  visible: readonly EventListItem[],
  selectedId: string | null,
  direction: "up" | "down"
): string | null {
  const first = visible[0];
  if (first === undefined) return null;

  const index = visible.findIndex((event) => event.id === selectedId);
  if (index === -1) return first.id;

  const next = direction === "down" ? Math.min(index + 1, visible.length - 1) : Math.max(index - 1, 0);
  return visible[next]?.id ?? first.id;
}

/**
 * Union by id, ordered by timestamp then id.
 *
 * Polling delivers overlapping pages, so this has to be safe to apply
 * repeatedly. The order is the API's own (ADR-031: an event carries when its
 * operation started), so merging cannot reorder what a reader has already seen.
 */
export function mergeEvents(
  existing: readonly EventListItem[],
  incoming: readonly EventListItem[]
): EventListItem[] {
  const byId = new Map<string, EventListItem>();
  for (const event of existing) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(
    (a, b) => a.eventTimestamp.localeCompare(b.eventTimestamp) || a.id.localeCompare(b.id)
  );
}

/** Distinct service names in first-seen order, for the filter chips. */
export function services(events: readonly EventListItem[]): string[] {
  const seen: string[] = [];
  for (const event of events) {
    if (!seen.includes(event.service)) seen.push(event.service);
  }
  return seen;
}

export interface CountInput {
  /** Rows on screen after filtering. */
  visible: number;
  /** Rows fetched so far. */
  loaded: number;
  /** The journey's own count, which can lag a live journey. */
  total: number;
  /** Whether every page has been fetched. */
  complete: boolean;
}

/**
 * The count line under the heading.
 *
 * The header used to print the journey's true count above a list capped at a
 * hundred, with nothing saying so. Each case here names what the number is a
 * count of.
 */
export function describeCount({ visible, loaded, total, complete }: CountInput): string {
  const all = Math.max(total, loaded);
  if (visible !== loaded) return `${String(visible)} of ${String(loaded)} events shown`;
  if (!complete) return `showing ${String(loaded)} of ${String(all)} events`;
  return `${String(all)} events`;
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm vitest run apps/web/src/lib/timeline.test.ts
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web/src/lib/timeline.ts apps/web/src/lib/timeline.test.ts
git commit -m "feat(web): pure timeline logic for filtering, selection, merging and counts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Shared session check for route handlers

**Files:**
- Create: `apps/web/src/lib/request-session.ts`
- Create: `apps/web/src/lib/request-session.test.ts`
- Modify: `apps/web/app/api/replay/route.ts`

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/request-session.test.ts`:

```ts
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME, signSession } from "./session";

const ADMIN_TOKEN = "admin-token-for-tests-00000000000000";
const NOW = 1_800_000_000_000;

vi.mock("./api", () => ({
  listProjects: vi.fn()
}));

// `vi.mock` is hoisted above these, so `listProjects` is already the mock.
import { listProjects } from "./api";
import { requestSession } from "./request-session";

function requestWithCookie(cookie: string | undefined): NextRequest {
  return new NextRequest("http://localhost:3000/api/x", {
    headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }
  });
}

describe("requestSession", () => {
  beforeEach(() => {
    process.env["ADMIN_TOKEN"] = ADMIN_TOKEN;
    process.env["API_URL"] = "http://api:8080";
    vi.mocked(listProjects).mockReset();
  });
  afterEach(() => {
    delete process.env["ADMIN_TOKEN"];
    delete process.env["API_URL"];
  });

  it("returns null without a cookie", async () => {
    expect(await requestSession(requestWithCookie(undefined), NOW)).toBeNull();
  });

  it("returns null for a cookie signed with another token", async () => {
    const cookie = signSession("some-other-token-000000000000000000", {
      projectId: "proj_1",
      expiresAt: NOW + 1000
    });
    expect(await requestSession(requestWithCookie(cookie), NOW)).toBeNull();
  });

  it("uses the session's project when it has one", async () => {
    const cookie = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: NOW + 1000 });
    expect(await requestSession(requestWithCookie(cookie), NOW)).toEqual({
      session: { projectId: "proj_1", expiresAt: NOW + 1000 },
      projectId: "proj_1"
    });
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("falls back to the only project when the session has none", async () => {
    vi.mocked(listProjects).mockResolvedValue([{ id: "proj_only", name: "Only", slug: "only" }]);
    const cookie = signSession(ADMIN_TOKEN, { projectId: "", expiresAt: NOW + 1000 });
    expect((await requestSession(requestWithCookie(cookie), NOW))?.projectId).toBe("proj_only");
  });

  it("resolves to no project when several exist and none is chosen", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: "a", name: "A", slug: "a" },
      { id: "b", name: "B", slug: "b" }
    ]);
    const cookie = signSession(ADMIN_TOKEN, { projectId: "", expiresAt: NOW + 1000 });
    expect((await requestSession(requestWithCookie(cookie), NOW))?.projectId).toBe("");
  });
});
```

`webConfig()` validates `ADMIN_TOKEN` as at least 32 characters and `API_URL` as a URL; both values above satisfy that. Vitest runs test files in isolation, so setting `process.env` in `beforeEach` does not leak.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run apps/web/src/lib/request-session.test.ts
```

Expected: FAIL, `Cannot find module './request-session'`.

- [ ] **Step 3: Implement**

`apps/web/src/lib/request-session.ts`:

```ts
import type { NextRequest } from "next/server";
import { listProjects } from "./api";
import { webConfig } from "./config";
import { SESSION_COOKIE_NAME, verifySession, type SessionPayload } from "./session";

export interface RequestSession {
  session: SessionPayload;
  /** Empty when several projects exist and the session has not chosen one. */
  projectId: string;
}

/**
 * The signed-in operator behind a route handler request, and their project.
 *
 * Route handlers are not covered by the route group's layout gate, so each one
 * verifies the cookie itself. This is the one place that does it, so a handler
 * cannot get the project resolution subtly different from the pages (which use
 * `requireProjectId`; the difference is that a handler cannot redirect to the
 * picker, so it reports an empty project instead).
 */
export async function requestSession(
  request: NextRequest,
  now = Date.now()
): Promise<RequestSession | null> {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session =
    cookie === undefined ? null : verifySession(webConfig().ADMIN_TOKEN, cookie, now);
  if (session === null) return null;

  if (session.projectId !== "") return { session, projectId: session.projectId };

  const projects = await listProjects();
  const only = projects.length === 1 ? projects[0] : undefined;
  return { session, projectId: only?.id ?? "" };
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
pnpm vitest run apps/web/src/lib/request-session.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Use it in the replay handler**

In `apps/web/app/api/replay/route.ts`, replace the imports and the session block:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { redirectTarget } from "../../../src/lib/redirect-url";
import { createReplay } from "../../../src/lib/api";
import { requestSession } from "../../../src/lib/request-session";
```

and inside `POST`, replace everything from `const config = webConfig();` through the `if (session === null)` redirect with:

```ts
  const auth = await requestSession(request);

  if (auth === null) {
    return NextResponse.redirect(redirectTarget(request, "/login"), { status: 303 });
  }
```

Replace `const projectId = session.projectId === "" ? await onlyProject() : session.projectId;` with:

```ts
  const projectId = auth.projectId;
```

Delete the `onlyProject` function at the bottom of the file and the now-unused imports of `listProjects`, `webConfig`, `SESSION_COOKIE_NAME`, and `verifySession`.

- [ ] **Step 6: Typecheck, lint, format, commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add apps/web/src/lib/request-session.ts apps/web/src/lib/request-session.test.ts apps/web/app/api/replay/route.ts
git commit -m "refactor(web): one session check for every route handler

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Single-page `listEvents`, and the two route handlers

**Files:**
- Modify: `apps/web/src/lib/api.ts` (the `listEvents` function and its DebtWatch block)
- Modify: `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx` (the `listEvents` call only)
- Create: `apps/web/app/api/journeys/[journeyId]/events/route.ts`
- Create: `apps/web/app/api/events/[eventId]/route.ts`

- [ ] **Step 1: Replace `listEvents`**

In `apps/web/src/lib/api.ts`, delete the whole block from the `/** A journey's events, following the cursor.` comment through the end of the `listEvents` function, including the `// debtwatch:start … // debtwatch:end` declaration `DEBT-43WEMV`, and put this in its place:

```ts
export interface EventsPage {
  items: EventListItem[];
  nextCursor: string | null;
}

/**
 * One page of a journey's events.
 *
 * The API paginates at 100. This used to loop over up to six pages to hide the
 * cap from the server-rendered page; the timeline component now owns
 * pagination and follows the cursor on demand, so the server fetches the first
 * page and hands the cursor over.
 */
export function listEvents(
  journeyId: string,
  projectId: string,
  cursor: string | null = null
): Promise<EventsPage | null> {
  const query = new URLSearchParams({ limit: "100" });
  if (cursor !== null) query.set("cursor", cursor);
  return get<EventsPage>(
    `/v1/journeys/${encodeURIComponent(journeyId)}/events?${query.toString()}`,
    projectId
  );
}
```

- [ ] **Step 2: Keep the page compiling**

In `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx`, replace

```ts
    const { items: events, complete } = await listEvents(journeyId, projectId);
```

with

```ts
    const page = await listEvents(journeyId, projectId);
    if (page === null) notFound();
    const events = page.items;
    const complete = page.nextCursor === null;
```

Task 7 rewrites this page; this keeps today's behaviour intact until then.

- [ ] **Step 3: Confirm nothing else calls the old shape**

```bash
grep -rn "listEvents" apps/web --include='*.ts' --include='*.tsx' | grep -v node_modules
pnpm typecheck
```

Expected: only `api.ts` and the journey page; typecheck passes.

- [ ] **Step 4: Write the events route handler**

`apps/web/app/api/journeys/[journeyId]/events/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import {
  ApiUnavailableError,
  ProjectNotSelectedError,
  getJourney,
  listEvents
} from "../../../../../src/lib/api";
import { requestSession } from "../../../../../src/lib/request-session";

/**
 * One page of a journey's events for the browser.
 *
 * A proxy, not a new contract: the admin token is project-wide and stays on
 * the server (ADR-029), so the browser asks this handler and this handler asks
 * the API. The journey rides along so live mode can learn in one request that
 * the journey has finished.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ journeyId: string }> }
): Promise<NextResponse> {
  const session = requestSession(request);
  if (session === null) return json(401, "unauthenticated", "Sign in again.");

  const { journeyId } = await params;
  const cursor = request.nextUrl.searchParams.get("cursor");

  try {
    const [page, journey] = await Promise.all([
      listEvents(journeyId, session.projectId, cursor),
      getJourney(journeyId, session.projectId)
    ]);
    if (page === null || journey === null) return json(404, "not_found", "No such journey.");

    const body: EventsPageResponse = {
      items: page.items,
      nextCursor: page.nextCursor,
      journeyStatus: journey.status,
      journeyEventCount: journey.eventCount
    };
    return NextResponse.json(body);
  } catch (error) {
    return failure(error);
  }
}

function json(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function failure(error: unknown): NextResponse {
  if (error instanceof ProjectNotSelectedError) {
    return json(409, "project_not_selected", "Choose a project first.");
  }
  if (error instanceof ApiUnavailableError) {
    // The message names configuration (which container holds which token) and
    // belongs in the server log, not in a body served to a browser.
    console.error(error.message);
    return json(502, "api_unavailable", "The Flight Recorder API is unavailable.");
  }
  throw error;
}
```

`EventsPageResponse` is declared in `apps/web/src/lib/api.ts`, next to `EventsPage`, so the client component can import it from the one module that knows the API's shapes (Next refuses non-handler exports from a route file):

```ts
/** What the timeline component reads on every poll and every load-more. */
export interface EventsPageResponse extends EventsPage {
  journeyStatus: string;
  journeyEventCount: number;
}
```

Add it to the handler's import from `api.ts`.

- [ ] **Step 5: Write the event detail route handler**

`apps/web/app/api/events/[eventId]/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { ApiUnavailableError, ProjectNotSelectedError, getEvent } from "../../../../src/lib/api";
import { requestSession } from "../../../../src/lib/request-session";

/**
 * One event's detail for the browser: payloads, diff, error. Same proxy
 * reasoning as the events page handler (ADR-029).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
): Promise<NextResponse> {
  const session = requestSession(request);
  if (session === null) return json(401, "unauthenticated", "Sign in again.");

  const { eventId } = await params;
  try {
    const event = await getEvent(eventId, session.projectId);
    if (event === null) return json(404, "not_found", "No such event.");
    return NextResponse.json(event);
  } catch (error) {
    if (error instanceof ProjectNotSelectedError) {
      return json(409, "project_not_selected", "Choose a project first.");
    }
    if (error instanceof ApiUnavailableError) {
      console.error(error.message);
      return json(502, "api_unavailable", "The Flight Recorder API is unavailable.");
    }
    throw error;
  }
}

function json(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
```

Move the shared `json` and `failure` helpers into `apps/web/src/lib/route-errors.ts` and import them from both handlers, so the two files do not each carry a copy:

```ts
import { NextResponse } from "next/server";
import { ApiUnavailableError, ProjectNotSelectedError } from "./api";

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Turns the API client's typed failures into JSON responses; rethrows anything else. */
export function apiFailure(error: unknown): NextResponse {
  if (error instanceof ProjectNotSelectedError) {
    return jsonError(409, "project_not_selected", "Choose a project first.");
  }
  if (error instanceof ApiUnavailableError) {
    // The message names configuration (which container holds which token) and
    // belongs in the server log, not in a body served to a browser.
    console.error(error.message);
    return jsonError(502, "api_unavailable", "The Flight Recorder API is unavailable.");
  }
  throw error;
}
```

Then both handlers use `jsonError(...)` and `catch (error) { return apiFailure(error); }`, and neither exports anything but `GET`.

- [ ] **Step 6: Verify against the running stack**

Bring the stack up (ports moved because 8080 is taken on this machine) and sign in with the browser, then call the handlers with the session cookie:

```bash
API_PORT=8081 WEB_PORT=3001 docker compose -p frdev -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d --wait
curl -s -X POST http://localhost:3100/trigger
```

Sign in at `http://localhost:3001` with the development token (`replace-for-local-development-0000`) and copy the `flight_session` cookie from the browser, or obtain one with:

```bash
COOKIE=$(curl -s -i -X POST http://localhost:3001/api/login --data-urlencode "token=replace-for-local-development-0000" | grep -i "set-cookie: flight_session" | sed 's/.*flight_session=\([^;]*\).*/\1/')
JID=$(curl -s -H "authorization: Bearer replace-for-local-development-0000" "http://localhost:8081/v1/search?q=0018Z00002ABC" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["items"][0]["journeyId"])')
curl -s -b "flight_session=$COOKIE" "http://localhost:3001/api/journeys/$JID/events" | head -c 400; echo
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/api/journeys/$JID/events"
```

Expected: the first prints `{"items":[…],"nextCursor":null,"journeyStatus":"failed","journeyEventCount":10}`; the second prints `401`. Leave the stack up for later tasks.

- [ ] **Step 7: Typecheck, lint, format, commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add -A apps/web
git commit -m "feat(web): route handlers that page events and read an event for the browser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Collapsible diff table

**Files:**
- Modify: `apps/web/app/components/DiffTable.tsx`
- Modify: `apps/web/app/components/DiffTable.test.tsx`
- Modify: `apps/web/app/components/EventDetail.tsx`

- [ ] **Step 1: Add the failing tests**

Append to the `describe` in `apps/web/app/components/DiffTable.test.tsx`:

```tsx
  it("shows every row when not collapsible, however many", () => {
    render(<DiffTable changes={changes(12)} />);
    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("collapses to eight rows and reveals the rest on request", async () => {
    render(<DiffTable changes={changes(12)} collapsible />);
    expect(screen.getAllByRole("row")).toHaveLength(9);
    await userEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not offer to expand when there is nothing hidden", () => {
    render(<DiffTable changes={changes(8)} collapsible />);
    expect(screen.getAllByRole("row")).toHaveLength(9);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
```

and above the `describe`, the fixture and import:

```tsx
import userEvent from "@testing-library/user-event";
import type { DiffChange } from "../../src/lib/api";

function changes(count: number): DiffChange[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `field${String(i)}`,
    kind: "changed" as const,
    before: i,
    after: i + 1
  }));
}
```

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run apps/web/app/components/DiffTable.test.tsx
```

Expected: the two `collapsible` tests fail (13 rows rendered, no button).

- [ ] **Step 3: Implement**

Replace `apps/web/app/components/DiffTable.tsx` with:

```tsx
"use client";

import { useState } from "react";
import type { DiffChange } from "../../src/lib/api";

function render(value: unknown): string {
  return value === undefined ? "—" : JSON.stringify(value);
}

/** Enough to show the shape of a change without scrolling past the replay link. */
const COLLAPSED_ROWS = 8;

/**
 * Renders the structural diff as-is: one row per changed path.
 *
 * Deliberately not a unified −/+ view. We compute {path, kind, before, after},
 * never a text diff, and input and output routinely use different field names —
 * `Phone` versus `phone` — so a single-column rendering would have to pick one
 * and mislead about the other.
 *
 * Rows are never reordered when collapsed: the API's order is the order a
 * reader can reason about, and "the interesting rows first" is a judgement the
 * tool has no basis to make.
 */
export function DiffTable({
  changes,
  compared = true,
  collapsible = false
}: {
  changes: DiffChange[];
  /** False when one side was never captured, so there was nothing to compare. */
  compared?: boolean;
  /** Show the first rows and a button for the rest. Off for the replay view. */
  collapsible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!compared) {
    // "No fields changed" is a claim about the data. Making it when nothing was
    // compared is the worst thing a debugging tool can do: the reader concludes
    // the step is innocent and looks elsewhere.
    return (
      <p className="muted">
        This step&rsquo;s payloads were not captured, so there is nothing to compare. A payload
        larger than the configured limit is recorded as a marker rather than stored.
      </p>
    );
  }

  if (changes.length === 0) {
    return <p className="muted">No fields changed between input and output.</p>;
  }

  const rows = collapsible && !expanded ? changes.slice(0, COLLAPSED_ROWS) : changes;
  const hidden = changes.length - rows.length;

  return (
    <>
      <table className="diff">
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((change) => (
            <tr key={`${change.path}-${change.kind}`}>
              <td className="mono">{change.path}</td>
              <td className="mono removed">{render(change.before)}</td>
              <td className="mono added">{render(change.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <button
          type="button"
          className="plain"
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show {hidden} more
        </button>
      ) : null}
    </>
  );
}
```

- [ ] **Step 4: Pass the flag through `EventDetail`**

In `apps/web/app/components/EventDetail.tsx`, change the signature to

```tsx
export function EventDetail({
  event,
  collapsibleDiff = false
}: {
  event: EventDetailData;
  /** The timeline collapses long diffs; the replay view shows everything. */
  collapsibleDiff?: boolean;
}) {
```

and the `DiffTable` element to

```tsx
          <DiffTable
            changes={event.payloadDiff.changes}
            compared={wasCaptured(event)}
            collapsible={collapsibleDiff}
          />
```

- [ ] **Step 5: Run to verify they pass**

```bash
pnpm vitest run apps/web/app/components/DiffTable.test.tsx
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add apps/web/app/components
git commit -m "feat(web): the diff table can collapse to eight rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The timeline component and its children

**Files:**
- Create: `apps/web/app/components/TimelineList.tsx`
- Create: `apps/web/app/components/FilterBar.tsx`
- Create: `apps/web/app/components/JourneyTimeline.tsx`
- Create: `apps/web/app/components/JourneyTimeline.test.tsx`

- [ ] **Step 1: Write the failing component tests**

`apps/web/app/components/JourneyTimeline.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventDetailData, EventListItem, EventsPageResponse } from "../../src/lib/api";
import { JourneyTimeline } from "./JourneyTimeline";

function event(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id,
    operation: "received",
    name: `step-${id}`,
    service: "webhook-api",
    eventTimestamp: `2026-09-14T10:00:0${id.slice(-1)}.000Z`,
    receivedAt: `2026-09-14T10:00:0${id.slice(-1)}.500Z`,
    durationMs: null,
    hasInput: true,
    hasOutput: false,
    hasError: false,
    ...overrides
  };
}

function detail(id: string): EventDetailData {
  return {
    ...event(id),
    journeyId: "jrn_1",
    traceId: null,
    messageId: null,
    inputPayload: { id },
    outputPayload: null,
    payloadDiff: null,
    error: null
  };
}

const EVENTS = [
  event("evt_1"),
  event("evt_2", { service: "sync-worker" }),
  event("evt_3", { service: "sync-worker", hasError: true }),
  event("evt_4", { hasError: true })
];

function page(overrides: Partial<EventsPageResponse> = {}): EventsPageResponse {
  return {
    items: [],
    nextCursor: null,
    journeyStatus: "active",
    journeyEventCount: 4,
    ...overrides
  };
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const failed = (): Response => new Response("nope", { status: 502 });

const fetchMock = vi.fn<typeof fetch>();

function mount(props: Partial<Parameters<typeof JourneyTimeline>[0]> = {}) {
  return render(
    <JourneyTimeline
      journeyId="jrn_1"
      initialStatus="failed"
      initialEvents={EVENTS}
      initialCursor={null}
      initialSelectedId="evt_1"
      initialDetail={detail("evt_1")}
      totalEvents={4}
      knownServices={["webhook-api", "sync-worker"]}
      {...props}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  window.history.replaceState(null, "", "/journeys/jrn_1?event=evt_1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("JourneyTimeline", () => {
  it("moves the selection with the keyboard and fetches the new event's detail", async () => {
    fetchMock.mockResolvedValueOnce(ok(detail("evt_2")));
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_2");
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/events/evt_2", expect.anything());
    expect(screen.getByRole("option", { selected: true })).toHaveAttribute("id", "event-evt_2");
    expect(window.location.search).toBe("?event=evt_2");
  });

  it("stops at the top rather than wrapping", () => {
    mount();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowUp" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters to failures and moves the selection to the first one", async () => {
    fetchMock.mockResolvedValueOnce(ok(detail("evt_3")));
    mount();

    await userEvent.click(screen.getByRole("button", { name: "Failures only" }));

    expect(screen.getAllByRole("option")).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_3");
    });
    expect(screen.getByText(/2 of 4 events shown/)).toBeInTheDocument();
  });

  it("loads the next page and merges it", async () => {
    fetchMock.mockResolvedValueOnce(
      ok(page({ items: [event("evt_5"), event("evt_6")], journeyStatus: "failed", journeyEventCount: 6 }))
    );
    mount({ initialCursor: "c1", totalEvents: 6 });

    expect(screen.getByText(/showing 4 of 6 events/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 2 more" }));

    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(6);
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/journeys/jrn_1/events?cursor=c1", expect.anything());
    expect(screen.getByText(/· 6 events ·/)).toBeInTheDocument();
  });

  it("polls an active journey and stops when it finishes", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(
      ok(page({ items: [event("evt_5")], journeyStatus: "completed", journeyEventCount: 5 }))
    );
    mount({ initialStatus: "active" });

    expect(screen.getByRole("checkbox", { name: "Live" })).toBeChecked();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option")).toHaveLength(5);
    expect(screen.getByText(/^completed/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after three failed polls and says so", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(failed());
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Live updates stopped/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Live" })).not.toBeChecked();
    expect(screen.getAllByRole("option")).toHaveLength(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops live mode at once when the session is refused", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    mount({ initialStatus: "active" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Sign in again/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Live" })).not.toBeChecked();
  });

  it("keeps polling from the last cursor it was given, not from page one", async () => {
    vi.useFakeTimers();
    // First poll from c1: the tail has one new event and no further page.
    // Second poll must still ask from c1, not refetch page one.
    fetchMock
      .mockResolvedValueOnce(ok(page({ items: [event("evt_5")], journeyEventCount: 5 })))
      .mockResolvedValueOnce(ok(page({ items: [event("evt_5"), event("evt_6")], journeyEventCount: 6 })));
    mount({ initialStatus: "active", initialCursor: "c1", totalEvents: 4 });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/journeys/jrn_1/events?cursor=c1", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/journeys/jrn_1/events?cursor=c1", expect.anything());
    expect(screen.getAllByRole("option")).toHaveLength(6);
  });

  it("keeps the previous detail when a detail fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(failed());
    mount();

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByText(/Could not load this event/)).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_1");
  });

  it("applies only the latest detail when responses arrive out of order", async () => {
    let resolveSecond: (r: Response) => void = () => undefined;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          })
      )
      .mockResolvedValueOnce(ok(detail("evt_3")));
    mount();

    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_3");
    });
    resolveSecond(ok(detail("evt_2")));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("step-evt_3");
  });
});
```

The `EventsPageResponse` import assumes Task 4 moved that interface into `api.ts`.

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm vitest run apps/web/app/components/JourneyTimeline.test.tsx
```

Expected: FAIL, `Cannot find module './JourneyTimeline'`.

- [ ] **Step 3: Write `TimelineList`**

`apps/web/app/components/TimelineList.tsx`:

```tsx
import type { KeyboardEvent } from "react";
import type { EventListItem } from "../../src/lib/api";
import {
  SKEW_THRESHOLD_SECONDS,
  dayLabel,
  fullTimestamp,
  skewSeconds,
  timeOfDay
} from "../../src/lib/time";

/** DOM id of a row, referenced by `aria-activedescendant` on the list. */
export const rowId = (eventId: string): string => `event-${eventId}`;

/**
 * The rows of the timeline: a listbox whose options are still links.
 *
 * Links, so a middle-click, a copied address, and the Playwright specs that
 * click them all keep working; the click is intercepted so the ordinary case
 * does not navigate. Arrow keys are handled on the list, not the document, so
 * typing in the search box elsewhere on the page is never hijacked.
 */
export function TimelineList({
  journeyId,
  events,
  selectedId,
  multiDay,
  onSelect,
  onArrow
}: {
  journeyId: string;
  events: readonly EventListItem[];
  selectedId: string | null;
  multiDay: boolean;
  onSelect: (id: string) => void;
  onArrow: (direction: "up" | "down") => void;
}) {
  const onKeyDown = (keyboard: KeyboardEvent<HTMLOListElement>) => {
    if (keyboard.key === "ArrowDown" || keyboard.key === "ArrowUp") {
      keyboard.preventDefault();
      onArrow(keyboard.key === "ArrowDown" ? "down" : "up");
    }
  };

  return (
    <ol
      className="timeline"
      role="listbox"
      tabIndex={0}
      aria-label="Events"
      aria-activedescendant={selectedId === null ? undefined : rowId(selectedId)}
      onKeyDown={onKeyDown}
    >
      {events.map((event) => (
        <li
          key={event.id}
          id={rowId(event.id)}
          role="option"
          aria-selected={event.id === selectedId}
          className={event.id === selectedId ? "active" : undefined}
        >
          <a
            href={`/journeys/${journeyId}?event=${event.id}`}
            tabIndex={-1}
            onClick={(click) => {
              if (click.metaKey || click.ctrlKey || click.shiftKey || click.button !== 0) return;
              click.preventDefault();
              onSelect(event.id);
            }}
          >
            <span className="mono time" title={fullTimestamp(event.eventTimestamp)}>
              {multiDay ? `${dayLabel(event.eventTimestamp)} ` : ""}
              {timeOfDay(event.eventTimestamp)}
            </span>
            <span className={event.hasError ? "op failed" : "op"}>{event.operation}</span>
            <span className="muted">{event.service}</span>
            {skewSeconds(event.eventTimestamp, event.receivedAt) > SKEW_THRESHOLD_SECONDS ? (
              <span
                className="muted"
                title={`Recorded at ${fullTimestamp(event.eventTimestamp)}, received at ${fullTimestamp(event.receivedAt)}. This service's clock may be wrong, which would put the timeline out of order.`}
              >
                ⚠ clock
              </span>
            ) : null}
          </a>
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 4: Write `FilterBar`**

`apps/web/app/components/FilterBar.tsx`:

```tsx
import type { TimelineFilters } from "../../src/lib/timeline";

/**
 * Service chips, the failures toggle, and the live toggle.
 *
 * Buttons with `aria-pressed` rather than radio inputs: a chip row is a set of
 * toggles a reader taps, and a screen reader announces "pressed" for exactly
 * the state that matters.
 */
export function FilterBar({
  services,
  filters,
  onFilters,
  status,
  live,
  onLive,
  notice
}: {
  services: readonly string[];
  filters: TimelineFilters;
  onFilters: (filters: TimelineFilters) => void;
  status: string;
  live: boolean;
  onLive: (live: boolean) => void;
  /** Why live updates stopped, if they did. */
  notice: string | null;
}) {
  return (
    <div className="filters">
      <div className="chips" role="group" aria-label="Service">
        <button
          type="button"
          className={filters.service === null ? "chip on" : "chip"}
          aria-pressed={filters.service === null}
          onClick={() => {
            onFilters({ ...filters, service: null });
          }}
        >
          All services
        </button>
        {services.map((service) => (
          <button
            key={service}
            type="button"
            className={filters.service === service ? "chip on" : "chip"}
            aria-pressed={filters.service === service}
            onClick={() => {
              onFilters({ ...filters, service });
            }}
          >
            {service}
          </button>
        ))}
      </div>
      <div className="chips">
        <button
          type="button"
          className={filters.failuresOnly ? "chip on" : "chip"}
          aria-pressed={filters.failuresOnly}
          onClick={() => {
            onFilters({ ...filters, failuresOnly: !filters.failuresOnly });
          }}
        >
          Failures only
        </button>
        {status === "active" || live ? (
          <label className="chip">
            <input
              type="checkbox"
              checked={live}
              onChange={(change) => {
                onLive(change.target.checked);
              }}
            />{" "}
            Live
          </label>
        ) : null}
      </div>
      {notice === null ? null : <p className="muted">{notice}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Write `JourneyTimeline`**

`apps/web/app/components/JourneyTimeline.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventDetailData, EventListItem, EventsPageResponse } from "../../src/lib/api";
import { spansDays } from "../../src/lib/time";
import {
  NO_FILTERS,
  applyFilters,
  describeCount,
  distinctServices,
  mergeEvents,
  neighbour,
  type TimelineFilters
} from "../../src/lib/timeline";
import { EventDetail } from "./EventDetail";
import { FilterBar } from "./FilterBar";
import { TimelineList } from "./TimelineList";

export interface JourneyTimelineProps {
  journeyId: string;
  initialStatus: string;
  initialEvents: EventListItem[];
  initialCursor: string | null;
  initialSelectedId: string | null;
  initialDetail: EventDetailData | null;
  totalEvents: number;
  /** The journey's services from the server, which may include ones not yet loaded. */
  knownServices: string[];
}

const POLL_MS = 2000;
const MAX_POLL_FAILURES = 3;
const POLL_NOTICE = "Live updates stopped after three failed requests. Turn Live on to retry.";
const PERMANENT_NOTICE =
  "Live updates stopped: this session can no longer read the journey. Sign in again or choose a project.";
const DETAIL_ERROR = "Could not load this event. Select it again to retry.";
const LOAD_ERROR = "Could not load more events. Try again.";

/**
 * Everything below the journey heading: the count line, the filters, the
 * timeline, and the selected event's detail.
 *
 * The server renders the first paint with the same data this receives as
 * props, so what a reader sees before hydration is exactly the old page. After
 * hydration every change comes from one of four places: a selection, a filter,
 * a load-more, or a poll. Each one merges or replaces; nothing else touches
 * state.
 */
export function JourneyTimeline(props: JourneyTimelineProps) {
  const { journeyId } = props;
  const [events, setEvents] = useState(props.initialEvents);
  const [cursor, setCursor] = useState(props.initialCursor);
  const [status, setStatus] = useState(props.initialStatus);
  const [total, setTotal] = useState(props.totalEvents);
  const [filters, setFilters] = useState<TimelineFilters>(NO_FILTERS);
  const [selectedId, setSelectedId] = useState(props.initialSelectedId);
  const [detail, setDetail] = useState(props.initialDetail);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [live, setLive] = useState(props.initialStatus === "active");
  const [pollNotice, setPollNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The id most recently asked for. A slower response for an earlier selection
  // must not overwrite the detail of a later one.
  const wanted = useRef(props.initialSelectedId);
  const pollFailures = useRef(0);
  // Where live mode reads from. The API's `nextCursor` is a "more pages exist"
  // flag, null on a partial page, so it cannot be the poll position: after the
  // tail of a long journey it would send the poller back to page one. Live mode
  // keeps the last cursor it was given and re-reads the tail from there, merging
  // idempotently; when the tail grows past a page, the new cursor advances it.
  // Under a hundred events there is no cursor, and page one is the tail. A long
  // journey that is still active backfills a page per tick rather than jumping
  // to the newest event; the count line says how far along that is.
  const pollFrom = useRef(props.initialCursor);
  // A poll slower than the interval must not overlap the next one: two
  // responses landing out of order would move the cursor back a page.
  const polling = useRef(false);

  const visible = useMemo(() => applyFilters(events, filters), [events, filters]);
  // From the merged list, not a server prop: a journey whose first page fell on
  // one day can cross midnight on the second.
  const multiDay = useMemo(() => spansDays(events.map((event) => event.eventTimestamp)), [events]);
  const services = useMemo(
    () => [...new Set([...props.knownServices, ...distinctServices(events)])],
    [props.knownServices, events]
  );

  const select = useCallback(
    async (id: string) => {
      wanted.current = id;
      setSelectedId(id);
      window.history.replaceState(null, "", `/journeys/${journeyId}?event=${id}`);
      setDetailState("loading");
      const result = await fetchJson<EventDetailData>(`/api/events/${encodeURIComponent(id)}`);
      if (wanted.current !== id) return;
      if (result.kind === "failed") {
        setDetailState("error");
        return;
      }
      setDetail(result.body);
      setDetailState("idle");
    },
    [journeyId]
  );

  // A filter that hides the selected event moves the selection to the first
  // visible one, so the detail panel never shows something the list does not.
  useEffect(() => {
    const first = visible[0];
    if (first === undefined) return;
    if (!visible.some((event) => event.id === selectedId)) void select(first.id);
  }, [visible, selectedId, select]);

  const onArrow = (direction: "up" | "down") => {
    const id = neighbour(visible, selectedId, direction);
    if (id !== null && id !== selectedId) void select(id);
  };

  const applyPage = useCallback((page: EventsPageResponse) => {
    setEvents((previous) => mergeEvents(previous, page.items));
    setCursor(page.nextCursor);
    if (page.nextCursor !== null) pollFrom.current = page.nextCursor;
    setStatus(page.journeyStatus);
    setTotal(page.journeyEventCount);
  }, []);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoadError(null);
    const result = await fetchJson<EventsPageResponse>(eventsUrl(journeyId, cursor));
    if (result.kind === "failed") {
      setLoadError(LOAD_ERROR);
      return;
    }
    applyPage(result.body);
  };

  // Live mode: re-read the tail from `pollFrom` every two seconds and merge.
  // A permanent refusal (signed out, no project) stops at once; anything else
  // counts toward the three failures, so a blip does not stop it and an outage
  // does not poll forever.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;

    const tick = async () => {
      if (polling.current) return;
      polling.current = true;
      let result: Fetched<EventsPageResponse>;
      try {
        result = await fetchJson<EventsPageResponse>(eventsUrl(journeyId, pollFrom.current));
      } finally {
        // fetchJson never throws today; the guard must still release if that changes.
        polling.current = false;
      }
      if (cancelled) return;
      if (result.kind === "failed") {
        pollFailures.current += 1;
        if (result.permanent || pollFailures.current >= MAX_POLL_FAILURES) {
          setLive(false);
          setPollNotice(result.permanent ? PERMANENT_NOTICE : POLL_NOTICE);
        }
        return;
      }
      pollFailures.current = 0;
      applyPage(result.body);
      if (result.body.journeyStatus !== "active") setLive(false);
    };

    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, journeyId, applyPage]);

  const onLive = (next: boolean) => {
    pollFailures.current = 0;
    setPollNotice(null);
    setLive(next);
  };

  const count = describeCount({
    visible: visible.length,
    loaded: events.length,
    total,
    complete: cursor === null
  });

  return (
    <>
      <p className="muted">
        {status} · {count} · {services.join(", ")}
      </p>
      <FilterBar
        services={services}
        filters={filters}
        onFilters={setFilters}
        status={status}
        live={live}
        onLive={onLive}
        notice={pollNotice}
      />
      <div className="journey">
        <div>
          <TimelineList
            journeyId={journeyId}
            events={visible}
            selectedId={selectedId}
            multiDay={multiDay}
            onSelect={(id) => {
              void select(id);
            }}
            onArrow={onArrow}
          />
          {cursor === null ? null : (
            <p>
              <button
                type="button"
                className="plain"
                onClick={() => {
                  void loadMore();
                }}
              >
                Show {Math.max(total - events.length, 1)} more
              </button>
            </p>
          )}
          {loadError === null ? null : <p className="error">{loadError}</p>}
        </div>
        <div className="detail">
          {detailState === "loading" ? <p className="muted">Loading…</p> : null}
          {detailState === "error" ? <p className="error">{DETAIL_ERROR}</p> : null}
          {detail === null ? (
            <p className="muted">This journey has no events yet.</p>
          ) : (
            <EventDetail event={detail} collapsibleDiff />
          )}
        </div>
      </div>
    </>
  );
}

function eventsUrl(journeyId: string, cursor: string | null): string {
  const base = `/api/journeys/${encodeURIComponent(journeyId)}/events`;
  return cursor === null ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
}

type Fetched<T> =
  | { kind: "ok"; body: T }
  | {
      kind: "failed";
      /** A 401 or 409: retrying cannot help, so the caller should stop rather than count. */
      permanent: boolean;
    };

/** Never throws: a non-2xx, a network error, and a non-JSON body are all failures. */
async function fetchJson<T>(url: string): Promise<Fetched<T>> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return { kind: "failed", permanent: response.status === 401 || response.status === 409 };
    }
    return { kind: "ok", body: (await response.json()) as T };
  } catch {
    return { kind: "failed", permanent: false };
  }
}
```

- [ ] **Step 6: Run the component tests**

```bash
pnpm vitest run apps/web/app/components/JourneyTimeline.test.tsx
```

Expected: 10 passed. If the fake-timer tests hang, the cause is `waitFor` under fake timers: those two tests use only `act` and `advanceTimersByTimeAsync`, as written, and must stay that way.

The count line is one paragraph, so its assertions use regular expressions (a string matcher in Testing Library requires the whole text to match). The load-more test expects `Show 2 more` because `total` is 6 and 4 are loaded.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm test
git add apps/web/app/components
git commit -m "feat(web): a client-side timeline that filters, walks, pages and follows a live journey

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Mount it in the page, and style the new elements

**Files:**
- Modify: `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Rewrite the page body**

Replace the whole of `apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx` with:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { JourneyTimeline } from "../../../components/JourneyTimeline";
import { ApiUnavailableError, getEvent, getJourney, listEvents } from "../../../../src/lib/api";
import { requireProjectId } from "../../../../src/lib/current-project";

export default async function JourneyPage({
  params,
  searchParams
}: {
  params: Promise<{ journeyId: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { journeyId } = await params;
  const { event: selectedId } = await searchParams;

  try {
    // Inside the try: this call reaches the API, and when it threw from
    // outside there was nothing to catch it and no error boundary anywhere in
    // the app, so a booting API rendered a blank HTTP 500.
    const projectId = await requireProjectId(`/journeys/${journeyId}`);
    const journey = await getJourney(journeyId, projectId);
    if (journey === null) notFound();

    const page = await listEvents(journeyId, projectId);
    if (page === null) notFound();

    // Default to the first event so the detail panel is never empty on arrival.
    const activeId = selectedId ?? page.items[0]?.id ?? null;
    const active = activeId === null ? null : await getEvent(activeId, projectId);

    return (
      <main>
        <p className="muted">
          <Link href="/">← Search</Link>
        </p>
        <h1 className="mono">
          {journey.entity.type}: {journey.entity.id ?? "—"}
        </h1>
        <p className="muted">All times UTC.</p>

        {journey.aliases.length === 0 ? null : (
          <p className="muted">
            Also known as{" "}
            {journey.aliases.map((a) => `${a.type} ${a.displayValue ?? "—"}`).join(", ")}. These
            identifiers all refer to the same record.
          </p>
        )}

        <JourneyTimeline
          journeyId={journeyId}
          initialStatus={journey.status}
          initialEvents={page.items}
          initialCursor={page.nextCursor}
          initialSelectedId={activeId}
          initialDetail={active}
          totalEvents={journey.eventCount}
          knownServices={journey.services}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof ApiUnavailableError) {
      return <p className="error">Cannot reach the Flight Recorder API. Is it running?</p>;
    }
    throw error;
  }
}
```

The `shown()` helper at the bottom of the old file is deleted; `describeCount` replaced it in Task 2.

- [ ] **Step 2: Add the styles**

Append to `apps/web/app/globals.css`:

```css
/* Timeline filters: a row of toggles, not a form. */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  margin-top: 0.5rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.chip {
  font-size: 0.8rem;
  padding: 0.25rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.chip.on {
  border-color: var(--accent);
  color: var(--fg);
}
.chip input {
  margin: 0 0.1rem 0 0;
  vertical-align: -1px;
}

/* The listbox takes focus so arrow keys work; say so. */
.timeline:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* A button that reads as a link: load more, show more rows. */
button.plain {
  background: transparent;
  color: var(--accent);
  border: none;
  padding: 0.35rem 0;
  cursor: pointer;
}
button.plain:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Rebuild the web image and look at it**

```bash
API_PORT=8081 WEB_PORT=3001 docker compose -p frdev -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d --wait web
```

Open `http://localhost:3001`, sign in, search `0018Z00002ABC`, open the journey. Check: the count line reads `failed · 10 events · demo-integration, demo-worker`; clicking the timeline focus ring appears on Tab; ArrowDown moves the selection and the detail follows; the address bar's `?event=` updates; "Failures only" leaves four rows; no Live checkbox because the journey is finished. Then trigger a new journey with `curl -s -X POST http://localhost:3100/trigger` and open its link within ten seconds: the Live checkbox is checked and rows appear as the queue retries, and it unchecks itself when the journey reaches `failed`.

- [ ] **Step 4: Run the unit suites and the existing browser suite**

```bash
pnpm test
WEB_URL=http://localhost:3001 API_URL=http://localhost:8081 ADMIN_TOKEN=replace-for-local-development-0000 FLIGHT_API_KEY=fr_demo00000000000000000000000000000 pnpm test:e2e
```

The key is the demo stack's committed placeholder from `infrastructure/compose.demo.yaml`; the spec seeds its own journey through the API with it. Expected: all 8 existing Playwright specs pass unchanged.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm typecheck
git add "apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx" apps/web/app/globals.css
git commit -m "feat(web): the journey page mounts the interactive timeline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Browser test for the keyboard path and the failures filter

**Files:**
- Modify: `apps/web/e2e/journey.spec.ts`

- [ ] **Step 0: Make the seed independent of the demo**

The spec seeds `jrn_e2e_demo` with entity id `0018Z00002ABC`, the same id every
demo-triggered journey uses, so `finds the customer by entity id` (which expects
exactly one result) fails on any database that has run the demo. Change the
constant at the top of `apps/web/e2e/journey.spec.ts` to
`const ENTITY_ID = "E2E-0018Z00002ABC";` and leave `ALIAS_VALUE` as it is; the
transformed step's `input.Id` and `output.externalId` follow the constant.

Changing the entity id alone is not enough on a database that has already run
the old suite: event ids are project-scoped (`ingest-event.ts` hashes the whole
event and the repository conflicts on `[project_id, id]`), so re-posting `evt_1`
with a new entity id answers 409, and `ensureJourney` ignores conflicts, so the
existing `jrn_e2e_demo` keeps its old entity. Version the seed's identity as
well: `JOURNEY_ID = "jrn_e2e_demo_v2"` and event ids `evt_v2_1` … `evt_v2_8`,
with a comment at the top of the file saying to bump the version whenever the
seeded data changes. Re-run the existing suite before adding the new test:
8 passed regardless of whether the demo or the old suite has run.

- [ ] **Step 1: Add the test**

Append to `apps/web/e2e/journey.spec.ts`:

```ts
test("walks the timeline with the keyboard and narrows it to failures without reloading", async ({
  page
}) => {
  await signIn(page);
  await page.goto(`/journeys/${JOURNEY_ID}`);
  await expect(page.locator(".detail h2")).toHaveText("receive-salesforce-webhook");

  await page.locator(".timeline").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  await expect(page.locator(".detail h2")).toHaveText("persist-customer");
  await expect(page).toHaveURL(/event=evt_v2_3$/);
  await expect(page.locator(".timeline li.active")).toContainText("persisted");

  await page.getByRole("button", { name: "Failures only" }).click();

  // evt_v2_6 and evt_v2_7 carry an error; the dead-letter event itself does not.
  await expect(page.locator(".timeline li")).toHaveCount(2);
  await expect(page.locator(".detail h2")).toHaveText("deliver-customer-to-target");
  await expect(page.getByText("2 of 8 events shown")).toBeVisible();
});
```

- [ ] **Step 2: Run the browser suite against the running stack**

```bash
WEB_URL=http://localhost:3001 API_URL=http://localhost:8081 ADMIN_TOKEN=replace-for-local-development-0000 FLIGHT_API_KEY=fr_demo00000000000000000000000000000 pnpm test:e2e
```

Expected: 9 passed.

- [ ] **Step 3: Commit**

```bash
pnpm format && pnpm lint
git add apps/web/e2e/journey.spec.ts
git commit -m "test(e2e): the keyboard path and the failures filter

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Changelog, debt, and the merge

**Files:**
- Modify: `CHANGELOG.md`
- Verify: `npx debtwatch list` no longer lists `DEBT-43WEMV`

- [ ] **Step 1: Changelog entry**

Under `## [Unreleased]`, in the `### Added` section that begins with the `project:create` entry, add before it:

```markdown
- **The timeline is interactive.** Filter a journey to one service or to its
  failures, move through events with the arrow keys while the detail panel
  follows, watch a journey that is still in progress fill in, and read past
  the first hundred events with a cursor instead of a cap. The first paint is
  still server-rendered and the rows are still links, so nothing that worked
  before stopped working; the browser talks only to two session-checked route
  handlers, never to the API (ADR-029). Long diffs collapse to eight rows.
```

- [ ] **Step 1b: Three small cleanups from the reviews**

- `apps/web/src/lib/route-errors.ts`: `jsonError` responses carry no `Cache-Control`, and a 404 is heuristically cacheable, so an intermediary could store "no such event" for an event about to exist. Add `headers: { "cache-control": "no-store" }` to the `NextResponse.json` call in `jsonError`, with a one-line comment, and extend `route-errors.test.ts` to assert the header on the 409 response.
- `apps/web/src/lib/timeline.test.ts`: the shared `eventCounter` interpolates unpadded into the seconds field, so the tenth `event()` call in the file would produce the invalid instant `10:00:010.000Z`. Pad with `String(counter).padStart(2, "0")`, and pin the "newer copy of evt_2" fixture to the timestamps of the event it replaces (the API cannot change an event's timestamp).
- `test-results/.last-run.json` is tracked, so every Playwright run dirties the tree, and failure artifacts land untracked beside it. Add `test-results/` to `.gitignore` and `git rm --cached -r test-results`.
- `docs/TESTING_STRATEGY.md`: section 2 lists what the unit layer covers; add one bullet for React components rendered under jsdom with Testing Library (`apps/web/**/*.test.tsx`, the `web` Vitest project), and one line noting route handlers are tested under node with a mocked API client.

Commit these together:

```bash
git add .gitignore apps/web/src/lib/route-errors.ts apps/web/src/lib/route-errors.test.ts apps/web/src/lib/timeline.test.ts docs/TESTING_STRATEGY.md
git commit -m "chore(web): no-store on error responses, an honest test fixture, and the testing strategy names the new layers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Confirm the debt declaration is gone and the docs test passes**

```bash
npx debtwatch list 2>&1 | grep -c DEBT-43WEMV
pnpm vitest run tests/docs-truth.test.ts
```

Expected: `0` and seven remaining items, and the docs test passes. DebtWatch tracks declarations that exist in the tree; deleting the declaration with the shortcut it described is how debt is paid.

- [ ] **Step 3: Full verification on a clean clone**

```bash
S=/private/tmp/claude-501/-Users-jorgepolanco-workspace/80a8067d-42c1-43f1-abbf-0b8085479f59/scratchpad
rm -rf "$S/verify" && git clone -q . "$S/verify" && cd "$S/verify" && git checkout -q interactive-timeline
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
API_PORT=8081 WEB_PORT=3001 docker compose -p frverify -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml up --build -d --wait
FLIGHT_API_URL=http://localhost:8081 pnpm test:demo
WEB_URL=http://localhost:3001 API_URL=http://localhost:8081 ADMIN_TOKEN=replace-for-local-development-0000 FLIGHT_API_KEY=fr_demo00000000000000000000000000000 pnpm test:e2e
API_PORT=8081 WEB_PORT=3001 docker compose -p frverify -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml down -v
cd /Users/jorgepolanco/workspace/flight-recorder
```

Expected: every command exits 0; the demo suite reports 7 passed and the browser suite 9 passed.

- [ ] **Step 4: Merge and push, then watch CI**

```bash
git add CHANGELOG.md && git commit -m "docs: changelog for the interactive timeline

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git checkout main && git merge --no-ff interactive-timeline -m "Merge: the journey timeline is interactive

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
glab ci list --per-page 1
```

Poll the pipeline until it finishes. Expected: `success`. The `e2e` and `demo` jobs are manual; trigger both from the pipeline page (`glab ci run` does not start manual jobs; use `glab api -X POST "projects/jojithedev%2Fflight-recorder/jobs/<id>/play"` with the job id from `glab api "projects/jojithedev%2Fflight-recorder/pipelines/<id>/jobs"`) and confirm both pass, since this change is the first that a browser test protects.

- [ ] **Step 5: Tear down the development stack**

```bash
API_PORT=8081 WEB_PORT=3001 docker compose -p frdev -f infrastructure/compose.yaml -f infrastructure/compose.demo.yaml down -v
```
