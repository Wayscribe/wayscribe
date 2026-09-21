# Backup and isolated restore implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create a private PostgreSQL archive, restore it into a new database, and verify a disposable restored copy with the expected encryption keys.

**Architecture:** Extend the existing database CLI registry. Keep URL normalization, child/file lifecycle, owned-database lifecycle, and read-only integrity checks in focused modules. PostgreSQL tools run on the operator's machine; serving images gain no client binaries.

**Tech Stack:** Node.js 24, TypeScript, existing pg/Knex and payload-security packages, host pg_dump/pg_restore, Vitest and owned PostgreSQL test containers.

**Spec:** `docs/superpowers/specs/2026-09-20-backup-restore-design.md`.

## Global Constraints

- Work locally in the SDK expansion worktree. No push, GitLab CI, publication, deployment, release-tag changes, account changes or external outreach.
- Use synthetic data and dedicated owned test databases. Never connect tests to a live application stack; never prune unrelated Docker resources.
- Add `backup:create`, `backup:restore` and `backup:verify` to the existing database CLI and its command registry, with corresponding root/package scripts.
- The helpers need PostgreSQL client tools on the machine running the CLI. Do not add PostgreSQL clients to the API serving image merely for these commands.
- Use an argument array, no shell. Put connection information in the child environment, never in argv or log output.
- Accept a positive integer `--timeout-ms` with a ten-minute default and a one-hour maximum. Never prompt for a password.
- Backups are whole-database custom-format dumps. Keys remain separate; readable redacted payloads remain in the dump.
- Never replace an existing file, symlink or database. Cleanup applies only to resources successfully created by this operation.
- Verification authenticates every encrypted value in bounded read-only batches; the startup unreadable-data heuristic is insufficient.
- No automatic migrations or application traffic run against the restored copy. An empty valid Wayscribe database passes; a non-Wayscribe database does not.

## File and interface map

Create `packages/database/src/backup/args.ts` for registry-backed parsing, `connection.ts` for one normalized target shared by pg and libpq, `process.ts` for bounded child execution, `archive.ts` for private files, `restore.ts` for new-database ownership, `verify.ts` for read-only inspection, and `command.ts` for safe CLI results. Keep their tests beside them. Add `backup.integration.test.ts` in the database package for the real archive lifecycle.

Existing context: `cli.ts` constructs Knex for ordinary commands; dispatch backup commands before that construction, after help/preflight and DATABASE_URL checks. `cli-commands.test.ts` has exhaustive PARSERS and RUNNABLE maps which must grow with the registry. `migration-status.ts` exports `migrationStatusReadOnly`; `repositories/rotation.ts` owns the encrypted-column registry. `testing/postgres.ts` supplies `startPostgres({ dedicated: true })`. Testcontainers must own the entire test cluster because these commands create databases.

### Task 1: Private archives and restore into a new owned database

**Files:**
- Create `packages/database/src/backup/{args,connection,process,archive,restore,command}.ts` and their focused tests.
- Create `packages/database/src/backup.integration.test.ts` for archive creation and restore.
- Modify `packages/database/src/{cli,cli-commands,cli-commands.test}.ts`, root and database package scripts, and `docs/OPERATIONS.md`.

**Interfaces:**
- `parseBackupArgs(command, args)` returns a discriminated success with output/input/database and `timeoutMs`, or a safe refusal; flag names come from the registry.
- `createBackup({ databaseUrl, output, timeoutMs, signal? }): Promise<{ bytes: number }>` creates one completed archive.
- `restoreBackup({ databaseUrl, input, database, timeoutMs, signal? }): Promise<{ database: string }>` keeps a successful new database and cleans it after failure.
- `withRestoredDatabase<T>({ databaseUrl, input, timeoutMs, signal? }, inspect: (db: Knex) => Promise<T>): Promise<T>` uses a generated `wayscribe_restore_check_<hex>` database, always closes inspect connections and removes its owned database. Task 2 consumes it.
- `runBackupCommand(command, args, { databaseUrl, env, stdout, stderr }): Promise<number>` emits safe fixed codes and summaries, not child stderr, connection strings or arbitrary error messages.

