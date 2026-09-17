# Wayscribe Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from Flight Recorder to Wayscribe everywhere the approved spec
says, keeping stored data readable.

**Architecture:** One branch. First, two guard tests: one pins the key-derivation labels that
must not change, one fails on any leftover old name outside an allowlist. Then a checked-in,
ordered, one-off rename script does the mechanical replacements, and later tasks handle the
parts a script cannot judge (API key prefix, database defaults, Helm release names, prose,
screenshots, ADR). The guard test turns green only when the rename is complete.

**Tech Stack:** TypeScript pnpm monorepo on Node 24, Vitest, Playwright, Knex, Helm, Docker
Compose, GitLab CI.

**Spec:** `docs/superpowers/specs/2026-09-17-wayscribe-rename-design.md` (approved 2026-09-17).
Its name table is the source of truth; this plan does not repeat every row.

---

## Ground rules for every task

- Work in the branch worktree the controller gives you. Before anything, run
  `git rev-parse --show-toplevel` and `git branch --show-current`, and stop if they are not the
  rename worktree and branch `wayscribe-rename`.
- Prefix shell commands with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- Never print secrets. Never `cat` `.env` files, `~/.npmrc` or credential files.
- No em dashes in anything written.
- Never edit: `packages/database/migrations/*`, `docs/superpowers/specs/*` and
  `docs/superpowers/plans/*` other than this plan, `docs/reviews/*`,
  `docs/claims-audit-2026-09-16.md`, CHANGELOG entries below the new one, ADR-001 to ADR-056
  bodies in `docs/DECISIONS.md`.
- Never change these strings (key-derivation labels):
  `flight-recorder/field-encryption`, `flight-recorder/search-token`, `flight-recorder/api-key`,
  `flight-recorder/content-hash`, `flight-recorder/key-id`, `flight-recorder/web-session`.
- Docker: use unique container names and unused ports; never touch the volume
  `frdogfood_postgres-data`, the `frdogfood` or `leadline` stacks, or port 8080. Stop only
  processes you started, by PID.
- Commit at the end of each task with a message ending in
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Do not push or merge.

## File map

- Create `tests/rename-guard.test.ts`: fails on old names outside the allowlist.
- Create `packages/payload-security/src/derivation-labels.test.ts`: pins the six labels.
- Create `scripts/rename-to-wayscribe.mjs`: the one-off rename, deleted in Task 8.
- Move `deploy/helm/flight-recorder/` to `deploy/helm/wayscribe/`.
- Modify: every file listed by the guard test's first failing run (about 260), by script and by
  hand.
- Modify `packages/payload-security/src/api-key.ts`, `mask-text.ts`,
  `packages/database/src/doctor.ts`, `packages/config/src/insecure-defaults.ts`,
  `.gitleaks.toml`: the key prefix.
- Modify `docs/DECISIONS.md`: note at the top and ADR-057 at the end.
- Modify `CHANGELOG.md`, `docs/RELEASE_NOTES_DRAFT.md`, `docs/LOCAL_DEVELOPMENT.md`,
  `docs/ROADMAP.md`.

---

### Task 1: Guard tests

**Files:**
- Create: `packages/payload-security/src/derivation-labels.test.ts`
- Create: `tests/rename-guard.test.ts`

- [ ] **Step 1: Pin the derivation labels.** Read `packages/payload-security/src/keys.ts` and
  `apps/web/src/lib/session.ts` first to confirm the labels and how `derive` is exported.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * These HKDF labels decide every derived key. Renaming one makes stored
 * ciphertext unreadable, search tokens stop matching and stored API key
 * verifiers fail, so the product rename (ADR-057) left them as written.
 */
const LABELS: Record<string, string[]> = {
  "packages/payload-security/src/keys.ts": [
    "flight-recorder/field-encryption",
    "flight-recorder/search-token",
    "flight-recorder/api-key",
    "flight-recorder/content-hash",
    "flight-recorder/key-id",
  ],
  "apps/web/src/lib/session.ts": ["flight-recorder/web-session"],
};

