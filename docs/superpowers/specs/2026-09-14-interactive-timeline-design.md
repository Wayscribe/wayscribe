# Interactive journey timeline — design

Date: 2026-09-14. Status: approved for planning.

## Why

The journey page is the product: one record, every service that touched it, and
the step where a value changed. Today it is server-rendered and every
interaction is a full navigation. That is correct and fast, but it cannot do
four things a reader wants while investigating:

- narrow a long timeline to one service, or to the failures;
- walk events with the keyboard while the detail panel follows;
- watch a journey that is still in progress;
- read past the first hundred events without the page stopping.

This is also the frontend slice agreed for the portfolio: React and TypeScript,
tested, small enough to explain under a timer. It must fit the existing page
rather than replace it.

## Constraints that shape the design

- **The admin token never reaches the browser** (ADR-029). Every request the
  browser makes goes to a Next route handler that verifies the session cookie
  and calls the API server-side, as `app/api/replay/route.ts` does today.
- **Existing behaviour and tests keep working.** The eight Playwright specs in
  `apps/web/e2e/journey.spec.ts` click timeline links and read the diff. Rows
  therefore stay links with `?event=` hrefs, and the first paint is still
  server-rendered.
- **No new runtime dependencies in the web app.** React, Next and zod are
  enough. Test-only dependencies are allowed.
- **No API changes.** The read endpoints already paginate with a cursor and
  return the journey status.

## Architecture

Option chosen: a client island inside the existing server page.

```text
JourneyPage (server)                       route handlers (server)
  fetch journey, first events page,          GET /api/journeys/[id]/events?cursor=
  first event detail                         GET /api/events/[id]
  └─ <JourneyTimeline …initial data>  ──▶    both: verify session, resolve project,
       (client)                              proxy through src/lib/api.ts
```

The server page keeps doing what it does. It renders the header (entity,
status, count, services, aliases) and passes the journey, the first page of
events with its `nextCursor`, and the first event's detail to one client
component. The client component owns everything below the header.

## Components

All under `apps/web`.

### `src/lib/timeline.ts` — pure logic, no React

Exported functions, each unit-tested without a DOM:

- `applyFilters(events, filters)` — `filters` is `{ service: string | null,
  failuresOnly: boolean }`. Returns the visible subset in original order.
- `neighbour(visible, selectedId, direction)` — the id one step up or down
  within the visible list. At an edge, returns the same id. If the selected
  event is not visible (it was filtered out), returns the first visible id.
- `mergeEvents(existing, incoming)` — union by id, ordered by
  `eventTimestamp` then `id`, so a polled page can be merged repeatedly without
  duplicates and without reordering what is already on screen.
- `services(events)` — distinct service names in first-seen order, for the
  filter chips.

### `app/components/JourneyTimeline.tsx` — `"use client"`, the state owner

Props: `journeyId`, `initialStatus`, `initialEvents`, `initialCursor`,
`initialSelected` (the detail already fetched by the server, may be null),
`multiDay`.

State: `events`, `cursor`, `status`, `filters`, `selectedId`, `detail`,
`detailError`, `live`, `pollFailures`.

Behaviour:

- **Selection.** Clicking a row calls `preventDefault`, sets `selectedId`,
  fetches `/api/events/:id`, and updates the URL with `history.replaceState`
  so the address bar still deep-links. While loading, the previous detail stays
  on screen with a muted "Loading" line under the heading; there is no
  spinner and nothing is blanked.
- **Keyboard.** `ArrowUp` and `ArrowDown` move the selection through the
  visible list using `neighbour`. `Enter` on a focused row selects it. The list
  is a `role="listbox"` with `aria-activedescendant`; rows are
  `role="option"`. Arrow handling is on the list, not the document, so typing
  elsewhere is unaffected.
- **Filters.** Chips for "All services" and each distinct service, plus a
  "Failures only" toggle. Filtering never changes `events`; it changes what is
  rendered. If the selected event is filtered out, the selection moves to the
  first visible event.
- **Load more.** When `cursor` is not null, a "Show N more" line at the foot of
  the list fetches the next page and merges it. The header count line already
  says "showing X of Y"; that text now comes from the client state.
- **Live.** A toggle, on by default only when `initialStatus === "active"`.
  While on, every two seconds it fetches the events route with the latest
  cursor (or no cursor when there is none, in which case it refetches the
  first page and merges). The response carries `journeyStatus`; when it is no
  longer `active`, polling stops and the header shows the final status. After
  three consecutive failed polls, polling stops and a one-line notice says so,
  with the toggle available to restart it. A failed poll never clears the list.
