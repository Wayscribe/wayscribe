# Labels and starter issues (draft)

The labels and issues below were created on GitLab on 2026-09-17: the labels
with the full descriptions from the table, and the issues as #1 to #7 in the
order listed. The maintainer then fixed #1 to #6 the same day. This file keeps
the original text as the record of how they were chosen.

Every issue was drawn from something real in the repository as of this draft
(2026-09-16), verified by reading the code, tests, and docs listed under each
one, not invented from a generic "good first issue" template. None of them
depended on the product rename, which was still pending then, and none require a design decision the
owner hasn't already made; they close small, well-scoped, already-described
gaps.

## Labels

| Name | Color | Description |
| --- | --- | --- |
| `good first issue` | `#7057FF` | Small, self-contained, and scoped for a first contribution, with no design decisions left to make. |
| `help wanted` | `#008672` | The maintainer would welcome outside help on this; may be larger or need more judgment than a good first issue. |
| `needs info` | `#D876E3` | Waiting on more information (from the reporter or the maintainer) before it can be worked. |
| `bug` | `#D73A4A` | Something isn't working as documented or intended. |
| `docs` | `#0075CA` | Documentation-only changes. |
| `sdk` | `#5319E7` | The Node SDK, `packages/sdk-node`. |
| `web` | `#1D76DB` | The web app, `apps/web`. |
| `api` | `#B60205` | The API service, `apps/api`. |
| `database` | `#FBCA04` | Migrations, retention, or the `packages/database` CLI. |
| `cli` | `#C5DEF5` | The read-only query CLI, `packages/cli`. |
| `testing` | `#BFD4F2` | Test coverage, fixtures, or CI. |

## Starter issues

### 1. Add loading states for the web app's route segments

**Labels:** `good first issue`, `web` · **Size:** Small

`docs/TASKS.md`'s Epic 7 (Web UI) checklist has one line still unticked:
"Add loading and empty states." The empty-state half is already there: for
example `apps/web/app/(authenticated)/page.tsx` renders "Nothing matched
`<query>`..." when a search comes back empty, and
`apps/web/app/(authenticated)/journeys/page.tsx` has its own empty-list
message. The loading half is not: there is no `loading.tsx` anywhere under
`apps/web/app`, even though several pages are server components that `await`
an API call before rendering (e.g. `Results` in
`apps/web/app/(authenticated)/page.tsx`, and
`apps/web/app/(authenticated)/journeys/[journeyId]/page.tsx`). On a slow or
distant API, the browser currently shows nothing until the whole page
resolves.

**Acceptance criteria**

- Add a `loading.tsx` for the `(authenticated)` route group (and for the
  `journeys/[journeyId]` segment if its detail fetch is slow enough to
  warrant its own), shown by Next.js while that segment's server component is
  still fetching.
- The loading UI is announced to assistive tech (e.g. `role="status"`, the
  same pattern already used for the delete notice in
  `apps/web/app/(authenticated)/page.tsx`).
- Update the `docs/TASKS.md` line once the loading half is done (split it into
  two lines if the empty-state half should stay tracked separately).
- `pnpm --filter web test` and `pnpm test:e2e` still pass.

---

### 2. Add a "skip to main content" link

**Labels:** `good first issue`, `web` · **Size:** Small

Every authenticated page renders through
`apps/web/app/(authenticated)/layout.tsx`, which puts a
`<nav className="site-nav" aria-label="Main">` (Search, Journeys) ahead of the
page content on every request. There is no skip link anywhere in
`apps/web/app` (checked `layout.tsx` and the authenticated layout), so a
keyboard or screen-reader user has to tab through the nav on every single page
to reach the content.

**Acceptance criteria**

- Add a "Skip to main content" link as the first focusable element in
  `apps/web/app/layout.tsx` (or the authenticated layout), visually hidden
  until focused, targeting an id placed on each page's `<main>`.
- A keyboard-only pass confirms the first Tab from page load lands on the
  skip link.
- Extend `apps/web/e2e/layout.spec.ts` (or add a new spec) to check the link
  is present and focusable.

---

### 3. Link the glossary from the running app, not just the README

**Labels:** `good first issue`, `web`, `docs` · **Size:** Small

`docs/GLOSSARY.md` defines the project's shared vocabulary (journey, alias,
entity, correlation, capture mode, etc.) and is linked from the docs table in
`README.md`. Nothing inside the running application links to it: someone
using the deployed tool who hits an unfamiliar term has no in-app way to reach
the glossary.

**Acceptance criteria**

- Add a small, unobtrusive link to the glossary from the app shell (for
  example, next to the nav in
  `apps/web/app/(authenticated)/layout.tsx`, or a footer).
