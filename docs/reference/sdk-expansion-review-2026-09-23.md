# codex/sdk-expansion review, 2026-09-23

Review of `main...codex/sdk-expansion` (51 commits, 1f1a41c) before merge. Four
areas were reviewed: OTLP ingestion, backup/restore + CLI, Python SDK, and the Go
SDK with the mixed-language example. CONFIRMED means the reviewer reproduced it;
PLAUSIBLE means reasoned from the code at the cited line.

GitLab CI minutes are exhausted as of 2026-09-23. Push with `-o ci.skip`, verify
locally (including the Postgres integration suite), and record here what still
needs a real pipeline run.

## Merge blockers

1. **CI runs no Go or Python code, and the integration job will likely break.**
   `.gitlab-ci.yml` is unchanged. `test:go`, `test:go:consumer`, `test:python`,
   `test:mixed-language` are never invoked. `pnpm test:integration` (node:24) now
   picks up `go-sdk-conformance`, `go-sdk-workflow`, `python-sdk-*` and
   `mixed-language` integration tests, which spawn `go` and `python3.11` and throw
   when missing (`go-sdk-conformance.integration.test.ts:22-33`,
   `mixed-language.integration.test.ts:215`). Fix: a job image with Node 24 + Go
   1.26 + Python 3.11 (or split jobs), and wire the unit suites in. CONFIRMED/PLAUSIBLE.
2. **Backup/restore passes secrets to pg_dump/pg_restore.**
   `packages/database/src/backup/connection.ts:102-104` strips only `PG*`; the child
   receives `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS`, `ADMIN_TOKEN`,
   `DATABASE_URL`. Fix: env allowlist (PATH, HOME, LANG, TZ + explicit PG vars).
   CONFIRMED.
3. **Uncommitted `backup:verify` work must be finished or set aside.** It sits
   uncommitted in the worktree (14 modified files + `backup/verify.ts`,
   `verify.test.ts`, `encrypted-columns.ts`). It implements plan Task 2, which the
   spec requires. Unit tests pass (358); ESLint fails with 5 errors in `verify.ts`
   (lines 37, 121, 122, 124, 139); `rotation.ts` has a mid-file import; no docs;
   integration tests not yet run; does not check `primary_entity_id_hash` against
   decrypted values (PLAUSIBLE gap).

## Fix before merge

### OTLP (`apps/api/src/otlp/`, `apps/api/src/routes/otlp.ts`)
- Refusal reasons discarded: route counts `rejected++` and drops the code
  (`otlp.ts:110-113, 125-135`); `mapping.ts` collapses most failures to
  `invalid_event`; response message is fixed text (`codec.ts:467`). Return the
  first refusal codes in `partial_success.error_message` and log them. CONFIRMED.
- snake_case top-level keys decode to zero records and return 200
  (`codec.ts:428-450`). Return 400 when no known top-level field is present.
  CONFIRMED.
- gzip is inflated and decoded before auth (`otlp.ts:58-73`). Authenticate in
  `onRequest`. PLAUSIBLE.
- Any unexpected error returns retryable 503 (`otlp.ts:89-94`); a deterministic bug
  becomes an infinite Collector retry. Return 500 for non-transient errors. PLAUSIBLE.
- Docs (`docs/OTLP_LOGS.md:11-13`) should state that OTLP senders get no in-process
  redaction; payloads cross the network raw.

### Backup/restore + CLI
- No fsync of file or directory before `backup_created`
  (`backup/archive.ts:43-49`). PLAUSIBLE.
- Cleanup errors after success report `operation_failed`
  (`archive.ts:59`; `restore.ts:184-185`, the restore half is fixed in the
  uncommitted work). PLAUSIBLE.
- Backup output not sanity-checked for the `PGDMP` header (`archive.ts:38-43`);
  restore does check it. PLAUSIBLE.
- CLI sends the Bearer key over plain http to non-loopback hosts
  (`packages/cli/src/ingestion-config.ts:125`). Require https unless loopback.
  CONFIRMED.
- `docs/OPERATIONS.md` lacks source-checkout backup/restore instructions (plan
  Task 1 Step 4).

### Go SDK (`packages/sdk-go/`)
- Recorder never shut down leaks `MaxConcurrentSends+2` goroutines
  (`recorder.go:49-64`): 100 recorders left 602 goroutines. Document Shutdown as
  required at minimum; consider lazy worker start. CONFIRMED.