- **Errors.** A failed detail fetch shows a one-line error under the heading
  and keeps the last detail. A failed load-more shows the same line at the
  foot of the list. The page-level error boundary is not involved: nothing
  here throws during render.

### `app/components/FilterBar.tsx` and `TimelineList.tsx` — presentational

No state. `TimelineList` renders rows exactly as the server page does today
(time, operation, service, clock warning), plus the ARIA roles above. Both take
callbacks from the state owner.

### `app/components/DiffTable.tsx` — collapsed mode

Gains a `collapsible` prop (default false, so the replay page is unchanged).
When true and there are more than eight rows, it renders the first eight and a
"Show N more" button that reveals the rest. Rows are not reordered: the API's
order is the order a reader can reason about. The component becomes
`"use client"` because of the one `useState`; it can still be rendered from
server components.

### Route handlers

- `app/api/journeys/[journeyId]/events/route.ts` — `GET`, optional `cursor`
  query. Returns `{ items, nextCursor, journeyStatus }`. Fetches one page of
  events and the journey in parallel through `src/lib/api.ts`.
- `app/api/events/[eventId]/route.ts` — `GET`. Returns the event detail as
  `src/lib/api.ts` shapes it.

Both: verify the session cookie, respond 401 as JSON when absent or invalid,
pass the session's project id through even when it is empty (the API resolves
the only project itself and reports ambiguity as `project_not_found`), respond 404 as JSON when the API returns null, and 502 as JSON
on `ApiUnavailableError`. The session check moves out of the replay handler into
`src/lib/request-session.ts` so every route handler shares one implementation;
the web layer no longer resolves the project, because the API already does.

The route handlers respond with the same shapes `src/lib/api.ts` returns. The
client types are imported from there; nothing is duplicated.

`listEvents` in `src/lib/api.ts` currently loops over up to six pages to work
around the old hundred-row cap. It becomes a single-page call returning
`{ items, nextCursor }`; the server page passes the cursor to the client, which
owns pagination from then on. The DebtWatch declaration `DEBT-43WEMV` on that
function is retired with it, because the truncation it declared no longer
exists.

## Data flow

1. Server page fetches journey, events page one, and the first event's detail.
2. It renders the header and mounts `JourneyTimeline` with that data. What
   a reader sees before hydration is exactly today's page.
3. After hydration, interactions call the two route handlers. Every response
   passes through `mergeEvents` or replaces `detail`; nothing else mutates
   state.
4. The URL's `?event=` follows the selection, so reloading or sharing the
   address lands on the same event through the server path in step 1.

## Testing

- **Unit, no DOM:** `src/lib/timeline.test.ts` covers filtering, neighbour at
  edges and under a filter, merge idempotence and ordering, and service
  ordering. `src/lib/request-session.test.ts` covers the shared session check
  with a signed and an invalid cookie.
- **Component, jsdom:** `app/components/JourneyTimeline.test.tsx` with React
  Testing Library and a mocked `fetch`: arrow keys move the selection and the
  detail request is made for the new id; the failures filter hides rows and
  moves the selection; load more merges a page and the count line updates;
  polling stops when the status leaves `active`; three failed polls stop it
  with the notice; a failed detail fetch keeps the previous detail. The web
  app gets its own Vitest project (`environment: "jsdom"`, TSX via the
  automatic runtime) included in `pnpm test`.
- **Browser, Playwright:** one new spec against the demo journey: open it,
  press ArrowDown twice, assert the detail heading changed without navigation;
  toggle failures only, assert four rows remain and the selection is the
  first failure.
- The existing eight specs must pass unchanged.

New dev dependencies: `@testing-library/react`, `@testing-library/user-event`,
`@testing-library/jest-dom`, `jsdom`. No new runtime dependencies.

## Out of scope

- No state library, no data-fetching library, no design system.
- No styling rewrite. New elements use the existing classes in `globals.css`
  and add at most a few rules for chips and the active row.
- No API changes and no new endpoints in `apps/api`.
- Search page and replay page are untouched.

## What done means

A reader on the demo journey can filter to failures, arrow through them, and
read each diff without the page reloading; a journey still in progress fills
in while they watch; a journey longer than one page can be read to the end;
and all of it is covered by tests that run in `pnpm test` and `pnpm test:e2e`.