describe("key-derivation labels", () => {
  for (const [file, labels] of Object.entries(LABELS)) {
    it(`${file} still derives with its original labels`, () => {
      const source = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      for (const label of labels) expect(source, label).toContain(`"${label}"`);
    });
  }
});
```

  If `flight-recorder/key-id` lives in a different file than `keys.ts`, point the entry at that
  file (`git grep -n "flight-recorder/key-id" -- '*.ts'`). Add a known-answer check as well: derive
  the field-encryption subkey from a fixed 32-byte master with Node's `hkdfSync("sha256", master,
  "", "flight-recorder/field-encryption", 32)` and assert it equals what `keys.ts` produces for
  the same master (use its exported function; read the file for the name).

- [ ] **Step 2: Run it.** `pnpm exec vitest run packages/payload-security/src/derivation-labels.test.ts`.
  Expected: PASS (it pins current behaviour).

- [ ] **Step 3: Write the rename guard.**

```ts
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { root } from "./docs-helpers.js";

/**
 * The product was renamed from Flight Recorder to Wayscribe (ADR-057). Any old
 * name outside the history and the deliberate exceptions below is a leftover.
 */
const OLD = String.raw`flight.?recorder|x-flight|flightJourney|flightEntity|\b_flight\b|\bfr_|FLIGHT_|flight_session|flight\.example`;

const ALLOWED_FILES = [
  /^docs\/superpowers\/(specs|plans)\//,
  /^docs\/reviews\//,
  /^docs\/claims-audit-2026-09-16\.md$/,
  /^packages\/database\/migrations\//,
  /^docs\/DECISIONS\.md$/, // ADR-001 to ADR-056 are history; ADR-057 names the old names
  /^CHANGELOG\.md$/, // past entries are history
  /^tests\/rename-guard\.test\.ts$/,
  /^packages\/payload-security\/src\/derivation-labels\.test\.ts$/,
];

/** Lines outside the allowed files that may keep an old name, and why. */
const ALLOWED_LINES: RegExp[] = [
  /"flight-recorder\/(field-encryption|search-token|api-key|content-hash|key-id|web-session)"/, // derivation labels
  /fr_/, // legacy key prefix, checked by the next test instead
];