- [ ] **Step 1: Write parser/target tests and observe RED.** Assert missing/duplicate/unknown flags, fractional/negative/over-limit timeouts, help before environment access, lowercase database grammar and system/source-name refusal. Normalize connection fields explicitly for both consumers; reject unknown, duplicate and target/service-overriding query parameters before spawning, reserving files or creating databases. Inspect the installed pg connection parser and official libpq documentation when defining the supported TLS subset. Tests must prove no downgrade for supported SSL settings and fail closed for unsupported modes. Strip inherited `PG*` connection overrides from child environments rather than layering partial overrides over ambient state.

```ts
expect(parseBackupArgs("backup:create", ["--output", "x.dump", "--timeout-ms", "0"]).ok)
  .toBe(false);
// A URI is NOT a database name to put in PGDATABASE.
const target = normalizeBackupConnection("postgresql://alice:secret@127.0.0.1:5433/source");
expect(target.toolEnvironment.PGDATABASE).toBe("source");
expect(target.toolEnvironment.PGHOST).toBe("127.0.0.1");
expect(() => normalizeBackupConnection("postgresql://localhost/source?dbname=other"))
  .toThrow();
```

- [ ] **Step 2: Implement and test the child/file boundary.** Resolve/check the required tool before output reservation or database creation. Open a random adjacent temporary file with exclusive creation and 0600 mode, stream pg_dump stdout directly into it, wait for successful child exit and file close, then publish with an exclusive hard link (or equally atomic no-replace operation) and unlink the temporary name. Existing file/symlink and a destination created during dumping must survive unchanged. Bound stderr collection and ignore its content in public errors. On deadline/abort send termination, escalate if needed, await child exit and then remove only owned temporary resources. Test a real owned Node child that ignores SIGTERM; do not rely only on a mocked spawn accepting a signal.

```ts
await writeFile(destination, "keep me", { mode: 0o600 });
await expect(createBackup({ databaseUrl, output: destination, timeoutMs: 5_000 }))
  .rejects.toMatchObject({ code: "output_exists" });
expect(await readFile(destination, "utf8")).toBe("keep me");
```

- [ ] **Step 3: Implement owned restore and its cleanup.** Open/fstat a regular archive and keep that descriptor as the pg_restore input, preventing a later pathname replacement from changing the archive read. Require custom-format input. Validate the destination name, quote its SQL identifier, then atomically claim it with CREATE DATABASE using TEMPLATE template0; an advisory existence query alone never grants ownership. Record ownership only after success. Pass `--exit-on-error --single-transaction --no-owner --no-privileges --no-password`; never `--clean` or `--create`. Both pg and libpq must use the same normalized connection with only the database changed. Destroy inspect/restore connections before cleanup. Existing-database errors never trigger DROP. A cleanup failure retains the original failure and adds a safe owned-database cleanup instruction. Bound connection/query waits as well as child execution; cancellation cannot become an unbounded cleanup wait.

- [ ] **Step 4: Integrate the CLI and run real PostgreSQL evidence.** Add create/restore entries, help examples, parsers and exhaustive registry maps. Seed a dedicated PostgreSQL 18 database through existing migrations and seed helpers, create its archive, restore under a fresh name and compare repository query results. Assert 0600 permissions, preservation of an existing destination file/database, cleanup after malformed archive and timeout, and refusal before side effects when tools or connection settings are unusable. Include distinctive synthetic password/key/payload sentinels and assert they never appear in success or failure output. Run `TEST_POSTGRES_VERSION=18 pnpm exec vitest run --config vitest.integration.config.ts packages/database/src/backup.integration.test.ts`; unit tests run with the ordinary Vitest config. Update source-checkout instructions, tool-major compatibility and archive trust requirements in OPERATIONS. Keep the manual container instructions.

- [ ] **Step 5: Verify and commit.** Run database typecheck, focused tests, changed-file lint/format and CLI documentation checks. Retain actual RED/GREEN commands/output in the task report; report resource-related omissions accurately. Commit `feat(database): create private backups and restore new databases`.

### Task 2: Disposable restore verification and exhaustive encrypted-value checks