- 3xx is recorded as `no_verdict` drop without ever reaching the endpoint and
  counts toward the breaker (`transport.go:16, 147`). Node follows 308 and retries
  an unfollowed 3xx. Treat 3xx as a transport/config error, not no_verdict. CONFIRMED.
- Tests read files outside the module (`core_test.go:169, 241`); 4 tests fail from
  a module-only checkout. Embed or copy fixtures into `testdata/`. CONFIRMED.
- Shutdown: one no-progress batch cancels other workers' in-flight requests
  (`transport.go:227`). PLAUSIBLE.
- Example `go-worker.go:87` closes `done` per request; second request panics.
  CONFIRMED.

### Python SDK (`packages/sdk-python/`)
- After fork, an inherited recorder silently records nothing (`recorder.py:63`,
  `_transport.py:90-95`); hits gunicorn `--preload`, Celery prefork. Warn once or
  rebuild the transport in the child. CONFIRMED.
- Recorder never shut down leaks a thread that pins the transport
  (`_transport.py:84-88, 235`): 200 recorders left 198 threads. CONFIRMED.
- Guards catch `BaseException`, swallowing KeyboardInterrupt/SystemExit
  (`recorder.py:202, 233, 316, 365`; `_diagnostics.py:199, 216`). Catch
  `Exception`. CONFIRMED.
- Secret-name warning line omits the field name and path (`_diagnostics.py:209`).
  CONFIRMED.
- Secret-name code is `add_redaction_or_known_safe_name` (`_diagnostics.py:135`);
  documented code is `secret_like_name`. CONFIRMED.
- Queued events lost at interpreter exit with no warning; add an `atexit` flush or
  document it. CONFIRMED.
- `on_diagnostic` runs on the sender thread; a slow callback stalls delivery
  (`_transport.py:355-358`). PLAUSIBLE.
- Awaitable results (Task/Future) are re-wrapped as a new coroutine
  (`recorder.py:384-395`). PLAUSIBLE.
- 3xx or >1 MiB response drops the batch as `no_verdict` (`_transport.py:296-314,
  426`). PLAUSIBLE.
- sdist ships `tests/` without its helpers; tests cannot run from it.
- `pnpm test:python` uses system `python3`, which may be older than 3.11.

### Cross-SDK parity (low)
- Diagnostic names differ across Node / Go / Python (`breaker_opened` vs
  `breaker_open`, `personal_data_in_public_value` vs `personal_data`,
  `configuration_error` vs `invalid_config`); Python's diagnostic shape is flat
  `{kind, field, name, path}` vs Node's `{kind, code, reason, detail}`;
  `delivered_first` never emitted by Go or Python. Secret-name limits differ
  (Python 1000 names / 512 path vs Node 100 / 256) and list paths format as
  `input.[0]` vs `input[0]`. Pin these in `SDK_SPEC.md` and align.
- Duplicate journey header: Go takes the first value, Node rejects
  (`propagation.go:55-69`).

## Decisions for Jorge

1. **OTLP spec diverges from todo items O2/O3 on purpose.** The branch reads
   input/output from `wayscribe.input`/`wayscribe.output` attributes, not the
   record body; ignores `exception.*`; requires `deployment.environment.name` on
   every record instead of inheriting the key's scope; requires
   `wayscribe.event.id` and ignores `log.record.uid` (no fallback hash). Accept the
   spec, or change the code to match O2/O3?
2. **O6 examples are missing** (Collector config with `redaction` processor, a
   non-Node service, OTLP JSON curl). Required before merge, or follow-up?
3. **Go floor is `go 1.26`.** Keep, or lower (e.g. 1.24) for adoption?
4. **backup:verify:** finish on this branch (recommended; spec requires it) or
   split into a follow-up branch?

### Decided by Jorge, 2026-09-23

1. **Mixed.** Keep input/output from `wayscribe.input`/`wayscribe.output`
   attributes. Change the code so `deployment.environment.name` is optional and a
   record without it inherits the API key's environment scope, and so a missing
   `wayscribe.event.id` falls back to `log.record.uid`, then to a deterministic
   content hash. A stock OTel emitter must work with no Wayscribe-specific
   attributes. `exception.*` stays ignored.
2. **Follow-up.** O6 examples are not a merge blocker; they must land before any
   release that advertises OTLP.
3. **Lower to the oldest Go that works**, proven by running vet and race tests on
   that toolchain, not just by editing `go.mod`.
4. **Finish `backup:verify` on this branch.**

## Verified sound

