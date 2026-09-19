# Migration search-path repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan with an independent task review.

**Goal:** Restore isolated-schema migrations so launch measurements can run safely.

**Architecture:** Capture the supplied Knex session's search path and apply it to migration 019's dedicated PostgreSQL index session, preserving its connection and locking design.

**Tech Stack:** Existing JavaScript migration, Knex, pg, PostgreSQL and Vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-migration-search-path-design.md`

## Global Constraints

- Keep dedicated connections, lock timeout, concurrent builds, invalid-index repair, cleanup and original-error preservation.
- Preserve non-default schema isolation, public-schema objects and pooled session settings.
- Treat search-path values as bound data; quoted schema identifiers must work.
- Do not change benchmark semantics or guards, add dependencies, or refactor unrelated migrations.
- Use only this isolated worktree; no public release or broad resource cleanup.
- Implementers and reviewers do not spawn agents; the controller owns review and measurements.

## Task 1: Preserve the concurrent index session's search path

**Files:** `packages/database/migrations/019_journey_browse_indexes.js`, `packages/database/src/schema.integration.test.ts`; documentation in this spec/plan if findings clarify the bounded design.

**Interfaces:** Existing `up(knex)`, `down(knex)` and `buildIndexes(knex, lockTimeout)` stay unchanged. The measurement scripts continue to pass Knex `searchPath` normally.

- [ ] Read repository instructions and the migration's concurrency rationale. Inspect later migrations for the same dedicated `pg.Client` pattern; record the result, changing only confirmed instances with covering tests.
- [ ] Add a real PostgreSQL regression in the existing migration suite. Create a quoted non-default schema with Knex identifier binding, create an isolated Knex client with `searchPath: [schema]`, and migrate it. Assert both 019 indexes are valid in that schema while public indexes retain their definitions. Run 019 down/up and invalid-index repair in the isolated schema. Assert pool `search_path` and `lock_timeout` are unchanged. Always destroy the isolated client and drop only the test schema in `finally`.

  Use the suite's existing container and configuration helpers. The critical setup follows this form:

  ```ts
  const schema = 'migration 019 "isolated"';
  await db.raw("create schema ??", [schema]);
  const isolated = knex({
    ...createKnexConfig(container.getConnectionUri()),
    searchPath: [schema]
  });
  ```

- [ ] Run the new named test before changing production code and retain the 42P01 failure. Select it with Vitest's `-t` flag in the integration configuration.
- [ ] Apply the smallest session-preserving correction in `onOneConnection`. Use the PostgreSQL result of `show search_path` from the supplied Knex client and parameterized session configuration on the dedicated client before its existing index work:

  ```js
  const result = await knex.raw("show search_path");
  const searchPath = result.rows[0].search_path;
  // After the dedicated client connects, before index work:
  await query("select set_config('search_path', $1, false)", [searchPath]);
  ```

  Keep the existing timeout validation, connection credential handling and `finally` cleanup. Adapt type annotations to the migration's existing JavaScript conventions. Do not broaden session copying.
- [ ] Run the new regression and existing 019 index validity, lock wait, concurrent ingestion and cleanup tests. Run database typecheck/lint and changed-file formatting. Record exact RED/GREEN commands, totals and limitations.
- [ ] Self-review and commit exact files with truthful authorship. Write the implementer report in the task scratch directory; return status, commit, concise verification and concerns. The controller then runs an independent review before benchmarks.
