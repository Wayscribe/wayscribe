# Backup helpers and isolated restore verification

## Scope

This implements the backup/restore portion of ADR-065 after the native SDK and
optional OTLP work. PostgreSQL remains the only store. The existing manual
instructions in `docs/OPERATIONS.md` stay useful; the helpers make repeatable
backups and verification easier. They do not schedule backups, upload data,
rotate keys, overwrite an existing database, or promise a recovery point that
the operator has not tested.

Use the existing database CLI and its command registry. Add `backup:create`,
`backup:restore` and `backup:verify`, with corresponding root/package scripts.
The helpers need PostgreSQL client tools on the machine running the CLI.
Do not add PostgreSQL clients to the API serving image merely for these commands;
document the source-checkout invocation and the existing container commands.
Missing tools must produce a short actionable failure before any database is
created or output file reserved. Publication and deployment remain deferred.

## Backup

`backup:create --output <path>` reads the existing `DATABASE_URL` configuration
and invokes `pg_dump --format=custom --no-password`, streaming stdout directly
to a private temporary file beside the destination. Open it exclusively with
mode 0600, never replace a pre-existing file or symlink, and publish the complete
dump without an overwrite race. A failed, canceled or timed-out dump removes
only its own partial file. It never truncates the requested output path.

Use an argument array, no shell. Put connection information in the child
environment, never in argv or log output. Preserve the supplied connection's
TLS settings. Bound child stderr and print only safe operation/error codes;
PostgreSQL diagnostics can contain identifiers and recorded values. Commands
must not prompt for a password or wait forever; accept a positive integer
`--timeout-ms` with a documented ten-minute default and a one-hour maximum.
Termination waits for the owned child to exit before deleting its output.

This is a whole-database dump, including any unrelated tables in a shared
database. It contains readable redacted payloads and encrypted identifiers.
The encryption key and previous rotation keys remain separate from the dump.
Do not write them into an archive manifest or print them in success output.

## Restore into a new database

`backup:restore --input <path> --database <new-name>` uses `DATABASE_URL` as a
maintenance connection on the destination cluster. The role needs CREATEDB.
Require an explicit new name made of lowercase ASCII letters, digits and
underscores, beginning with a letter and at most 63 bytes. Refuse the source
connection's database, system databases and any existing name. Quote the SQL
identifier despite the grammar. An existence check is advisory; CREATE DATABASE
itself is the atomic claim. Use `TEMPLATE template0` for an empty destination.

Open a regular custom-format archive and run `pg_restore --exit-on-error
--single-transaction --no-owner --no-privileges --no-password` against the new
database, preserving connection/TLS settings and replacing only its database
name. Do not pass `--clean` or `--create`. The archive's original owners and
grants are deliberately not reproduced. Only trusted operator-held dumps are
accepted: a PostgreSQL archive can contain executable database definitions.

After success, keep the new database and report its generated/user-chosen name,
not its connection string. On failure, clean up only the database this process
successfully created. Never drop on an existence conflict, and never fall back
to the maintenance database when a connection fails. Preserve the original
failure if cleanup also fails and report that the owned database needs cleanup.
No automatic migrations or application traffic run against the restored copy.

## Verify by restoring

`backup:verify --input <path>` generates a collision-resistant
`wayscribe_restore_check_<hex>` name, restores using the same implementation,
checks the restored database, and drops only that owned copy in a finally path.
It accepts no caller-supplied target database or option to replace a database.

Verification checks migration compatibility with the CLI version, reads counts
from the Wayscribe tables, checks relational references through normal queries,
and decrypts encrypted identifiers and aliases in bounded read-only batches.
Reuse the repository's encryption format/keyring rules. The existing startup
`findUnreadableData` scan is a useful preflight but is not a complete integrity
check: it samples legacy values and does not authenticate every current-format
value. The restore verifier must not treat that heuristic as exhaustive.
Require the expected encryption keys for this check;
missing keys cannot be reported as a successful recovery. No identifiers,
aliases, payloads or key material appear in the report. The command exits
nonzero for incompatible schema, unreadable data, restore failure or cleanup
failure. An empty but valid Wayscribe database is valid; a non-Wayscribe dump
does not pass. It does not verify a live API or prove the operator's separate
key-backup procedure.

## Verification and organization

Keep command parsing, child-process/file lifecycle and database verification in
separate focused modules under `packages/database/src/backup/`; integrate through
`cli-commands.ts` and the existing CLI. Pure unit tests cover option rejection,
safe output, exclusive output publication and child termination. Real integration
tests use a dedicated owned PostgreSQL test container, matching dump/restore
tool major version, seeded journeys, aliases, transformations and key rotation.
They assert API/query equivalence after restore, rejection under the wrong key,
existing-database preservation, cleanup after failure and 0600 file permissions.
Use synthetic data only and never connect these checks to an existing live stack.

The local PostgreSQL client tools are 18.4; the cached PostgreSQL 18 test image
is suitable for initial verification. Record other tested versions explicitly.
The dump tool must be at least as new as the source server major; restoring into
an older server major is not a supported promise. See the official
[pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html) and
[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)
documentation, checked September 20, 2026.
