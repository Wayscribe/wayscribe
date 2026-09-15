# Recent Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is test-first. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A reader with no identifier can see recent failed (or any) journeys by environment, service, and time window, from the API and from a Recent page in the web app.

**Spec:** `docs/superpowers/specs/2026-09-15-recent-journeys-design.md` (authoritative for behaviour).

**Conventions for every task:** as in `docs/superpowers/plans/2026-09-15-key-rotation.md` (Node 24 PATH prefix; `pnpm format && pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm test:integration` when the database or API is touched; explicit return types; no non-null assertions; comments explain why; no em dashes in docs prose; commit trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`). Branch `recent-journeys`. Stage only your own files.

---

## Task 1: List endpoint

**Files:** `packages/database/migrations/013_journeys_status_recent_index.js`, `packages/database/src/repositories/journey-list.ts` and `journey-list.integration.test.ts` (create), `packages/database/src/index.ts`, `apps/api/src/routes/queries.ts` or a new `apps/api/src/routes/journeys.ts` with its integration test, shared helpers extracted from the search route where reuse needs it.

Build the repository function, the migration, and `GET /v1/journeys` per the spec.

Prove: the spec's database and API integration items, and the `EXPLAIN` evidence on a database seeded with at least 100,000 journeys (a script in the task report, not committed unless it is small and reusable).

## Task 2: Recent page

**Files:** `apps/web/src/lib/api.ts`, `apps/web/app/(authenticated)/recent/page.tsx` (create), the search page (a link to Recent in its heading area), a shared result-row component if the markup is shared, `apps/web/app/globals.css` only if needed, `apps/web/e2e/` (a new spec or an addition, seeding its own journeys with the versioned-seed pattern).

Prove: the spec's web item; the existing Playwright specs still pass.

## Task 3: Documentation

**Files:** `docs/API_SPEC.md`, `README.md`, `CHANGELOG.md`.

Prove: docs-truth test passes; the documented query parameters are the ones Task 1 validates.