- Check whether `docs/` ships inside the web container image; if it doesn't,
  link to the GitLab-hosted copy instead of a path that will 404 in
  production.

---

### 4. Add a `db:reset` script for local development

**Labels:** `good first issue`, `database` · **Size:** Small-medium

`docs/TASKS.md`'s Epic 2 (Database) checklist has exactly one unticked line:
"Add reset script." Today there is no reset command: `package.json` and
`packages/database/package.json` define `db:migrate`, `db:rollback`,
`db:seed`, `db:seed-demo`, `key:*`, `retention:sweep`, `rotate:*`, `delete:*`
and `doctor`, dispatched through a `switch` in
`packages/database/src/cli.ts` (see the `case "migrate":`, `case "rollback":`,
`case "seed":` blocks around lines 58-112). None of them combine into "wipe
and rebuild my local database." A contributor who wants a clean slate has to
run rollback-to-zero, migrate, and seed by hand, in the right order.

**Acceptance criteria**

- Add a `reset` case to `packages/database/src/cli.ts`, following the
  existing command style, that rolls the schema all the way back and then
  runs migrate and seed in sequence.
- Wire it up as `db:reset` in the root `package.json` and
  `packages/database/package.json`, matching the existing `db:*` naming.
- Add a test alongside the existing CLI/migration tests (see
  `packages/database/src/cli-migrate.integration.test.ts` for the pattern).
- Add the new command to the table in `docs/LOCAL_DEVELOPMENT.md` (around the
  existing `pnpm db:migrate` · `pnpm db:rollback` · `pnpm db:seed` row).

---

### 5. Add unit tests for the replay API route handler

**Labels:** `good first issue`, `web`, `testing` · **Size:** Small-medium

`apps/web/app/api/replay/route.ts` is the route handler that submits a replay
on the signed-in operator's behalf: it rejects cross-origin requests, requires
a session, redirects home on a missing `journeyId`/`eventId`, and redirects
back to the replay page with either `?replay=<runId>` or `?error=<code>`
depending on what `createReplay` returns. Its sibling route handlers each have
a `route.test.ts`, namely
`apps/web/app/api/journeys/[journeyId]/delete/route.test.ts`,
`apps/web/app/api/journeys/[journeyId]/events/route.test.ts`,
`apps/web/app/api/login/route.test.ts`, and
`apps/web/app/api/select-project/route.test.ts`, but
`apps/web/app/api/replay/route.ts` has none. The only place it's exercised
today is a CSP-violation check in `apps/web/e2e/security-headers.spec.ts`,
which never submits the form.

**Acceptance criteria**

- Add `apps/web/app/api/replay/route.test.ts`, following the pattern in the
  delete route's test: mock `src/lib/api`'s `createReplay` with
  `vi.hoisted` + `vi.mock`, build requests with `NextRequest`, assert on the
  resulting redirect.
- Cover at least: no session redirects to `/login`; a cross-origin request is
  refused; a missing `journeyId` or `eventId` redirects to `/`; a successful
  `createReplay` redirects to the replay page with
  `?event=<id>&replay=<runId>`; a `createReplay` error redirects with
  `?event=<id>&error=<code>`.
- `pnpm --filter web test` passes.

---

### 6. Add a `--version` flag to the CLI

**Labels:** `good first issue`, `cli` · **Size:** Small

`packages/cli/src/cli.ts` implements `search`, `journey`, `event`, `projects`,
and `--help`, but there is no `--version`. `packages/cli/package.json` pins a
version (`0.1.0`) that an installed copy of the CLI currently has no way to
report.

**Acceptance criteria**

- Add a `--version` option to the `parseArgs` options in
  `packages/cli/src/cli.ts`, printing the version from the package's own
  `package.json` rather than a string hardcoded a second time.
- Update the `USAGE` text to list it alongside `--help`.
- Add a test next to the existing `"succeeds for an explicit --help"` test in
  `packages/cli/src/cli.test.ts`.

---

### 7. Add plain-language explanations for journey, alias, transformation, and replay in the UI

**Labels:** `help wanted`, `web`, `docs` · **Size:** Medium

The other unticked line in `docs/TASKS.md`'s Epic 7 is "Add plain-language
explanations for journey, alias, transformation, and replay." The definitions
already exist in `docs/GLOSSARY.md`, but they live only in the docs; the UI
elements that use these words (`apps/web/app/components/JourneyHeading.tsx`,
`AliasList.tsx`, the diff viewer, the replay page) don't explain them in
place. This is marked **help wanted** rather than **good first issue** because
it touches copy across several pages and the wording should get a maintainer's
sign-off before merging, rather than being decided unilaterally in the PR.

**Acceptance criteria**