describe("rename to Wayscribe", () => {
  it("leaves no old name outside history and the deliberate exceptions", () => {
    const out = execFileSync("git", ["grep", "-n", "-i", "-I", "-E", OLD, "--", ".", ":!pnpm-lock.yaml"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const leftovers = out
      .split("\n")
      .filter((line) => line !== "")
      .filter((line) => !ALLOWED_FILES.some((pattern) => pattern.test(line.split(":")[0]!)))
      .filter((line) => !ALLOWED_LINES.some((pattern) => pattern.test(line)));
    expect(leftovers).toEqual([]);
  });

  it("mentions the legacy fr_ key prefix only where old keys are still recognised", () => {
    const out = execFileSync("git", ["grep", "-l", "-E", String.raw`\bfr_`, "--", ".", ":!pnpm-lock.yaml"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const files = out.split("\n").filter((file) => file !== "")
      .filter((file) => !ALLOWED_FILES.some((pattern) => pattern.test(file)));
    expect(files.sort()).toEqual(
      [
        ".gitleaks.toml",
        "packages/database/src/doctor.ts",
        "packages/database/src/doctor.test.ts",
        "packages/payload-security/src/mask-text.ts",
        "packages/payload-security/src/mask-text.test.ts",
        "packages/payload-security/src/api-key.test.ts",
        "scripts/upgrade-test.mjs",
      ].sort(),
    );
  });
});
```

  `git grep` exits 1 when nothing matches; wrap the call so an empty result is `""` rather than a
  throw (catch the error and return `""` when `status === 1`). Confirm `root` is exported from
  `tests/docs-helpers.ts`; if not, compute the repo root the way that file does. The exact list
  in the second test is a target: adjust it in Task 3 to the files that genuinely keep legacy
  handling, and no others.

- [ ] **Step 4: Run it and record the failure.**
  `pnpm exec vitest run tests/rename-guard.test.ts > /tmp/claude-501/rename-guard-first.txt 2>&1; tail -5 /tmp/claude-501/rename-guard-first.txt`.
  Expected: FAIL with several hundred leftover lines.

- [ ] **Step 5: Commit** both tests (`test: pin key-derivation labels and guard the Wayscribe rename`).
  The guard is red until Task 7; that is intended on this branch.

### Task 2: Mechanical rename script and code rename

**Files:**
- Create: `scripts/rename-to-wayscribe.mjs`
- Move: `deploy/helm/flight-recorder` to `deploy/helm/wayscribe`
- Modify: every tracked text file outside the allowlist

- [ ] **Step 1: Write the script.** Ordered replacements; longest and most specific first. It
  skips the allowed files from Task 1, `pnpm-lock.yaml`, binary files, and any line containing a
  derivation label.

```js
#!/usr/bin/env node
// One-off rename from Flight Recorder to Wayscribe (ADR-057). Deleted after use.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SKIP = [
  /^docs\/superpowers\/(specs|plans)\//,
  /^docs\/reviews\//,
  /^docs\/claims-audit-2026-09-16\.md$/,
  /^packages\/database\/migrations\//,
  /^docs\/DECISIONS\.md$/,
  /^CHANGELOG\.md$/,
  /^pnpm-lock\.yaml$/,
  /^tests\/rename-guard\.test\.ts$/,
  /^packages\/payload-security\/src\/derivation-labels\.test\.ts$/,
  /^scripts\/rename-to-wayscribe\.mjs$/,
  /\.(png|jpg|jpeg|gif|ico|tgz|woff2?)$/,
];
const PROTECTED = /flight-recorder\/(field-encryption|search-token|api-key|content-hash|key-id|web-session)/;

const RULES = [
  ["registry.gitlab.com/jojithedev/flight-recorder", "registry.gitlab.com/jojithedev/wayscribe"],
  ["gitlab.com/jojithedev/flight-recorder", "gitlab.com/jojithedev/wayscribe"],
  ["jojithedev%2Fflight-recorder", "jojithedev%2Fwayscribe"],
  ["@flight-recorder/", "@wayscribe/"],
  ["fr-flight-recorder-", "ws-wayscribe-"],
  ["flight-recorder", "wayscribe"],
  ["FLIGHT_RECORDER_", "WAYSCRIBE_"],
  ["FLIGHT_API_", "WAYSCRIBE_API_"],
  ["FLIGHT_ENDPOINT", "WAYSCRIBE_ENDPOINT"],
  ["FLIGHT_ENVIRONMENT", "WAYSCRIBE_ENVIRONMENT"],
  ["flight_recorder_", "wayscribe_"],
  ["flight_recorder", "wayscribe"],
  ["FlightRecorder", "Wayscribe"],
  ["flightRecorder", "wayscribe"],
  ["Flight Recorder", "Wayscribe"],
  ["X-FLIGHT-", "X-WAYSCRIBE-"],
  ["X-Flight-", "X-Wayscribe-"],
  ["x-flight-", "x-wayscribe-"],
  ["flightJourney", "wayscribeJourney"],
  ["flightEntity", "wayscribeEntity"],
  [/\b_flight\b/g, "_wayscribe"],
  ["flight_session", "wayscribe_session"],
  ["flight_app", "wayscribe_app"],
  ["flight.example", "wayscribe.example"],
  ["flight-builder", "wayscribe-builder"],
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let changed = 0;
for (const file of files) {
  if (SKIP.some((pattern) => pattern.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes(" ")) continue;
  const lines = text.split("\n").map((line) => {
    if (PROTECTED.test(line)) return line;
    let next = line;
    for (const [from, to] of RULES) next = typeof from === "string" ? next.split(from).join(to) : next.replace(from, to);
    return next;
  });
  const result = lines.join("\n");
  if (result !== text) {
    writeFileSync(file, result);
    changed += 1;
  }
}
console.log(`rewrote ${changed} files`);
```

  Lowercase prose "flight recorder" (six places) and the bare database name `flight` are not in
  the rules on purpose; Tasks 4 and 6 handle them by hand.

- [ ] **Step 2: Move the chart first**, so the script's path rewrites point at a real
  directory: `git mv deploy/helm/flight-recorder deploy/helm/wayscribe`.

- [ ] **Step 3: Run the script.** `node scripts/rename-to-wayscribe.mjs`. Expected: `rewrote N files`
  with N near 250.

- [ ] **Step 4: Check the protected labels survived.**
  `git grep -n -E 'flight-recorder/(field-encryption|search-token|api-key|content-hash|key-id|web-session)' -- '*.ts' ':!*.test.ts'`.
  Expected: six lines, in `keys.ts` (or wherever key-id lives) and `session.ts`, unchanged. Also
  `git diff --stat -- packages/database/migrations` must be empty.

- [ ] **Step 5: Regenerate the lockfile.** `pnpm install` (not frozen). Then
  `git grep -c "flight-recorder" pnpm-lock.yaml` should print nothing or 0.

- [ ] **Step 6: Build and type-check.** `pnpm -r build` if the repo has it (check root
  `package.json`), then `pnpm typecheck` and `pnpm lint`. Fix import or name fallout by hand.
  Regenerate generated files that embed names: `pnpm --filter @wayscribe/protocol schemas` and
  the conformance manifest script in `packages/protocol/scripts/write-manifest.mjs` (check its
  package script name), and confirm `git diff` on them shows only name changes.

- [ ] **Step 7: Unit tests.** `pnpm test`. Expected: everything passes except
  `tests/rename-guard.test.ts` (fewer leftovers now). Fix any other failure; typical causes are
  snapshot strings, header-name casing, and metric names asserted in tests.

- [ ] **Step 8: Commit** (`refactor: rename packages, wire names and identifiers to Wayscribe`).
  Keep the script in this commit; Task 8 deletes it.

### Task 3: API key prefix

**Files:**
- Modify: `packages/payload-security/src/api-key.ts`, `api-key.test.ts`
- Modify: `packages/payload-security/src/mask-text.ts`, `mask-text.test.ts`
- Modify: `packages/database/src/doctor.ts`, `doctor.test.ts`
- Modify: `packages/config/src/insecure-defaults.ts` and every place the published demo key appears
- Modify: `.gitleaks.toml`, `scripts/upgrade-test.mjs`, `.gitlab-ci.yml`, SDK bench files, remaining tests using `fr_` fixtures

- [ ] **Step 1: Failing tests first.**
  - `api-key.test.ts`: a generated key matches `/^wsk_[A-Za-z0-9_-]{32}$/` (36 characters), and
    a key issued in the old form (`"fr_" + 32 base64url characters`) still verifies against a
    record made from it (build the record with `apiKeyRecord`).
  - `mask-text.test.ts`: both `wsk_` + 32 and `fr_` + 32 characters are masked; `wsk_short` is not.
  - `doctor.test.ts`: `doctor` accepts a presented `wsk_` key and an `fr_` key, and its refusal
    message names the `wsk_` form.
  Run: `pnpm exec vitest run packages/payload-security packages/database/src/doctor.test.ts`.
  Expected: FAIL on the new-prefix cases.

- [ ] **Step 2: Implement.**
  - `api-key.ts`: `` `wsk_${randomBytes(KEY_BYTES).toString("base64url")}` ``. Check that
    `API_KEY_PREFIX_LENGTH = 12` still yields distinct stored prefixes (4 prefix characters plus 8
    random ones; fine) and that no column or check constraint limits key length (grep migrations
    for `key_prefix`).
  - `mask-text.ts`: the pattern becomes `(?:wsk|fr)_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])`; update the
    comment to say `fr_` is the prefix keys had before the rename (ADR-057).
  - `doctor.ts`: accept `wsk_` or `fr_`; message: "The key given is not a Wayscribe API key, which
    starts wsk_ (or fr_ for keys issued before the rename)." Keep the length check correct for
    both (36 and 35 characters).
  - `insecure-defaults.ts`: `PUBLISHED_DEMO_API_KEY = "wsk_demo0000000000000000000000000000"`
    (count: `wsk_` plus 32 characters). Find every other copy of the old demo key
    (`git grep -n fr_demo`) and update it the same way, including compose files and docs.
  - `.gitleaks.toml`: allow `(wsk|fr)_(test|validkey1|demo00000)...` and update the comment.
  - `scripts/upgrade-test.mjs`: the key regex must match the baseline build's output (`fr_`) and
    the new build's (`wsk_`): `/(?:wsk|fr)_[A-Za-z0-9_-]{16,}/`.
  - `.gitlab-ci.yml` e2e seed: `grep -oE '(wsk|fr)_[A-Za-z0-9_-]+'` or just `wsk_`.
  - Bench files and other test fixtures: `wsk_` instead of `fr_`.

- [ ] **Step 3: Run** `pnpm exec vitest run packages/payload-security packages/database/src/doctor.test.ts`
  and then `pnpm test`. Expected: PASS except the rename guard. Adjust the second guard test's
  file list to exactly the files that keep legacy `fr_` handling.

- [ ] **Step 4: Commit** (`feat: new API keys start wsk_; fr_ keys keep working`).

### Task 4: Deployment and database defaults

**Files:**
- Modify: `infrastructure/compose*.yaml`, `apps/*/Dockerfile`, `deploy/helm/**`, `.gitlab-ci.yml`,
  `scripts/*.sh`, `scripts/*.mjs`, `vitest*.config.ts`, `docs/LOCAL_DEVELOPMENT.md`,
  `docs/OPERATIONS.md`, `deploy/helm/README.md`

- [ ] **Step 1: Database user, password and name.** Change the local default `flight` to
  `wayscribe` in every compose file, `.gitlab-ci.yml` (`POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB`, `DATABASE_URL`), the Helm chart's bundled PostgreSQL and its examples
  (`flight@...`), `vitest*.config.ts`, scripts and docs. Find them with
  `git grep -n -w flight -- ':!docs/superpowers' ':!docs/reviews' ':!docs/claims-audit-2026-09-16.md' ':!CHANGELOG.md' ':!docs/DECISIONS.md' ':!packages/database/migrations'`
  and judge each hit: only database credentials and names change; the word "flight" in other
  senses (none expected after Task 2) stays.

- [ ] **Step 2: Helm release name in examples and CI.** Examples and CI use the release name
  `fr` (`helm template fr ...`, resources `fr-...`). Change to `ws` consistently: CI commands,
  the `sed` selector on `ws-wayscribe-api`, `deploy/helm/README.md`, `values-local.yaml`,
  `docs/OPERATIONS.md`. Then run the chart checks CI runs:
  `helm lint deploy/helm/wayscribe` and each `helm template ws deploy/helm/wayscribe ...` command
  from `.gitlab-ci.yml` (if `helm` is not installed locally, say so in the report; CI runs them).

- [ ] **Step 3: Images and compose.** Confirm `infrastructure/compose.published.yaml` names
  `registry.gitlab.com/jojithedev/wayscribe/api` and `/web` and requires `WAYSCRIBE_VERSION`;
  `scripts/publish-image.sh`, `attest-and-sign.sh`, `check-chart-image-tag.sh` and
  `publish-sdk.sh` use the new names; the demo image is `wayscribe-demo:local`; the compose
  project and network are `wayscribe` and `wayscribe_default`. Run
  `bash scripts/check-chart-image-tag.sh` if it runs offline.

- [ ] **Step 4: Local volume note.** In `docs/LOCAL_DEVELOPMENT.md`, add a short "Upgrading from
  a Flight Recorder checkout" note: the compose project, volume and database names changed, so an
  old local database is not picked up; start fresh with `docker compose -p flight-recorder down -v`
  for the old stack (only if you no longer need its data), then the normal setup. Keep it factual
  and short.

- [ ] **Step 5: Run the stack.** Start the local compose stack under a unique project name and
  unused ports if the file allows overrides (read `docs/LOCAL_DEVELOPMENT.md`), run
  `pnpm db:migrate`, `pnpm db:seed` (the printed key starts `wsk_`), and hit `/health`. Stop it and
  remove its volume afterwards. If ports are fixed and in use, report it instead of forcing.

- [ ] **Step 6: Commit** (`build: rename deployment, images and database defaults to Wayscribe`).

### Task 5: Interface text and screenshots

**Files:**
- Modify: `apps/web/app/layout.tsx` and any component still showing a product name
- Modify: `docs/images/*.png` (regenerated)

- [ ] **Step 1:** `git grep -n -i wayscribe -- apps/web/app` and read the page title, login
  page, nav and error text. Wording must read naturally ("Wayscribe API", "Sign in to
  Wayscribe").
- [ ] **Step 2:** Run `pnpm vitest run apps/web` and the full Playwright suite (throwaway
  Postgres, unused ports, as in `apps/web/e2e`). Expected: PASS.
- [ ] **Step 3:** Regenerate screenshots with `pnpm screenshots` (read `scripts/screenshots.mjs`
  for what it needs running). View each PNG and confirm it shows Wayscribe and real content.
- [ ] **Step 4: Commit** (`feat(web): show the Wayscribe name; regenerate screenshots`).

### Task 6: Present-tense docs, ADR-057, changelog

**Files:**
- Modify: `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `NOTICE`, `.github/**`, `.gitlab/**`, `docs/*.md` (not history), `docs/recipes/*`,
  `examples/**/README.md`, `packages/*/README.md`
- Modify: `docs/DECISIONS.md`, `CHANGELOG.md`, `docs/RELEASE_NOTES_DRAFT.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Read the script's prose changes.** `git diff main -- '*.md'` and fix anything that
  now reads wrong ("a Wayscribe", headings, sentences that explained the old name). Handle the
  lowercase "flight recorder" hits by hand (`git grep -n -i "flight recorder"` outside history).
  Heading changes move anchors; `pnpm exec vitest run tests` catches broken links.

- [ ] **Step 2: README name note.** One sentence near the top: "Wayscribe was called Flight
  Recorder until September 2026." Keep the "How this is built" and Alternatives sections accurate.

- [ ] **Step 3: DECISIONS.md.** Add a note under the title: "The product was called Flight
  Recorder until 2026-09-17 (ADR-057). Decisions before ADR-057 use the old name and are left as
  written." Append ADR-057 in the file's existing ADR format (read ADR-056 for the headings):
  context (the name collisions with JDK Flight Recorder, Go's `runtime/trace` FlightRecorder and
  `pg_flight_recorder`; Clewline dropped because clewline.com is a live software company; nothing
  published yet), decision (the spec's name table in short, `wsk_` with `fr_` still accepted, no
  wire aliases, derivation labels unchanged with the reason, history left as written, database
  defaults changed), consequences (local volumes need a fresh start, old `fr_` keys keep working,
  Leadline and other repos update, the GitLab path moves after merge, the old registry path does
  not redirect).

- [ ] **Step 4: CHANGELOG and release notes.** Add a top entry describing the rename for someone
  upgrading: new package, CLI, headers, attributes, envelope key, environment variables, metric
  and alert names, key prefix, image paths, database defaults; what keeps working (stored data,
  `fr_` keys). Update `docs/RELEASE_NOTES_DRAFT.md` to the new name and add the same facts
  briefly.

- [ ] **Step 5: Recount the ROADMAP figures.** `docs/ROADMAP.md` lines 18 to 20 give test
  counts. Count unit tests (`pnpm test`), integration tests
  (`pnpm exec vitest run --config vitest.integration.config.ts`, needs Docker), acceptance and
  browser tests, and write them under one date, 2026-09-17. `tests/docs-claims.test.ts` checks the
  sentence shape; keep it passing.

- [ ] **Step 6:** `pnpm format:check`, `pnpm exec vitest run tests`. Expected: PASS except the
  rename guard if leftovers remain; fix them now (every remaining line is either a real leftover to
  rename or belongs in the allowlist with a stated reason).

- [ ] **Step 7: Commit** (`docs: rename to Wayscribe; ADR-057; changelog`).

### Task 7: Full verification

- [ ] **Step 1:** `pnpm exec vitest run tests/rename-guard.test.ts packages/payload-security/src/derivation-labels.test.ts`.
  Expected: PASS.
- [ ] **Step 2:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`. Expected: PASS.
- [ ] **Step 3:** Integration tests: `pnpm exec vitest run --config vitest.integration.config.ts`.
  Expected: PASS.
- [ ] **Step 4:** Full Playwright suite. Expected: PASS.
- [ ] **Step 5:** Clean-clone demo: `git clone` the worktree into the scratchpad, follow the
  README quick start or `docs/DEMO_SCENARIO.md` with a unique compose project name, and confirm a
  journey and its diff appear (API query or Playwright). Tear it down and remove its volumes.
- [ ] **Step 6:** Upgrade test: `node scripts/upgrade-test.mjs` (read its usage; it builds a
  baseline image, so it takes a while). Expected: passes, including old `fr_` keys.
- [ ] **Step 7:** Report every command and result. Fix failures in a new commit.

### Task 8: Remove the script

- [ ] **Step 1:** `git rm scripts/rename-to-wayscribe.mjs`; remove it from the guard's allowlist.
- [ ] **Step 2:** `pnpm exec vitest run tests/rename-guard.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit** (`chore: remove the one-off rename script`).

## After the branch (controller, not a subagent)

1. Final whole-branch review, then merge to main while the GitLab path is still
   `jojithedev/flight-recorder`; push; watch CI including the manual e2e, demo and upgrade jobs.
2. With the maintainer's go-ahead: rename the GitLab project path and name to
   `jojithedev/wayscribe` / "Wayscribe", update the local remote URL, push an empty or trivial
   commit, and confirm CI and image paths.
3. Rename `~/workspace/flight-recorder` to `~/workspace/wayscribe` (no agent worktrees open),
   then update Leadline's docs and the memory files.
4. R2: `jojithedev.gitlab.io`, `ask-jorge` (rebuild and redeploy), `job-radar` profile files.
5. Tell the maintainer's Leadline session the new package, env var, header and attribute names.