**Files:**
- Create `packages/database/src/backup/{verify,verify.test}.ts`.
- Extend `packages/database/src/backup/{args,command}.ts` and `backup.integration.test.ts`.
- Modify `packages/database/src/repositories/rotation.ts` only to share its encrypted-column metadata with a focused module if needed; preserve rotation behavior.
- Modify CLI registry/test maps, root/database package scripts, OPERATIONS and relevant roadmap/release-status docs.

**Interfaces:**
- Consume `withRestoredDatabase` from Task 1 and `migrationStatusReadOnly(db)` from `migration-status.ts`.
- `verifyRestoredDatabase(db: Knex, keyring: Keyring): Promise<BackupVerification>` returns only migration/table/count summaries, encrypted-values-examined counts and safe failure codes. It never returns decrypted content.
- `verifyBackup({ databaseUrl, input, timeoutMs, keyring, signal? }): Promise<BackupVerification>` composes that inspection with Task 1's always-cleaned temporary restore.

- [ ] **Step 1: Write integrity regressions before implementation.** Cover missing/unknown/pending migrations, an empty migrated database, non-Wayscribe input, missing/wrong/previous encryption keys, malformed ciphertext, and a corrupt middle row in a batch larger than 500 whose first/last rows are valid. The middle-row regression proves the scan authenticates every value rather than reusing the startup heuristic. Add orphan references in a deliberately altered owned test database and assert a safe integrity failure.

```ts
const result = await verifyBackup({ databaseUrl, input, timeoutMs: 30_000, keyring });
expect(result.encryptedValuesExamined).toBeGreaterThan(500);
// Neither the verifier nor its cleanup writes to the source database.
expect(await sourceSnapshot()).toEqual(before);
expect(await temporaryRestoreNames()).toEqual([]);
```

- [ ] **Step 2: Implement bounded read-only inspection.** Refuse schema mismatch before table queries, using `migrationStatusReadOnly` without creating tables or applying migrations. Count projects/environments/API keys/journeys/aliases/events/replay destinations/runs/audit rows and any later approved table present in this build. Check declared references through bounded SQL existence queries, including project/environment and composite journey scopes. Use the same encrypted-column metadata as rotation, keyset-walk every non-null ciphertext in batches of at most 500, and call `decryptValue` for each within a safe error boundary. Do not store decrypted strings or emit row identifiers. Authentication failure is a nonzero verification result. Read-only transaction/query timeouts respect the operation deadline.

- [ ] **Step 3: Expose `backup:verify` and prove cleanup on every outcome.** Require keys before creating the temporary database. It takes only `--input` and `--timeout-ms`, never a destination override or replace option. Extend registry tests and add a command subprocess test outside the repository's implicit `.env` path. Verify an old/current key rotation sample, unreadable data, incompatible schema, injected inspector failure, cleanup failure and cancellation. Assert all owned temporary databases are removed on success and recoverable failure; preserve a pre-existing colliding name without dropping it. Public output names only summaries/codes and, on cleanup failure, the owned database requiring cleanup.

- [ ] **Step 4: Validate real restore equivalence and document the boundary.** Run the real archive integration suite on PostgreSQL 18 with local 18.4 clients; compare restored journey, alias, payload/diff and replay-destination repository reads against the source, without running replay or contacting any external destination. Run rotation regressions if shared metadata moved. Explain whole-database contents, separate key backup, trusted SQL archives, new-database behavior, missing ownership/grant restoration, tested client/server majors and the difference between a restored data check and a live API recovery drill. Mark helper implementation local/unpublished and keep release gates deferred. Commit `feat(database): verify backups with isolated restores`.

## Plan self-review

Task 1 covers private archives, normalized targets, external-tool availability, timeouts, safe failures, ownership and operator invocation. Task 2 covers exhaustive key-aware integrity, disposable restore cleanup and verified recovery claims. Shared command/registry/docs files are serial. The cross-task interface is `withRestoredDatabase`; backup/restore are useful and testable before verification is added. Both tasks use dedicated test clusters; neither changes the serving-image dependencies or the main worktree.
