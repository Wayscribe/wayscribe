# Phase 2b-ii: Entity-First Web Interface — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** Login, search, and the journey view with timeline and transformation diff, plus
Playwright coverage. This completes Phase 2.

## 1. Context

Phase 2a exposed the query API. Phase 2b-i added the admin principal and the session
primitives. This phase is the interface those exist for: the first point at which a
developer can search a customer and see where its data changed without writing a `curl`
command.

## 2. Layout decisions

Two layout choices were made against wireframes rather than in prose.

**The journey view is master–detail: timeline left, event detail right.** When a developer
finds the transformation that broke a record, the next question is always "and what
happened after?" — the retries, the dead-letter. Keeping the timeline visible answers that
without navigation. The cost is diff width, and the alternative of a horizontal step strip
was rejected because a fixed strip stops working past roughly ten steps while the
reference journey already has eight.

**The transformation diff renders as a field table — path, before, after — not a unified
`−/+` view.** We compute a *structural* diff, a list of `{path, kind, before, after}`. A
unified view looks like git and is instantly familiar, but it implies a textual comparison
we do not perform, and it breaks down here specifically: the input carries `Phone` while
the output carries `phone`, so a unified rendering must pick one column's field naming and
misleads either way. A table also scales — a forty-field payload with two changes shows
two rows rather than forty lines to scan — and it makes ADR-025's index-based array
comparison legible instead of a wall of red.

## 3. Routes

| Route | Renders |
|---|---|
| `/login` | Token form; posts to a route handler |
| `/` | Search input and journey results |
| `/journeys/[journeyId]` | Timeline and event detail |

**Event selection is a URL parameter (`?event=evt_x`), not client state.** A specific step
becomes linkable, so a developer investigating an incident can paste the exact event into
a ticket, and the back button behaves. Next's App Router treats it as a client-side
transition fetching only the changed segment.

A route-group layout, `apps/web/app/(authenticated)/layout.tsx`, gates every route except
`/login` and redirects unauthenticated requests. Not Next middleware, because middleware
runs on the Edge runtime, which has no `node:crypto`, and session verification needs it.
One gate, rather than a check each page could forget.

## 4. Data flow

The browser never contacts the API. Server components call it with the admin token held
server-side, as settled in Phase 2b-i.

Two modules carry the seams:

- `src/lib/config.ts` parses `ADMIN_TOKEN` and `API_URL` through Zod at boot, mirroring
  the fail-fast pattern in `packages/config`.
- `src/lib/api.ts` is the only module that knows the API contract, attaching the admin
  token and returning typed results.

## 5. Styling

Plain CSS modules with a small design-token file. No framework.

Tailwind is the conventional pick, but this is four pages, and ADR-012's lightweight
commitment covers what a contributor must install and understand, not only what runs in
production. Adding a framework later is easy; removing one is not.

## 6. States

Each of these renders deliberately rather than crashing:

- search with no results
- search before any query is entered
- journey not found
- an event with no captured payload
- the API unreachable

Plain-language explanations of journey, alias, and transformation appear in the interface,
per `TASKS.md` Epic 7, so someone who has never used a tracing tool can read the screen.

## 7. Testing

Playwright drives a real browser against the real stack.

**It seeds by ingesting through `POST /v1/events`.** The demo services that would produce
this data by actually running a broken integration do not exist until Phase 5, so the test
constructs the reference journey itself: webhook receipt, transformation, persistence,
publication, consumption, failed delivery, two retries, and the dead-letter transition.

Coverage:

- an unauthenticated visit redirects to login
- a wrong token is rejected and a correct one lands on search
- searching `0018Z00002ABC` finds the customer
- the timeline renders all eight events in chronological order
- selecting the transform event shows `phone` changing from `"+1 919 555 1234"` to `null`
  in the field table
- the alias renders masked
- empty search, unknown journey, and API-unreachable each render a real state

### What this does not prove

These tests assert that the interface renders what the API returns. They do **not** prove
the reference scenario works end to end, because nothing yet produces that data by running
a genuinely broken integration — the test fabricates it.

That end-to-end proof is the Phase 5 release gate. Recording the limitation here so a
green browser suite is not mistaken for the product proof.

## 8. Acceptance criteria

- An unauthenticated visit to any route redirects to login.
- A correct admin token establishes a session; a wrong one does not, and repeated failures
  are throttled.
- Searching an entity ID or an alias value returns the journey.
- The journey view lists events in deterministic chronological order.
- Selecting the transformation event shows the changed field, its before value, and its
  after value.
- Alias display values are masked; the primary entity ID is not.
- Empty, missing, and unreachable states render rather than crash.
- `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, and CI pass on a clean clone.

## 9. Not in this phase

The demo services and the end-to-end product proof (Phase 5), replay (Phase 6), the SDK
(Phase 3), propagation (Phase 4), and retention.