- OTLP: same API-key auth as `/v1/events`; every record goes through
  `ingestEvent` (redaction, masking, env scope, size limits); canonical content
  hash and a tested mid-export 503 retry; decoder budgets and gzip output bound;
  partial_success counts include all refusal kinds. 126 unit tests pass.
- Restore never overwrites an existing DB (42P04 -> `database_exists`); uncertain
  CREATE is not dropped; `--single-transaction --exit-on-error`; backup file 0600,
  exclusive create, no-replace link; encrypted columns round-trip as ciphertext.
  CLI preview has no path to unredacted stored data. 258 unit tests pass.
- Python: 100 unit tests pass on 3.11 and 3.13; 43 propagation vectors and HMAC
  derivation vectors pass; secret-name detection matches Node on 84 names; wheel
  is clean (py.typed, LICENSE, NOTICE, no deps) and installs into fresh 3.11/3.14
  venvs; 3.10 correctly refused.
- Go: `go vet` and `go test -race` clean; transport rules SDK-27 to SDK-34 and
  SDK-65 match; stdlib only; module path matches the subdir. First release needs
  tag `packages/sdk-go/v0.1.0` and `version.go` (now `0.1.0-dev`) to match.
- Mixed-language integration test is a real proof of one journey across Node,
  Python and Go (`mixed-language.integration.test.ts:269-323`), but it only runs
  by hand.

## Status after fixes (2026-09-23)

Every item under "Merge blockers" and "Fix before merge" is fixed on the branch
(commits 85f9cff through 5eac244), except where noted under "Open" below.

### Verified locally, against HEAD

- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: pass.
- `pnpm test`: 204 files, 3,814 tests pass. This had 4 failures before the fixes
  that the review missed, because root `pnpm test` was never run: two stale
  Node SDK tests from 8ac208a, and two tests from c3183a9 that contradicted each
  other about `defaults.env`.
- `pnpm test:integration` on Postgres 17 (testcontainers): 63 files, 1,186
  tests pass, 1 skipped (the official Python OTLP exporter test, which needs
  `OTLP_EXPORTER_PYTHON` and a pip install). This covers OTLP, python-sdk-*,
  go-sdk-*, mixed-language, backup/restore/verify and CLI.
- `pnpm test:python` on 3.11 and 3.14 (115 tests); `pnpm test:go`,
  `test:go:consumer`, `test:mixed-language`: pass.
- New CI job scripts run in their real images from a `git archive` of HEAD:
  `sdk-go` on golang:1.22.0 and 1.26.4 (vet + race), `sdk-python` on
  python:3.11-slim and 3.14-slim, and `scripts/install-go.sh` plus apt python3
  (3.11.2) on node:24.

### Needs a real GitLab pipeline when minutes return

- The whole pipeline, especially the new `sdk-go`, `sdk-python` and
  `examples-go` jobs and the `database` matrix (Postgres 15/17/18) with Go and
  Python installed under docker:dind. Only Postgres 17 was run locally.
- Integration on Postgres 15 and 18.

### Open, for Jorge

1. **Stock OTel records** still need five `wayscribe.*` attributes (journey
   id, entity type, entity id, operation, name). Accepting records without
   them means choosing defaults (e.g. journey from `traceId`), which decides
   how journeys group. Recommended: keep them required; decide with the O6
   examples.
2. **Node contract change** from 8ac208a: a budget-expired event is dropped
   before another attempt, including after breaker cooldown; 0.1.0 sent it once
   more. Recorded under [Unreleased] in CHANGELOG.md. Keep it, or drop the
   "including after circuit-breaker cooldown" clause before release.
3. **Go floor is 1.22** (1.21 lacks `math/rand/v2`). 1.22 and 1.23 are past
   Go's support window; CI tests 1.22 so the claim is proven.
4. **Known, not fixed:** Python still lacks some Node diagnostics (`rejected`,
   per-event `dropped` for shutdown/retry_budget/no_verdict) and Node's
   counters; Go keeps two Go-only kinds (`invalid_option`, `invalid_event`).
   Both are listed in `docs/SDK_SPEC.md`. Python treats a 2xx body over 1 MiB
   as `no_verdict`, where Node reads any size (documented). Backup tools'
   env allowlist is untested on Windows.
5. O6 examples (follow-up, before any release advertising OTLP).

## Suggested fix order

1. Decisions above.
2. Merge blockers 1-3.
3. OTLP refusal codes + 400 on unknown shape + auth before inflate.
4. SDK host-safety: Python BaseException, fork warning, thread/goroutine leak,
   Go 3xx, Go module-local fixtures.
5. Remaining items, then run the full integration suite locally and merge.