- Add a short (one to two sentence) inline explanation near each of the four
  terms, in the voice already used for the existing "muted" helper text (see
  `apps/web/app/(authenticated)/page.tsx` and `journeys/page.tsx`).
- Keep the wording consistent with `docs/GLOSSARY.md`'s existing definitions
  rather than introducing a second, drifting description.
- Get sign-off on the copy from the maintainer before merging.

---

## `glab` commands

All of these have been run (the labels with the longer descriptions from the
table, the issues through the API with the text above); they are kept for
reference. They were run before the rename to Wayscribe (ADR-057), against the
project's old path; the commands below show its current path. `glab` must be
authenticated against `gitlab.com` and pointed at the project, or run with
`-R jojithedev/wayscribe` as shown.

### Create the labels

```bash
glab label create -R jojithedev/wayscribe -n "good first issue" -c "#7057FF" \
  -d "Small, self-contained, and scoped for a first contribution."
glab label create -R jojithedev/wayscribe -n "help wanted" -c "#008672" \
  -d "The maintainer would welcome outside help on this."
glab label create -R jojithedev/wayscribe -n "needs info" -c "#D876E3" \
  -d "Waiting on more information before it can be worked."
glab label create -R jojithedev/wayscribe -n "bug" -c "#D73A4A" \
  -d "Something isn't working as documented or intended."
glab label create -R jojithedev/wayscribe -n "docs" -c "#0075CA" \
  -d "Documentation-only changes."
glab label create -R jojithedev/wayscribe -n "sdk" -c "#5319E7" \
  -d "The Node SDK, packages/sdk-node."
glab label create -R jojithedev/wayscribe -n "web" -c "#1D76DB" \
  -d "The web app, apps/web."
glab label create -R jojithedev/wayscribe -n "api" -c "#B60205" \
  -d "The API service, apps/api."
glab label create -R jojithedev/wayscribe -n "database" -c "#FBCA04" \
  -d "Migrations, retention, or the packages/database CLI."
glab label create -R jojithedev/wayscribe -n "cli" -c "#C5DEF5" \
  -d "The read-only query CLI, packages/cli."
glab label create -R jojithedev/wayscribe -n "testing" -c "#BFD4F2" \
  -d "Test coverage, fixtures, or CI."
```

### Create the starter issues

Each `-d -` opens an editor; the body can be pasted from the corresponding
section above, or `-d` can be given the text directly with a heredoc if
scripting this.

```bash
glab issue create -R jojithedev/wayscribe \
  -t "Add loading states for the web app's route segments" \
  -l "good first issue,web" -d -

glab issue create -R jojithedev/wayscribe \
  -t 'Add a "skip to main content" link' \
  -l "good first issue,web" -d -

glab issue create -R jojithedev/wayscribe \
  -t "Link the glossary from the running app, not just the README" \
  -l "good first issue,web,docs" -d -

glab issue create -R jojithedev/wayscribe \
  -t "Add a db:reset script for local development" \
  -l "good first issue,database" -d -

glab issue create -R jojithedev/wayscribe \
  -t "Add unit tests for the replay API route handler" \
  -l "good first issue,web,testing" -d -

glab issue create -R jojithedev/wayscribe \
  -t "Add a --version flag to the CLI" \
  -l "good first issue,cli" -d -

glab issue create -R jojithedev/wayscribe \
  -t "Add plain-language explanations for journey, alias, transformation, and replay in the UI" \
  -l "help wanted,web,docs" -d -
```

## Left out, and why

- **`audit_events` is never swept** (`docs/ROADMAP.md`, "Known open"). Real
  and worth fixing, but `audit_events` rows are scoped by `project_id` only,
  and there's no `environment_id` to borrow an existing `retentionDays` from
  the way `sweepExpiredJourneys` does
  (`packages/database/src/repositories/retention.ts`). Picking a retention
  rule for audit data is a data-retention decision, which
  `CONTRIBUTING.md`'s "Architecture decisions" section says needs an ADR,
  so this isn't a good-first-issue as written. Worth a maintainer-authored
  issue once a retention rule is decided.
- **The login limiter is per-process** (same "Known open" section,
  `apps/web/src/lib/login-limiter.ts`). This is documented in the code as a
  deliberate, known tradeoff for a self-hosted single-instance tool, and it's
  security-sensitive rate-limiting behavior, out of scope per the brief for
  this pass.
- The three active DebtWatch declarations (`npx debtwatch list`:
  `DEBT-4PM4D3`, `DEBT-GW41YJ`, `DEBT-WGN0N4`) were reviewed and left out too:
  each is an intentional, documented tradeoff tied to a specific architectural
  constraint (an unpublishable private package, ADR-032's V0 replay scope, and
  a fixed SDK concurrency cap that the comment itself says needs an adaptive
  design) rather than a small, unscoped gap.
