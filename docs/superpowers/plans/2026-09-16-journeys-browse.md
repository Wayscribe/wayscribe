# Browsing Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is test-first. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A reader can browse what happened in any period and find a journey from
part of a label or a displayable alias, on a Journeys page laid out as a dense
table.

**Spec:** `docs/superpowers/specs/2026-09-16-journeys-browse-design.md`. The spec
is authoritative for behaviour; this plan fixes the order, the file boundaries,
and what each task must prove.

**Architecture:** one optional event field (`journeyLabel`) carries public
display text; ingestion keeps a label and a last step on the journey row under a
"latest operation start wins" rule, and a plain-text copy of each displayable
alias value that disappears when the flag falls. The journey list gains `until`,
`entityType` and `q` (case-insensitive contains over those public values only).
The Recent page becomes a Journeys page.

**Tech stack:** TypeScript, Node 24, Zod 4, Fastify, Knex, PostgreSQL 17 (15
supported), Next.js 15 (React 19), Vitest, Playwright, Testcontainers.

**Branch:** `journeys-browse`, from main `6f2d66a` or later.

## Conventions for every task

- Prefix commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`; run from the repository root.
- Test first: write the test, run it, watch it fail for the right reason, then implement.
- Before each commit: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`. Tasks touching the database, the API or ingestion also run `pnpm test:integration`.
- `.ts` files need explicit return types; `noUncheckedIndexedAccess` is on; no non-null assertions.
- Comments explain why. No em dashes in docs prose or CHANGELOG entries.
- No new identifier carrying the product name (no header, queue attribute, environment variable, key prefix or metric name).
- Any wire or SDK behaviour change updates, in the same task: `docs/INGESTION_CONTRACT.md` and/or `docs/SDK_SPEC.md`, the generated JSON Schema (`pnpm --filter @flight-recorder/protocol run schemas`), conformance cases and the manifest (`pnpm --filter @flight-recorder/protocol run conformance:manifest`).
- Migrations follow `packages/database/migrations/017_alias_displayable.js`: nullable columns with no default or a constant default only, `set local lock_timeout = '5s'`, a down migration, and a comment on why it is safe live.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Stage only your own files. Docker stacks use a unique `-p` name; check ports first with `lsof -nP -iTCP -sTCP:LISTEN` (8080 is held by another process; the owner's `frdogfood` stack on 8090 and 3100 must not be touched); `down -v` afterwards; stop only processes you start, by PID. Never type tokens with browser tools.

---

## Task 1: `journeyLabel` on the wire

**Files:** `packages/protocol/src/event.ts` (+ its test), `packages/protocol/schemas/0.1/*` (regenerated), `packages/protocol/fixtures/v0.1-boundaries.json`, `packages/protocol/conformance/wire/*.json` (new cases), `packages/protocol/conformance/manifest.json`, `docs/EVENT_PROTOCOL.md`, `docs/INGESTION_CONTRACT.md`.

- [ ] Add optional `journeyLabel`: a string of 1 to 200 characters counted as Unicode code points, the same way the other capped strings in `event.ts` are counted. An empty string is `invalid_event`.
- [ ] Boundary fixtures: 200 and 201 code points (including astral characters), empty, non-string.
- [ ] Wire conformance cases: a label is accepted (stored expectations are added in Task 3, so this task asserts acceptance only, or mark the stored part pending if the harness requires it: follow how `displayable-alias` was added); an empty label is refused per event with `details[0].path = "event.journeyLabel"`.
- [ ] Contract text in §2 (fields) and the refusal table if it lists paths.

**Prove:** protocol unit tests (the new boundary cases fail first); drift and parity tests pass after regeneration; conformance manifest test passes with the new ids.

## Task 2: Migration 018

**Files:** `packages/database/migrations/018_journey_browse.js` (create), migration tests beside `017`'s (no table rewrite; gives up behind a held lock; retriable), `packages/database/src/migration-status.integration.test.ts` (count 18), `docs/DATABASE_SCHEMA.md`.

- [ ] `journeys.label text null`, `journeys.label_at timestamptz null`, `journeys.label_event_id text null`, `journeys.last_step text null`, `journeys.last_step_at timestamptz null`, `journeys.last_step_event_id text null`, `entity_aliases.display_value text null`. No defaults. One migration, `lock_timeout = '5s'`, `add column if not exists`, down migration drops them.
- [ ] Comment: catalogue-only changes; the previous API writes rows without these columns and they read as null, which the UI shows as "no label" (the spec's no-backfill rule).

**Prove:** the relfilenode of `journeys` and `entity_aliases` is unchanged across the migration; a held `access exclusive`-conflicting lock makes it fail within about five seconds and a rerun succeeds; `doctor` reports no pending migrations after it.

## Task 3: Ingestion keeps the label, the last step, and plain-text displayable values

**Files:** `packages/database/src/repositories/journeys.ts` and/or `journey-summary.ts` (the journey upsert), `packages/database/src/repositories/aliases.ts` (`upsertAliases`), `packages/database/src/repositories/rotation.ts` (duplicate folding), `apps/api/src/ingestion/ingest-event.ts`, integration tests beside each, `packages/protocol/conformance/wire/*.json` (stored expectations for the label and for `display_value` through the read routes once Task 5 exposes them: if the read shape is not yet available, assert through the database in the integration tests here and add the conformance stored expectations in Task 5).

- [ ] Label rule: update `label`, `label_at`, `label_event_id` only when the event carries `journeyLabel` and `(event.timestamp, event.id)` is greater than `(label_at, label_event_id)` (null counts as smallest). Do it in the same statement as the existing journey upsert, with no extra round trip if practical.
- [ ] Last step rule: `last_step`, `last_step_at` from the event's step name (the field the timeline labels rows with; confirm its name in `event.ts`), updated only when `(event.timestamp, event.id)` is greater than `(last_step_at, last_step_event_id)`, the same rule as the label.
- [ ] `display_value`: when an alias row is inserted or updated with `displayable = true`, store the plain value; when the flag falls (the existing "only falls" upsert), set `display_value = null` in the same statement. Never set it for a masked alias.
- [ ] Rotation folding keeps the survivor's `display_value` only if the folded flag is still true, and nulls it otherwise.
- [ ] Dry run (ADR-050) previews the same values and writes nothing.

**Prove (PostgreSQL):** out-of-order label events (older event arriving last keeps the newer label; tie broken by event id); last step never moves backwards; `display_value` present only while displayable, cleared in the same statement when the flag falls, including under concurrent ingestion (reuse the reviewer's concurrency pattern from the dogfood-gaps branch: many rounds, zero rows with `displayable = false and display_value is not null`); a masked alias never gets a `display_value`; rotation folding; `delete:journey`, erasure, `delete:range` and the retention sweep leave no `display_value` or label behind for the removed journeys; dry run writes nothing.

## Task 4: The SDK sets a label

**Files:** `packages/sdk-node/src/recorder.ts` (the `Journey` interface and the payload-fit step that ADR-051 added), SDK tests, `packages/protocol/conformance/sdk/*.json`, manifest, `docs/SDK_SPEC.md`, `packages/sdk-node/README.md`, `CHANGELOG.md`.

- [ ] `journey.label(text: string): void` records nothing by itself; it sets the label carried by the journey's next event and every later one (decide and document: carrying it on every later event is simplest and makes the conflict rule harmless; carrying it once risks losing it if that event is dropped).
- [ ] Also accept `label` in the options of `startJourney` / `continueJourney` if that fits the existing option shapes.
- [ ] Apply the 200 code point limit before sending, using the shared limits from `payload-security` so SDK and API agree by construction; a longer label is cut and reported with the existing truncation diagnostic and counter; an empty or non-string label is dropped with a diagnostic and the event is still sent.
- [ ] `across(journeys)` groups: labels are per journey, so the group does not offer `label`.
- [ ] `SDK_SPEC.md`: a numbered MUST for the limit and the empty-label rule, a SHOULD for label content ("not personal data"), each with a source.
- [ ] README: how to set a label, what it is for, that it is shown and searchable in full, and not to put personal data in it.

**Prove:** SDK unit tests (set, carried on later events, cut at 200 code points with an astral character at the boundary, empty dropped with the event still sent, never throws into the host); SDK conformance cases pass through the stub and through the dry run.

## Task 5: The journey list API

**Files:** `apps/api/src/routes/queries.ts`, `packages/database/src/repositories/journey-list.ts` (+ `journey-keyset.ts` if the cursor shape changes), `apps/api/src/routes/present.ts`, `packages/protocol/src/ingestion.ts` or wherever the list response schema lives (regenerate schemas), integration tests, `docs/API_SPEC.md`, `docs/INGESTION_CONTRACT.md` if it describes read shapes, conformance stored expectations deferred from Task 3.

- [ ] `until` (optional, must be after `since`, same validation as `since` including the clock-skew rule only where it makes sense), `entityType` (optional, exact, length-capped, NUL refused), `q` (optional, 2 to 200 characters, NUL refused, repeated key refused).
- [ ] `q` matches, case-insensitively and as "contains", `journeys.label` or any `entity_aliases.display_value` of the journey, within the window and the caller's scope. Escape `%`, `_` and `\`. Never match masked values or entity ids.
- [ ] Rows gain `label`, `displayableAliases` (array of `{ type, value }`, displayable only, in alias-type order) and `lastStep`.
- [ ] The cursor stays stable when `q`, `until` or `entityType` are set (a cursor from one filter set used with another is refused or ignored: decide and test).

**Prove (PostgreSQL):** each parameter's validation; `q` finds by label and by displayable value, not by a masked alias value or the entity id (use the same text in a masked alias to prove it); `%`, `_` and `\` are literal; case-insensitive; an API key never sees another environment's journeys through `q`; `until` and `entityType`; paging with filters returns every row exactly once.

## Task 6: Measure the list at 120,000 journeys

**Files:** `scripts/measure-search.mjs` or the existing measurement script that produced the 1.1 s search figure (extend it rather than adding a new one), `docs/OPERATIONS.md` (sizing section), and an index migration only if needed.

- [ ] Seed 120,000 journeys with labels and displayable aliases in a realistic shape (distinct values, a few common substrings), and measure p50 and p95 of the list with no filter, with `q` matching many rows, with `q` matching none, and with `q` plus `entityType`, over 24 hours and 30 days.
- [ ] If any `q` case is over one second at p95, add an index that needs no extension (for example on `lower(label)` or a partial index on `display_value is not null`), as migration 019 under the same rules as 018, and measure again. Record both numbers.

**Prove:** the numbers are in OPERATIONS with the machine, PostgreSQL version and data shape stated.

## Task 7: The Journeys page

**Files:** `apps/web/app/(authenticated)/journeys/page.tsx` (the list; the existing `journeys/[journeyId]` detail stays), `apps/web/app/(authenticated)/recent/page.tsx` (becomes a redirect keeping the query string), `apps/web/src/lib/recent-filters.ts` (rename or extend to journey filters: `q`, `until`, `entityType`, presets 1h/24h/7d/30d/custom, default any status and 24h), `apps/web/app/components/FilterBar.tsx`, `JourneyRow.tsx` (table row: last activity, status, entity type, shown as, last step, events), `apps/web/src/lib/api-client.ts`, navigation link in `apps/web/app/(authenticated)/layout.tsx`, `globals.css`, unit tests beside each, `apps/web/e2e/*.spec.ts`, README screenshots (`pnpm screenshots`).

- [ ] "Shown as": label; else displayable alias values joined with " · " in alias-type order; else entity type and masked id as today. Cut with an ellipsis; never widens the page.
- [ ] Failures shortcut link; empty-state text naming the active filters and saying partial text matches labels and displayable aliases only.
- [ ] Keep the plain GET form and the existing cursor and `since`-carrying rules (see the comments in `recent-filters.ts`).
- [ ] Accessibility: the table has a caption or label, headers are `th` with scope, the text box has a label.

**Prove:** unit tests for filter parsing (every preset, custom range, invalid values fall back), the redirect, and the row fallback order; Playwright: the page lists a labelled journey, the fallback row, a "contains" filter narrowing the list, the Failures shortcut, `/recent?status=failed` redirecting with its filter, and no horizontal scroll at 400 px with a 200-character label and long alias values; existing Playwright specs still pass.

## Task 8: Decision, security and changelog

**Files:** `docs/DECISIONS.md` (new ADR: journey labels and partial matching on public values), `README.md` (ADR count), `docs/SECURITY.md` (what is stored in plain text and why; what `q` can and cannot match), `docs/OPERATIONS.md` (upgrade note: migration 018 and no backfill), `CHANGELOG.md` (Unreleased), `scripts/upgrade-test-lib.mjs` (a check that journeys from the previous build list with null label and last step).

**Prove:** docs-truth tests pass; the upgrade test passes with the new check, which fails if the list route errors on old rows.

## Task 9: The whole branch

No new files unless a defect is found.

- [ ] Clean clone of the branch: `pnpm install --frozen-lockfile`, `format:check`, `lint`, `typecheck`, `test`, `test:integration`, `gitleaks detect --source=. --config=.gitleaks.toml --redact --no-banner`.
- [ ] A live stack from the branch: SDK script setting labels and displayable aliases on several journeys, then the Journeys page in Playwright (screenshots of the table, a "contains" filter, and 400 px) saved to `/private/tmp/claude-501/-Users-jorgepolanco-workspace/80a8067d-42c1-43f1-abbf-0b8085479f59/scratchpad/journeys-browse/`; `pnpm test:e2e`; `pnpm test:demo`.
- [ ] The upgrade test script.

**Prove:** every command's outcome in the report.
