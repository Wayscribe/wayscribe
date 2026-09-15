# Operations

Running Flight Recorder for a team. It is deliberately small — one API, one web
application, one PostgreSQL database — so most of this is short.

## 1. What holds state

Everything is in PostgreSQL. There is no second datastore, no object storage, and
no external service (ADR-012). Back up the database and you have backed up
Flight Recorder.

The demo profile adds ElasticMQ, which holds nothing worth keeping.

### Bring your own database

`DATABASE_URL` is the whole coupling. Point it at the PostgreSQL your team
already runs — the one somebody backs up, monitors, and can restore — and Flight
Recorder needs nothing else from you.

```bash
export COMPOSE_FILE=compose.published.yaml
export DATABASE_URL=postgresql://user:password@db.internal:5432/flight_recorder
docker compose up -d
```

`COMPOSE_FILE` names the files every `docker compose` command in the shell
reads. The commands for the published images in this document are written
without `-f` and rely on it, so they always see the stack you started. Export it
again in a new shell.

It needs PostgreSQL 15 or later (CI tests 17), an ordinary database, and an
ordinary role: `USAGE`, `CREATE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE` on its
own schema. It does not need `CREATE` on the database: it installs no
extensions and touches nothing outside the tables its migrations create, so an
existing database with other tables in it is fine.

The bundled overlay runs PostgreSQL in a container instead and sets
`DATABASE_URL` for you:

```bash
export COMPOSE_FILE=compose.published.yaml:compose.bundled.yaml
docker compose up -d
```

A command that leaves the overlay out reports the PostgreSQL container as an
orphan and suggests `--remove-orphans`; do not take that advice, because it
removes the database container.

The overlay is for evaluation and for local work. Nothing about it is
unsuitable for production except that it is invisible to whoever is
responsible for your data — no backup schedule, no monitoring, and a `docker
compose down -v` away from gone.

### Schema changes

The `migrate` service applies migrations on boot, against your database, and it
is the only thing that writes schema. If your team applies migrations through
its own process, leave that service out and run the same command when you
choose to:

```bash
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js migrate
```

The API reports `/ready` 503 `migrations_pending` until they are applied, so it
will not serve reads against a schema it does not recognise.

## 2. Backup

With the bundled overlay, the data is in the `postgres-data` volume.

```bash
docker compose -f infrastructure/compose.yaml exec -T postgres \
  pg_dump -U flight -d flight --format=custom > flight-$(date +%F).dump
```

**Treat the dump as if it contained your customers' request bodies, because it
does.** Payloads are stored as `jsonb` in the clear; redaction, not encryption,
is what keeps secrets out of them. A dump is readable by anyone who holds it.

Entity identifiers and alias values *are* encrypted, with a key derived from
`ENCRYPTION_KEY`, which is **not** in the dump — so a backup taken without that
key restores a database whose journeys cannot be searched or attributed to a
customer, while their payloads remain readable. Store the key separately, and
store it somewhere you will still have it when you need the backup.

## 3. Restore

```bash
docker compose -f infrastructure/compose.yaml exec -T postgres \
  pg_restore -U flight -d flight --clean --if-exists < flight-2026-08-07.dump
```

Restore against the **same `ENCRYPTION_KEY`**. A restore under a different key
leaves every encrypted field undecryptable and every search token unmatchable.
The interface degrades one field at a time rather than failing, so this looks
like missing data rather than an error — check the key first when a restored
installation shows blank identifiers. A dump taken before a key rotation needs
the old key back as `ENCRYPTION_KEY_PREVIOUS`; see §6.

## 4. Upgrading

Migrate, then deploy. In that order.

```bash
pnpm db:migrate
```

`/ready` returns 503 with `migrations_pending` until the schema matches what the
running build expects. That is the designed answer, not a fault: a process
serving against an older schema must not take traffic. A rolling deploy that
starts new containers before migrating will report unready until the migration
runs, which is the correct behaviour and not a reason to skip the ordering.

Every release is gated on an upgrade test (`scripts/upgrade-test.mjs`, the
`upgrade-test` CI job). It builds the previous release (until there is one, a
commit from before v1's storage format changes), records journeys,
aliases, a transformation diff, an error and a replay destination through it,
then starts the new build against the same database volume and checks that every
search and detail reads back unchanged, that existing API keys still
authenticate, and that `rotate:reencrypt` upgrades the stored formats. From a
source checkout, `node scripts/upgrade-test.mjs` runs it with Docker and nothing
else, and `UPGRADE_BASELINE_REF` chooses the version to upgrade from.

Migrations are plain ESM JavaScript at the package root (ADR-027). **Do not
rename a migration file after it has been applied anywhere.** knex records the
filename, so a rename makes the directory look corrupt to every database that
already ran it.

From a published image, without a source checkout:

```bash
docker run --rm --network flight-recorder_default \
  -e DATABASE_URL=postgresql://flight:flight@postgres:5432/flight \
  --entrypoint node flight-recorder-api packages/database/dist/cli.js migrate
```

### Migration 015 rewrites every replay run's headers

Replays used to store the headers they sent, including the destination's
decrypted configured headers, in `replay_runs.request_headers`. Migration
`015_redact_replay_run_headers.js` replaces every value in that column with
`[REDACTED]` and keeps the header names. An old row does not say which headers
came from the destination, so the ones Flight Recorder set itself, such as
`user-agent`, are redacted too.

It is one `UPDATE` of every `replay_runs` row that has headers, in one
transaction. Measured on PostgreSQL 17 with 100,000 runs carrying payloads of
about 1 KB: the migration took about 2 seconds. An update to an existing run
while it ran, such as the previous API finishing a replay, waited until it
committed, about 2.3 seconds. Inserts of new runs were not blocked. The table
doubled in size, because every row is rewritten, until vacuum reclaimed the old
versions.

Migrate, then deploy, still applies, and it leaves a window: between the
migration committing and the new API taking traffic, the previous API is still
the one serving, and a replay it sends is stored the old way. Replays are
manual, so the simplest course is not to send one during the upgrade.

If one was sent, redact again once the new API is serving, limited to runs
created from an hour before migration 015 was applied. Count them first:

```sql
select count(*)
from replay_runs
where request_headers is not null
  and created_at >= (
    select migration_time from knex_migrations
    where name = '015_redact_replay_run_headers.js'
  ) - interval '1 hour';
```

Then rewrite the same rows:

```sql
update replay_runs
set request_headers = case
  when jsonb_typeof(request_headers) = 'object' then (
    select coalesce(jsonb_object_agg(key, to_jsonb('[REDACTED]'::text)), '{}'::jsonb)
    from jsonb_each(request_headers)
  )
  else null
end
where request_headers is not null
  and created_at >= (
    select migration_time from knex_migrations
    where name = '015_redact_replay_run_headers.js'
  ) - interval '1 hour';
```

Runs the new API wrote in that window are rewritten too, and lose the values
it kept on purpose, such as `user-agent` and `x-flight-replay`. The header
names stay. Nothing secret is lost, only what those rows could show about the
non-secret headers.

Its down migration does nothing: the values cannot be restored, and restoring
them would be the defect. **The migration does not reach copies.** A dump, WAL
archive, or replica snapshot taken before it still holds the header values, and
so do the destination's credentials inside them. If a destination header was a
credential that matters, rotate it at the destination as well.

## 5. Projects and keys

A new installation has no projects, and a key belongs to one. Create the project
first; the environment is created for you by `key:create`.

```bash
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js project:create acme "Acme Payments"

docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js key:create acme production checkout-worker
```

`project:list`, `key:list`, and `key:revoke` do what they say. A key is printed
once and is not recoverable — issue another rather than hunting for it.

A slug is lowercase letters, digits and hyphens, because it reaches project
selection, the CLI, and the interface. It cannot be changed afterwards without
touching everywhere an operator has written it down.

## 6. Key rotation

**Changing `ENCRYPTION_KEY` outright loses access to what is already stored.**
Four things derive from it by HKDF: field encryption, search tokens, the
API-key pepper, and event content hashes. Swap the value and recreate the API containers, and every stored entity identifier,
alias value, and replay destination header stops decrypting, every existing
journey stops being findable by identifier, and every issued API key answers
401.

Rotation avoids that with a grace period (ADR-044). The key being replaced stays
configured as `ENCRYPTION_KEY_PREVIOUS` beside the new one. The API writes under
the new key and reads under both, API keys move to the new key as they
authenticate, and `rotate:reencrypt` moves the stored data across. Only when
`rotate:status` says nothing is left under the old key does the old key go.

### Where the keys are read from

Set both variables in the one place your stack reads them from. A key set
anywhere else never arrives, and nothing says so.

| Stack | Read from |
| --- | --- |
| `infrastructure/compose.yaml`, with or without the demo overlay | `infrastructure/defaults.env`, then the repository-root `.env`, which wins. Shell exports do not reach these services. Edit `.env`. |
| `compose.published.yaml` | the shell, or a `.env` beside `compose.published.yaml`. A shell export wins over that file. |
| Helm | `secrets.encryptionKey` and `secrets.encryptionKeyPrevious`, or the `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` keys of your `existingSecret`. |
| `pnpm` commands in a source checkout | the repository-root `.env`. A variable exported in the shell wins over it. |

Surrounding whitespace is trimmed from both keys, so a trailing newline from a
secrets file does not make a different key. An empty `ENCRYPTION_KEY_PREVIOUS`
means no rotation is in progress. The same value in both variables stops the
API at boot with a message saying so, rather than starting a rotation that
rotates nothing.

### Running the commands

`rotate:reencrypt` and `rotate:status` read the keys the way the API does, so
run them with the same two variables the API has.

```bash
# Published images, with COMPOSE_FILE set as in §1
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js rotate:status

# infrastructure/compose.yaml, which reads .env for the one-off container too
docker compose -f infrastructure/compose.yaml run --rm --entrypoint node api \
  packages/database/dist/cli.js rotate:status

# A source checkout
pnpm rotate:status
```

Replace `rotate:status` with `rotate:reencrypt` for the other command. On Helm,
add `ENCRYPTION_KEY_PREVIOUS` to the `kubectl run` that `deploy/helm/README.md`
uses for `project:create`. `key:create` during a rotation needs both keys as
well, so a key issued mid-rotation verifies against the API beside it.
`key:revoke` reads no key.

For the published images, `COMPOSE_FILE` (§1) keeps every command on the files
the stack was started with. For a stack built from source, give every
`docker compose` command in this section the same `-f` files the stack was
started with. For the demo that means adding
`-f infrastructure/compose.demo.yaml` after `-f infrastructure/compose.yaml`.
Leave it out and Compose warns about orphan containers and suggests
`--remove-orphans`; do not take that advice, because it removes the demo
services.

### The procedure

1. Generate the new key: `openssl rand -hex 32`. Keep the old one. It is the
   only way back if something goes wrong, and a backup taken before the rotation
   needs it (see below).
2. Where your stack reads its keys (above), set `ENCRYPTION_KEY` to the new key
   and `ENCRYPTION_KEY_PREVIOUS` to the old one.
3. Recreate every API container with the new keys: `docker compose -f
   infrastructure/compose.yaml up -d` (or `docker compose up -d` for the
   published images, with `COMPOSE_FILE` set as in §1), or
   `kubectl rollout restart deployment/<release>-flight-recorder-api` after the
   Helm upgrade, since the chart does not restart pods when its secret changes.
   **Not `docker compose restart`**: it restarts the container with the
   environment it was created with, and does not re-read `env_file`, so the new
   keys never arrive. Every replica has to be on the new keys before the
   next step, because one still on the old key keeps writing under it.
4. Run `rotate:reencrypt`. It prints a line per batch, then one summary line per
   table. If it is interrupted, run it again; it resumes where the committed
   batches left off.
5. Run `rotate:status`. It exits 0 when every row and every unrevoked API key is
   under the new key. Until then, work through what it lists (below) and run it
   again.
6. Remove `ENCRYPTION_KEY_PREVIOUS` and recreate the API containers again, the
   same way as in step 3.
7. Run `rotate:status` once more. It should report `Previous key: not set` and
   `Complete`, and the API's boot log should carry no warning about unreadable
   data.

From step 3 on, nothing is interrupted: new events record, old journeys search
and open, and every API key still authenticates.

Event content hashes are not moved by any step, because a hash can only be
recomputed from the event it describes. After step 6, a resend of an event
recorded under the old key, which only a duplicate delivery produces, is
answered 409 `event_id_conflict` rather than recognised as a duplicate. The SDK
treats that as permanent and drops the resend; the event stored the first time
is unchanged (ADR-048).

A script can wait on step 5, since the exit code is the answer:

```bash
until pnpm rotate:status > /dev/null; do sleep 300; done
```

Use the form of the command your stack runs (above) in place of `pnpm`. The
exit code is also 1 when the command cannot run at all, such as with
`DATABASE_URL` unset or the database unreachable, so a loop like this one waits
forever on a misconfiguration; its error still reaches stderr every pass.

### What `rotate:status` lists

- **API keys not yet under the current key.** Each moves the next time it
  authenticates, because the presented key is the only thing a verifier can be
  recomputed from. Wait for the services holding them to send events. A key that
  will not be used again should be revoked with `key:revoke` and the prefix the
  listing shows (`key:revoke fr_AbCdEfGhIjK`), and reissued with `key:create` if
  something still needs one. Revoked keys are not counted.
- **API keys whose key id is `not recorded`.** Issued before key ids were
  stored. They record one the next time they authenticate. During a rotation
  they may be under either key, so they are treated like the keys above and keep
  the exit code at 1. With no previous key configured they are listed as `key id
  not recorded yet; recorded on next use` and do not affect the exit code: they
  can only be under the one key there is.
- **API keys under a key that is not configured.** Their key id is neither the
  current nor the previous key, so they cannot authenticate and will not move by
  themselves. Set `ENCRYPTION_KEY_PREVIOUS` to the key the listing names to let
  them authenticate during a grace period, or revoke them. They keep the exit
  code at 1.
- **Rows under the previous key.** Run `rotate:reencrypt` again. A row that
  ingestion changed while the command was reading it is left for the next run,
  and the command says how many there were.
- **Rows with no stored value.** Reported, and they do not hold the rotation
  open: there is nothing in them to rewrite. Their search tokens, though, can
  only be recomputed from a value, so they stay under the old key and stop
  matching search once `ENCRYPTION_KEY_PREVIOUS` is removed.
- **Rows under an unknown key, malformed rows, and legacy rows no key opens.**
  These keep the exit code at 1 until the key that wrote them is configured
  again or the rows are deleted. `rotate:reencrypt` counts them as unrecoverable
  and leaves them as they are. An unknown key is named by its id, which is a
  fingerprint of the key and safe to paste into a ticket.

### What `rotate:reencrypt` costs

It walks `journeys`, `entity_aliases`, and `replay_destinations` by primary key
in batches of 500, one transaction per batch, and spends one to three queries on
each row. A large table takes a long time; run it when you can leave it. It is
safe under live traffic: each rewrite is conditional on the value it read, so a
concurrent write is never overwritten.

**Without `ENCRYPTION_KEY_PREVIOUS` it upgrades instead of rotating.** It
rewrites legacy values the current key opens into the `fr1` format under that
same key, leaves search tokens as they are, and counts anything under another
key as unrecoverable. Its first line names the mode: `Upgrading legacy values
under key …` or `Re-encrypting under key …, reading values under … and legacy
values`. If the first line says `Upgrading` when you meant to rotate, step 2 did
not reach this process; nothing under the old key was touched.

**It exits 1 when another run holds the rotation lock**, and changes nothing.
The retention sweep exits 0 in the same situation, and the difference is
deliberate: a sweep runs hourly in every API replica, so a held lock means
another replica is doing the same work. A re-encryption is started once, by
someone, and a script waiting on it has to know this run did nothing.

**It needs two database connections**, one holding the lock for the whole run
and one doing the work. The retention sweep is built the same way. A connection
pooler or a role `CONNECTION LIMIT` that allows this process one connection will
stall it.

**A lost lock stops the run.** The connection holding the lock sits in an idle
transaction while the batches run on another, so a server
`idle_in_transaction_session_timeout` shorter than one batch, a pooler, or an
administrator can end it. The command checks that connection before every
batch, which also resets that timeout, so only a single batch that outlasts it
drops the lock. When it is lost the command stops after the batch in progress,
prints that it `lost the rotation lock`, and exits 1. Nothing needs undoing,
since every rewrite is conditional on the value it read: run `rotate:reencrypt`
again. Check the setting with `SHOW idle_in_transaction_session_timeout;`. The
retention sweep checks its lock the same way; when it loses it, the API logs
`retention sweep lost its lock and stopped early` and the next sweep continues.

API keys are not touched. See above for why they move on use instead.

### If the previous key was removed too early

The API still starts, because refusing would stop ingestion over a read problem.
Instead:

- after it starts listening, it logs one warning with a count per table of the
  data the configured keys cannot read, and names `rotate:status`;
- a read that meets a value under a key it lacks logs one warning per key id;
- a replay whose destination headers cannot be decrypted is refused and recorded
  as blocked, rather than sent without the destination's credentials;
- API keys that had not moved yet answer 401.

Put the old key back as `ENCRYPTION_KEY_PREVIOUS`, recreate the API containers,
and continue from step 4. Nothing stored was lost; it was only unreadable. Events
a service sent with a key that answered 401 in the meantime were not stored, and
the SDK does not retry a 4xx.

### Backups across a rotation

A dump holds values under whichever key was current when it was taken. To
restore one taken before a rotation finished, configure the key it was taken
under as `ENCRYPTION_KEY_PREVIOUS` beside the current key, restore, and run the
procedure from step 3. Keep an old key for as long as you keep backups made
under it.

### Installations from before key ids

Values written before this release carry no key id. They read normally, and
`rotate:status` counts them as legacy and exits 1 until they are rewritten. A
rotation rewrites them; so does one run of `rotate:reencrypt` with only
`ENCRYPTION_KEY` set, which upgrades them into the new format under the key they
are already under. `rotate:status` then exits 0. API keys issued before this
release are listed as `key id not recorded yet; recorded on next use`, which
does not hold the exit code at 1 while no rotation is under way.

### `ADMIN_TOKEN` and API keys

`ADMIN_TOKEN` rotation is safe and cheap. It invalidates every web session,
because the session signing key is derived from it — which is the correct
behaviour after a suspected leak, not an inconvenience.

API keys rotate individually and without side effects:

```bash
pnpm key:create local production new-worker-key
pnpm key:revoke fr_AbCdEfGhIjK    # the old key's prefix, from key:list
```

## 7. Retention

Each environment has its own `retention_days`. A sweep runs hourly inside the
API process, guarded by a PostgreSQL advisory lock so replicas do not delete
concurrently (ADR-026), and deletes in bounded batches.

Deleting a journey removes its events, aliases, and replay runs by cascade.

Retention stops while the API is down and resumes on the next start. Each sweep
that deleted anything writes one line:

```json
{ "journeysDeleted": 1420, "batches": 2, "environmentsExamined": 3, "durationMs": 91 }
```

A sweep that stops completing writes nothing at all, which is why its outcome
is also a metric (§13).

Retention is not the only way data leaves: §8 deletes a journey, an identifier,
or a time window on demand.

`DEFAULT_RETENTION_DAYS` applies to environments created by `db:seed` and
`key:create`. Changing it does not alter environments that already exist —
update `environments.retention_days` for those.

## 8. Deleting data

Retention removes data by age. Three commands remove it on demand: one journey,
every journey matching an identifier, and an environment's journeys in a time
window. They cover what retention cannot wait for: a redaction miss that stored
something it should not have, a customer asking to be forgotten, and a noisy
window such as a load test. A fourth command removes a replay destination
(ADR-045).

Every deletion is a hard delete. A journey's events, its aliases, and the replay
runs of those events go with it. Each deletion writes a row to `audit_events` in
the same transaction as the delete, so nothing is deleted without a record.

### Dry run first

`delete:identifier` and `delete:range` take `--dry-run`, which lists exactly what
the same command would delete and deletes nothing. Run it, read the table, then
run the command again without the flag.

```bash
pnpm delete:identifier local CLI-CUST-1 --dry-run
```

```text
Dry run: 2 journeys match in local (all environments). Nothing was deleted.

ID         ENVIRONMENT  ENTITY TYPE  EVENTS  LAST ACTIVITY
jrn_cli_b  development  customer     1       2026-08-11 10:00:00
jrn_cli_a  development  customer     2       2026-08-10 10:00:05
```

```bash
pnpm delete:identifier local CLI-CUST-1
```

```text
  batch 1: 2 journeys deleted so far
Deleted 2 journeys and 3 events in local (all environments). The audit log records the search token, not the value.
Journeys recorded after the run started were left alone; run it again with --dry-run to check for any.
```

### The commands

| Command | Deletes |
| --- | --- |
| `pnpm delete:journey <project> <journey-id>` | one journey |
| `pnpm delete:identifier <project> <value> [--environment <name>] [--dry-run]` | every journey whose entity id or any alias is the value, which is what search finds for it |
| `pnpm delete:range <project> <environment> --before <date> [--after <date>] [--dry-run]` | the environment's journeys whose last event falls in `[after, before)` |
| `pnpm delete:destination <project> <destination-id>` | a replay destination and every replay run sent to it |

**Erasure finds entity ids and aliases, not payloads.** `delete:identifier`, and
`POST /v1/erasures`, match the value against journeys' entity ids and aliases,
which is exactly what search finds. A value that appears only inside a payload is
not matched: an email address a service put in `input` but never recorded with
`identify()` or as an alias. An erasure request for such a value deletes nothing,
and the dry run shows zero journeys. An erasure that scans payloads is not built.
Until it is, find those journeys another way (the entity id or an alias the
customer is also known by, the time window and service of their activity, or
your own application's records), confirm each on its journey page, and delete
each with `delete:journey <project> <journey-id>` or the journey page's delete
action. Recording the identifiers a request may name as aliases is what makes
erasure find them.

Each exits 1 whenever what was asked did not fully happen: an unknown project,
environment, journey, or destination, a value that is only whitespace, an
invalid date, a held lock, or a run that stopped part way. A script can rely on
the exit code.

A date is an ISO-8601 date, read as midnight UTC, or a timestamp with an explicit
offset such as `2026-09-01T00:00:00Z`. A timestamp without an offset is refused,
because it would delete a different window depending on the server's time zone.
`--after` defaults to the beginning of time and must be earlier than `--before`.

`delete:identifier` needs `ENCRYPTION_KEY`, and `ENCRYPTION_KEY_PREVIOUS` during a
rotation, because the value is matched by its search tokens under both keys. It
never prints the value.

**The value you type is still recorded outside Flight Recorder.** It stays in
your shell's history, and anyone who can list processes on that host sees it in
`ps` while the command runs. The same is true of the API key given to
`doctor --api-key` (§12), which is a credential rather than an identifier. In bash with `HISTCONTROL=ignorespace` (or zsh with
`setopt HIST_IGNORE_SPACE`), start the command with a space and it is not saved;
otherwise remove the line afterwards (`history -d <number>` in bash). Run it on a
host whose process list only operators can read.

A value or id that begins with a dash goes after `--`, so it is not read as an
option: `pnpm delete:identifier acme -- -A1`.

`delete:range` takes the retention sweep's advisory lock, so a range deletion
and a sweep never run at once. While the sweep holds it the command deletes
nothing, says so, and exits 1; run it again when the sweep has finished.

From the published image, without a checkout:

```bash
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js delete:identifier acme customer-42@example.com --dry-run
```

The admin API deletes a journey, an identifier, and a destination
(`docs/API_SPEC.md` §17 to §19), and a journey's page links to a confirmation
page that deletes it. Range deletion is in the CLI only.

### Late arrivals

An erasure or a range deletion deletes the journeys that existed when it
started. A journey created while it runs, because the customer is still being
ingested or the environment is live, is left for the next run; without that
limit a busy environment could keep a run going, and holding the retention lock,
indefinitely. **Run the dry run again afterwards**, and if it lists anything, run
the deletion again.

### What the audit row holds

| Action | Records |
| --- | --- |
| `journey.deleted` | the journey id, its environment, its event count |
| `erasure.completed` | the current key's search token for the value, the environment if one was named, journeys and events deleted, `complete` |
| `range.deleted` | the environment id, `after`, `before`, journeys deleted, `complete` |
| `replay_destination.deleted` | the destination id, its name, replay runs deleted |

An erasure's row never holds the value. A later erasure of the same value
records the same token under the same key, so the two can be matched.

A destination's audit rows, at creation and at deletion, hold its name and not
its base URL. Rows written by `replay_destination.created` before that changed
do hold the base URL, and deleting the destination leaves them. If a URL carried
something that must go, strip it and keep the rest of the record:

```sql
update audit_events
   set metadata = metadata - 'baseUrl'
 where action = 'replay_destination.created';
```

Erasure and range deletion commit in batches, each its own transaction. The row
is written with the first batch and updated with every batch after it, and the
last batch, which finds nothing left, sets `complete: true`. **`complete: false`
means the run stopped before it finished**: the process died, the database
connection failed, or a range deletion lost its lock, in which case the row also
has `lockLost: true`. Its counts are exactly what was deleted. Run the same
command again to delete the rest; that run writes a row of its own.

### What deletion does not remove

- **The bytes, until vacuum.** A deleted row stays in the table's files as a dead
  row until autovacuum processes the table, and even then the space is marked
  reusable rather than overwritten. `VACUUM` on `journeys`, `journey_events`,
  and `entity_aliases` hastens the first; `VACUUM FULL` rewrites the files, and
  locks the tables while it does.
- **Backups.** Every dump and every WAL archive taken before the deletion still
  holds the data. Deleting from the database does not reach them; how long they
  are kept is your backup retention, and an erasure request covers them too.
- **What your services logged.** Deletion removes what Flight Recorder stored.

## 9. Exposure

Every published port binds to `127.0.0.1`. A `docker compose up` on a cloud host
does not expose the stack to the internet, and that is the only thing standing
between the default configuration and an open admin interface.

If you put Flight Recorder behind a reverse proxy, terminate TLS there and do not
republish the container ports on `0.0.0.0`. The web app sets its own
`Content-Security-Policy`, with a fresh nonce per response, and
`X-Frame-Options`, `Referrer-Policy` and `X-Content-Type-Options`
(`docs/SECURITY.md` §2). Let them through: a proxy that replaces the policy with
a fixed one blocks the interface's scripts, and one that caches pages would serve
a stale nonce. Pages are sent `Cache-Control: no-store` already.

Pass the original `Host` header through to the web app, or set
`X-Forwarded-Host`, and set `X-Forwarded-Proto`. The web app refuses a form post
whose `Origin` names a different host from the one the request was sent to, so a
proxy that rewrites `Host` to the container's name without `X-Forwarded-Host`
refuses every sign-in. Redirects after a form post are path-only (`Location:
/login?error=invalid`), so they follow whatever scheme and host the browser is
on and do not depend on `X-Forwarded-Proto`; set it anyway, because anything
behind the proxy that builds an absolute URL does.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

The admin token grants project-wide read of every recorded payload. It is a
single shared secret with no user accounts and no audit of who used it — treat
it as an operator credential, not a login.

### Replay destinations

Replay makes the API send a recorded payload to a destination an admin
configured. `REPLAY_ALLOWED_HOSTS` is the control that keeps that from being a
request forgery tool inside your network: a destination whose host is not in the
list is refused before anything is sent (ADR-033). It is load-bearing, because
private addresses are deliberately allowed, since every development destination
lives in one. Nothing else stands between a leaked admin token and a request to
any service the API can reach.

- A host matches exactly, on any port. There are no wildcards.
- `localhost` is the API's own container or pod, including the API port and
  `METRICS_PORT`.
- `host.docker.internal` reaches every service listening on the Docker host,
  not only the one under development: databases, other applications, and
  anything bound to the host's loopback interface.
- A Compose or Kubernetes service name reaches that service from inside the
  network, whether or not it is published.

`compose.published.yaml` and the Helm chart default to `localhost` alone.
`infrastructure/compose.yaml`, the development and demo stack, allows
`host.docker.internal` and `demo-integration` so the demo and a service running
on your machine can be replayed to, and `deploy/helm/values-local.yaml` allows
`host.docker.internal` for a kind cluster. **A production installation should set
the list explicitly to the few development hosts it replays to**, and to
`localhost` or an unused name when it replays to nothing:

```bash
REPLAY_ALLOWED_HOSTS=billing-dev.internal,orders-staging.internal
```

An installation that relied on the previous default of
`localhost,host.docker.internal` in `compose.published.yaml` or the chart must
now set it.

### Guessing the admin token

Both places that accept it throttle failures per source address: five failures
within a minute lock that address out for five minutes. The web login redirects
a locked address to `/login?error=throttled`. The API counts a refused
credential on any route that takes the admin token (every route but ingestion
and the health checks), answers it with the same `401` as before, and then
answers every request from that address that presents credentials with `429
too_many_attempts` and a `Retry-After` header, the right token included, until
the lock expires. A request with no credentials is not counted, a database error
while a key is looked up is not counted, and ingestion is never throttled.

The API counts refusals, not attempts in flight. Guesses sent one after another
get exactly five `401`s. Guesses sent all at once can get more: every request
that passed the lock check before the fifth refusal was recorded still has its
credential checked. On the admin-only routes that is only what was already
between the check and the comparison, which has no I/O between them; on the
read routes an API key is looked up in the database first, so a burst of N
concurrent bad keys from one address can see up to N `401`s, and the request
after it is `429`. That is a deliberate trade. The admin token is at least 32
characters and an API key carries 192 random bits, so extra guesses change
nothing about the odds, and each costs one indexed lookup; holding the count
exact would mean reserving and queueing requests in flight on the authentication
path. Reads with a valid key are never held back. The web login reads the form
and then checks the lock and compares with nothing in between, so it stays at
exactly five under any concurrency.

An IPv6 address counts as its /64, the block one host is usually given, and an
IPv6 address carrying an IPv4 one, as a dual-stack socket reports an IPv4 client
(`::ffff:203.0.113.5`, in any spelling), as that IPv4 address. A port, brackets,
and an interface zone are ignored, so `[2001:db8::1]:443` and `2001:db8::1` are
one address.
Both counts are held in memory, per process: they reset on restart, N replicas
allow N times the attempts, and each remembers at most 50,000 addresses, forgetting
the one that failed least recently beyond that.

The source address is the socket's by default. `X-Forwarded-For` is ignored,
because any client can write it and a new value per guess would otherwise make
every guess the first. Behind a reverse proxy, every request arrives from the
proxy, so every client shares one count, and a guesser can lock the operator out.
Set `TRUSTED_PROXY_COUNT`, on the API and the web app, to the number of proxies
that append to `X-Forwarded-For`; the address used is then the entry that many
hops from the right, which is what the outermost of them saw. Set it only when
nothing reaches the container except through those proxies: a client that
connects directly can write as many hops as the count and choose its own
address.

## 10. Sizing

Event volume drives everything. One journey is one row plus one row per event,
plus a row per alias. Payloads are stored inline as JSONB.

### Measured disk per event

`scripts/measure-storage.mjs` records journeys of the demo's shape (ten events
and two aliases each, with small Salesforce and customer payloads averaging 120
bytes of JSON input and output per event) through the real ingestion code, in
each capture mode, and reports what `journeys`, `journey_events`, and
`entity_aliases` occupy with their indexes and TOAST. Run on an Apple M3 Pro,
PostgreSQL 17.11 (`postgres:17-alpine`, default configuration) in Docker
Desktop with 12 CPUs and 7.75 GiB:

| Capture mode | 100,000 events | 1,000,000 events | Compacted, per event | Per journey |
|---|---|---|---|---|
| `metadata-only` | 113.5 MiB (1,190 B) | 1,001 MiB (1,049 B) | 873 B | 10.2 KiB |
| `allowlisted-fields` | 134.8 MiB (1,414 B) | 1.19 GiB (1,273 B) | 1,097 B | 12.4 KiB |
| `redacted-payload` | 154.2 MiB (1,617 B) | 1.39 GiB (1,494 B) | 1,320 B | 14.6 KiB |
| `full-payload` | 151.3 MiB (1,586 B) | 1.39 GiB (1,496 B) | 1,320 B | 14.6 KiB |

The first two columns are as ingested, after a plain `VACUUM`; the per-event
figure is the total divided by events, so each event carries its share of its
journey and aliases. Compacted is after `VACUUM FULL`. The difference is
mostly the `journeys` table: every event updates its journey, the updates
cannot be HOT because indexed columns change, and at a million events the
table and its indexes were 121 MiB as ingested against 77 MiB compacted. A
running installation sits between the two.

What the numbers say:

- **Indexes are 39 to 56 percent of the disk.** At a million events in
  `metadata-only`, the three tables held 559 MiB of indexes out of 1,001 MiB;
  in `redacted-payload`, 556 MiB out of 1.39 GiB.
- **Payload capture costs about four times the payload's JSON size.**
  `redacted-payload` added 445 bytes per event over `metadata-only` for 120
  bytes of JSON: JSONB is larger than JSON text for small objects, and a step
  with both an input and an output also stores their diff. `full-payload` and
  `redacted-payload` match here because the demo payloads hold no secrets.
- **Retention does not shrink the files.** Starting from the compacted size
  after `VACUUM FULL` (832.7 MiB, `metadata-only`), deleting half the journeys
  with the retention sweep and running a plain `VACUUM` left it at 832.9 MiB.
  Ingesting as many journeys again brought it to 982 MiB, below the 1,001 MiB
  the same volume took the first time: the freed space was reused over one
  delete-and-refill cycle. Longer runs were not measured. A sweep or a §8
  deletion is not a way to get space back. `VACUUM FULL` returns it, but
  holds an exclusive lock that stops ingestion for as long as it runs.

### A formula

```text
disk ≈ events per day × retention days × bytes per event × 1.5
```

Take bytes per event from the 1,000,000-event column for your capture mode, and
for payloads larger than the demo's add four times their average JSON size
(input plus output). The margin of 1.5 covers what the measurement does not:
autovacuum falling behind a burst, journeys that keep receiving events and so
outlive the window, and index growth beyond what a million events shows. It
does not cover WAL (`max_wal_size`, 1 GB by default), backups, or the
database's other tenants.

For example, a million events a day kept 30 days in `redacted-payload`:
1,000,000 × 30 × 1,494 × 1.5 is 67 GB, about 63 GiB.

To measure your own shape, against a scratch database (it refuses one that
already holds journeys, and works in schemas of its own that it drops after):

```bash
pnpm --filter "@flight-recorder/api..." build
node scripts/measure-storage.mjs --database-url postgresql://… --journeys 10000
```

### Indexes

Search looks a value up in one index per kind of identifier:
`journeys_pkey` for a journey id, `journeys_entity_value_idx` and
`entity_aliases_value_idx` for entity and alias values, and one index each on
`journey_events` for trace, span, message, and correlation ids. It takes about
0.1 ms at a million journeys for a value that matches a few journeys. A value
that matches thousands (a shared correlation id, say) is joined with a
sequential scan of the project's journeys, so its cost grows with the journey
count: 13 ms for 2,400 matches among 120,000 journeys and 64 ms for 20,000
among a million, for an API key scoped to one environment. `journeys_recent_idx` serves retention selection. The
recent-journeys list adds `journeys_status_recent_idx` and
`journey_events_service_idx`; the second costs one more index write on every
event insert, and the span id index adds one on every event that carries a
span id. `replay_runs_journey_event_idx` (migration 016) serves deletion rather
than reads: every event a deleted journey takes with it looks up its replay runs
through that foreign key, and without the index each one scanned the project's
replay runs (§13, Statement timeout). Migrations 013, 014, and 016 build their
indexes with `CREATE INDEX CONCURRENTLY`, so on a large installation they take
longer than the other migrations but do not block ingestion while they run (014
took 3 seconds over 3 million events).

If one of those builds stops partway, what to do depends on how it stopped:

- **The build failed** (an error was reported, or the connection dropped) and
  `migrate` exited. Run `migrate` again. It drops the index the failed build
  left invalid and builds it afresh.
- **The migrate process was killed** (`kill -9`, an evicted pod, a stopped
  container). Because 013, 014, and 016 run outside a transaction, the migration lock is
  still set and every `migrate` after it fails with a message that the
  migration table is locked; the Helm Job's retries fail the same way and
  `/ready` stays `migrations_pending`. First make sure no `migrate` is still
  running anywhere, then release the lock and migrate:

  ```bash
  node packages/database/dist/cli.js migrate:unlock
  node packages/database/dist/cli.js migrate
  ```

  (`pnpm db:migrate:unlock` from a checkout.) Releasing the lock while another
  `migrate` is running lets two run at once, so check first.

## 11. Security scanning

Three scanning jobs run in the `security` stage, and all three block. A fourth,
`sbom`, blocks too, but judges nothing about the images: it fails only when an
SBOM cannot be generated, because a release would then fail at the same step
(see *Verifying a published image* below).

| Job | Tool | What it gates |
| --- | --- | --- |
| `audit` | `pnpm audit` | dependency advisories at `high` and above |
| `secrets` | gitleaks | credentials anywhere in the history |
| `container-scan` | Trivy | `HIGH` and `CRITICAL` CVEs in both images |

GitLab's own Dependency Scanning and Container Scanning templates are
Ultimate-tier. On a Free project they produce an empty report, which looks
exactly like a scanner that works — so these run the underlying tools directly.

**Create a pipeline schedule.** Under *Build → Pipeline schedules*, a daily or
weekly run on the default branch. This is the part that matters: an advisory is
published against a dependency that has not changed, and a base-image CVE
appears without anybody committing anything. A push-only gate reports
yesterday's answer indefinitely.

`container-scan` is deliberately not on every push — it builds two images, and
the same reasoning that keeps `demo` and `e2e` manual applies. It runs on the
default branch, on tags, and on the schedule.

### When one of them fails

**`audit`.** Prefer fixing over ignoring. A transitive advisory can usually be
pinned forward with an entry in `overrides` in `pnpm-workspace.yaml`, which
removes the finding rather than hiding it. Each entry says what it is for and
should be dropped once the parent ships a version that resolves it.

**`secrets`.** Assume it is real until you have read the line it matched. If it
is genuinely a fixture, add an allowance to `.gitleaks.toml` — against the
*value* rather than the path, so it cannot hide whatever lands in that file
next. If it is real, the credential is already published: rotate it first, and
treat removing it from history as cleanup rather than as the fix.

**`container-scan`.** Check whether the package is ours before reaching for an
ignore. The first run found seven CVEs in `npm` and `corepack`, which the base
image ships and the runtime never uses; both Dockerfiles now delete them, which
is a smaller attack surface as well as a clean scan.

### Publishing the SDK to npm

`@flight-recorder/node` is published by the manual `publish-sdk` job on a
`vMAJOR.MINOR.PATCH` tag, with npm trusted publishing and provenance. No npm
token exists anywhere in the project: the job's GitLab OIDC token, with the
audience `npm:registry.npmjs.org`, is exchanged by npm for a short-lived publish
token, and a second token with the audience `sigstore` signs the provenance
statement that npmjs.com shows beside the version. npm stopped issuing classic
and Automation tokens in November 2025, and the granular tokens left expire in
90 days at most.

**Once, before the first release**, the project owner must:

1. Own the `@flight-recorder` scope on npmjs.com.
2. Register the trusted publisher. It is set per package, and the package must
   exist first, so for the very first version publish it once by hand with
   `npm login` and `npm publish` from the packed tarball
   (`DRY_RUN=1 scripts/publish-sdk.sh vX.Y.Z` shows it builds), then open
   *npmjs.com → @flight-recorder/node → Settings → Trusted publisher → GitLab CI/CD*
   and enter exactly:
   - Namespace: `jojithedev`
   - Project name: `flight-recorder`
   - Top-level CI file path: `.gitlab-ci.yml`
   - Environment: leave empty
3. In the same settings page, under *Publishing access*, choose to require
   two-factor authentication and disallow tokens, so trusted publishing is the
   only way to publish.
4. Protect `v*` tags (below). Anyone who can create one can run the job.

A field that does not match fails during `npm publish` with an authentication
error, not at the start of the job. The job needs npm 11.5.1 or later, which the
`node:24-alpine` image has; `scripts/publish-sdk.sh` checks the version and says
so rather than failing inside publish. To rehearse a release anywhere, run
`DRY_RUN=1 scripts/publish-sdk.sh vX.Y.Z`, which builds, packs, checks the
packed manifest, and runs `npm publish --dry-run`.

To verify a published version's provenance, run `npm audit signatures` in a
project that depends on it, or read the provenance panel on the package page.

### Verifying a published image

Every released `api` and `web` image is signed, and carries a CycloneDX software
bill of materials (SBOM) for each platform, attached as a signed attestation.
Both are made in the `publish-images` job with keyless signing: GitLab gives the
job an OIDC token, and Sigstore's certificate authority issues a short-lived
certificate naming the pipeline file and the tag it ran for. There is no signing
key for anyone to steal, and the signature is recorded in Sigstore's public
transparency log. Nothing is signed before the first release is published.

The job pushes each image by digest with no tag, attaches the SBOMs to that
digest, signs it, verifies the signature and attestations as below, and only
then points the version tag and `latest` at it. A release whose signing failed
has no version tag, so an unsigned image cannot be pulled by its version.

**What a signature proves depends on tag protection.** The certificate says a
pipeline ran `.gitlab-ci.yml` at `refs/tags/v1.0.0` in this project. That is
worth something only if nobody but a maintainer can create a `v*` tag. Before
the first release, the project owner must add `v*` as a protected tag with
*Allowed to create* set to Maintainers (*Settings → Repository → Protected
tags*). The pipeline also runs release jobs only for tags of the exact form
`vMAJOR.MINOR.PATCH`, so `phase-*`, `usable-v0` and pre-release tags never
publish, but that pattern is a guard against mistakes, not against someone who
can push tags.

**Before enabling a registry cleanup policy**, make sure it keeps tags matching
`sha256-.*`. Where the registry does not serve the OCI referrers API, cosign
stores signatures and attestations under tags of that form beside the image, and
a cleanup policy that deletes them leaves every release unverifiable.

Use [cosign](https://github.com/sigstore/cosign) 3.x, the major version the
pipeline signs with, plus `jq` and Docker's `buildx` for the SBOM steps.

**The signature.** For a version you have chosen, name its tag exactly:

```bash
cosign verify registry.gitlab.com/jojithedev/flight-recorder/api:v1.0.0 \
  --certificate-identity 'https://gitlab.com/jojithedev/flight-recorder//.gitlab-ci.yml@refs/tags/v1.0.0' \
  --certificate-oidc-issuer https://gitlab.com
```

The double slash before `.gitlab-ci.yml` is part of GitLab's identity format,
not a typo. To accept any release tag, for example in an admission policy that
checks every image a cluster pulls:

```bash
cosign verify registry.gitlab.com/jojithedev/flight-recorder/api:v1.0.0 \
  --certificate-identity-regexp '^https://gitlab\.com/jojithedev/flight-recorder//\.gitlab-ci\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
  --certificate-oidc-issuer https://gitlab.com
```

Replace `api` with `web` for the web image. A pass prints the checks cosign
performed and exits 0. Any other result means the image was not produced by
this project's release pipeline: do not run it, and report it as described in
`SECURITY.md`.

`latest` verifies only with the regexp form. Its certificate names the version
tag the image was released under, not `latest`, so the exact identity above
would need you to know that version already. Pin a version tag or a digest in
anything you deploy.

**The SBOM.** An SBOM lists the files of one platform, so it is attached to that
platform's manifest rather than to the multi-platform tag. Find the digest for
your platform, verify the attestation on it, and extract the document:

```bash
IMAGE=registry.gitlab.com/jojithedev/flight-recorder/api
TAG=v1.0.0
ARCH=amd64   # or arm64

DIGEST=$(docker buildx imagetools inspect "$IMAGE:$TAG" --format '{{json .Manifest}}' \
  | jq -r --arg arch "$ARCH" \
    '.manifests[] | select(.platform.os == "linux" and .platform.architecture == $arch) | .digest')

cosign verify-attestation "$IMAGE@$DIGEST" --type cyclonedx \
  --certificate-identity "https://gitlab.com/jojithedev/flight-recorder//.gitlab-ci.yml@refs/tags/$TAG" \
  --certificate-oidc-issuer https://gitlab.com \
  | head -n 1 | jq -r '.payload' | base64 -d | jq '.predicate' > "api-$TAG-$ARCH.cdx.json"
```

`cosign verify-attestation` prints one JSON document per verified attestation.
A release attaches one SBOM per platform digest, so there is one line; `head -n
1` keeps the extraction to a single document if a digest ever carries more.

The result is a CycloneDX 1.6 JSON document that Grype, Trivy
(`trivy sbom api-v1.0.0-amd64.cdx.json`), and Dependency-Track read directly.
The release job keeps the same files as artifacts, and the `sbom` job produces
SBOMs for the images built from each default-branch pipeline, which is what to
look at between releases.

### Rehearsing the publish step

`scripts/publish-image.sh` with `DRY_RUN=1` runs everything `publish-images`
does except the cosign calls, which it prints: the multi-platform build, the
push by digest, the SBOMs from the pushed manifests, and the tags. Point it at a
throwaway registry rather than the real one:

```bash
docker run -d --name rehearsal-registry -p 127.0.0.1:5055:5000 registry:2
printf '[registry."127.0.0.1:5055"]\n  http = true\n' > /tmp/buildkitd.toml
docker buildx create --name rehearsal --driver-opt network=host \
  --buildkitd-config /tmp/buildkitd.toml --use

DRY_RUN=1 SBOM_DIR=/tmp/sboms \
  SYFT_DOCKER_ARGS='--network host -e SYFT_REGISTRY_INSECURE_USE_HTTP=true' \
  scripts/publish-image.sh v0.0.0-rehearsal \
    apps/api/Dockerfile=127.0.0.1:5055/flight-recorder/api \
    apps/web/Dockerfile=127.0.0.1:5055/flight-recorder/web

docker buildx rm rehearsal && docker rm -f rehearsal-registry
```

Signing itself cannot be rehearsed without publishing: the signature is pushed
beside the image and written to the public transparency log.

## 12. Checking an installation

`doctor` checks an installation end to end and says what to fix. Run it after
`key:create`, after an upgrade, and whenever something looks wrong. It is in the
API image, like the other commands:

```bash
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js doctor --api-url http://api:8080 --api-key fr_…
```

From a checkout, `pnpm run doctor --api-url http://localhost:8080 --api-key fr_…`
reads the repository-root `.env`.

Run it with the API's environment, because that is what it checks: the same
`DATABASE_URL`, `ENCRYPTION_KEY`, `ADMIN_TOKEN`, and
`DATABASE_STATEMENT_TIMEOUT_MS`. `docker compose run … api` gives it exactly
that. Inside Compose the API is `http://api:8080`, not `localhost`.

Each check prints one line, and anything that did not pass prints its fix
beneath it:

| Check | Fails when | Warns when |
| --- | --- | --- |
| Database reachable | the connection is refused, the host does not resolve, or authentication fails | |
| PostgreSQL version | below 15 | below 17, the version CI tests |
| Migrations | any are pending, the database has one this build does not, or the role has no `USAGE` on the schema holding them (the fix names the `GRANT`) | |
| `ENCRYPTION_KEY`, `ADMIN_TOKEN`, `ENCRYPTION_KEY_PREVIOUS` | one is a published development default, or `ADMIN_TOKEN` is too short to start the API | `ADMIN_TOKEN` is not set where doctor runs |
| Keys readable | stored data or API keys are under a key that is not configured (the boot check's count) | a rotation is in progress |
| Projects and keys | | no project, no unrevoked API key, or the published demo key (`fr_demo00000`) is unrevoked |
| Journey environments | an event was written by another environment's API key than its journey's own, which ingestion now refuses (ADR-038, amendment) and earlier builds did not | |
| API key (`--api-key`) | the key is unknown, revoked, belongs to a removed project, or does not verify under the configured keys | |
| API reachable (`--api-url`) | `GET /ready` does not answer 200; its `reason` is printed | |
| Statement timeout | the value is invalid | it is 0 |

A check that depends on one that failed prints `SKIP` rather than failing a
second time: with migrations pending, nothing that reads the tables runs. A
check that cannot run at all, such as one refused by a role without grants,
prints `FAIL` with PostgreSQL's SQLSTATE (`42501` for a missing grant) and a fix
where doctor knows one, and the remaining checks still run. The exit code is 1
when anything failed and 0 otherwise, so warnings do not break a script.

The API key is checked locally, with the keyring, and never sent anywhere. The
output names its prefix and the project and environment it belongs to, which is
the environment every event it sends must name. Doctor never prints the database
password, the admin token, either encryption key, or more of a key than its
prefix.

It changes nothing. It reads applied migrations from `knex_migrations` only when
that table exists, so on a database nobody has migrated it does not create knex's
tables the way `migrate` and `/ready` do; it does not record a key as used; and
it does not move a verifier during a rotation. An applied migration this build
does not have, left by a newer build, is a `FAIL` of its own.

### Events written across environments

Before the amendment to ADR-038 an API key for one environment could write events and aliases into
a journey another environment created. `Journey environments` counts the events
that were. It prints counts and no journey ids, because a journey id can carry a
business identifier. List them with:

```sql
select p.slug as project, j.id as journey_id, je.name as journey_environment,
       ee.name as event_environment, count(*) as events
  from journey_events e
  join journeys j on j.project_id = e.project_id and j.id = e.journey_id
  join projects p on p.id = j.project_id
  join environments je on je.id = j.environment_id
  join environments ee on ee.id = e.environment_id
 where e.environment_id <> j.environment_id
 group by p.slug, j.id, je.name, ee.name;
```

Each row is a journey that holds another environment's events. Its aliases cannot
be told apart: `entity_aliases` records no environment, so an alias on such a
journey may have come from either side, and a status of `failed` may be the other
environment's. Read the journey, then delete it with
`pnpm delete:journey <project> <journey-id>` (§8). Deleting only the foreign
events would leave their aliases behind. The query and the check scan
`journey_events`; on a large installation run it off-peak, and if doctor's check
is cancelled by the statement timeout, run the query directly.

## 13. Monitoring

### Metrics

Set `METRICS_PORT` and the API serves Prometheus metrics at `/metrics` on that
port, and only there: `/metrics` on the API port is 404, so publishing ingestion
never publishes metrics by accident. Unset, which is the default, nothing listens
(ADR-047).

Neither Compose file publishes the port. A Prometheus on the same Compose network
scrapes `api:9464`; one on the host needs a loopback mapping in an override file:

```yaml
# compose.override.yaml
services:
  api:
    ports:
      - "127.0.0.1:9464:9464"
```

With Helm, `api.metricsPort` adds a container port named `metrics` that no
Service carries; scrape the pods.

The endpoint has no authentication. It carries no request values, but it does
describe traffic, so keep it on a network only your monitoring reaches.

| Metric | Type | Labels |
| --- | --- | --- |
| `flight_recorder_http_requests_total` | counter | `method`, `route`, `status` |
| `flight_recorder_http_request_duration_seconds` | histogram | `method`, `route` |
| `flight_recorder_events_total` | counter | `result`: `accepted`, `duplicate`, `rejected` |
| `flight_recorder_query_timeouts_total` | counter | `route` |
| `flight_recorder_db_pool_connections` | gauge | `state`: `used`, `free`, `pending` |
| `flight_recorder_retention_sweep_runs_total` | counter | `outcome`: `completed`, `locked`, `stopped_early`, `failed` |
| `flight_recorder_retention_journeys_deleted_total` | counter | |
| `flight_recorder_retention_last_success_timestamp_seconds` | gauge | |
| `flight_recorder_unreadable_values` | gauge | `table` |
| `process_resident_memory_bytes` | gauge | |
| `nodejs_eventloop_lag_seconds` | gauge | |

`route` is the route pattern the router matched, such as
`/v1/journeys/:journeyId`, never the path. A request that matched no route is
`unmatched`, so a scanner walking random paths adds one series, not one per
path. `method` is one of the seven methods the API uses or `other`. No label
carries a project id, key prefix, entity, or any value from a request.

A URL the router refuses before any route runs is counted too, as `unmatched`:
400 for malformed percent-encoding and 414 for a path parameter longer than any
id. A request too malformed for Node's HTTP parser never becomes a request, so
it is not counted; at `LOG_LEVEL=trace` it is logged as `client error`.

`rejected` counts every event the API told a client it did not store: a
validation failure, an environment the key does not cover, a conflicting event
id, and also a storage failure or a timed-out statement, which the client may
send again. `duplicate` is an event already stored, accepted and not stored
twice.

The request duration buckets are 5, 10, 25, 50, 100, 250 and 500 milliseconds,
then 1, 2.5, 5, 10 and 30 seconds. Ingestion into a nearby database lands in the
first few. So does a search for a value that matches a few journeys, which is
under a millisecond in the database at a million journeys; one matching tens of
thousands of journeys takes tens of milliseconds. Anything in seconds is worth
a look. A request that ran into the default 15-second statement timeout lands in
the 30-second bucket, apart from ordinary slow ones.

Every counter is per process and starts at zero when the API starts, so alert on
`increase()` or `rate()`, never on the raw value. The retention gauges are per
replica too: the replica that holds the lock sweeps, and the others count
`locked`.

`flight_recorder_unreadable_values` is set by the boot check a moment after the
API starts, and not afterwards. The check is skipped while migrations are
pending, so an API started before `migrate` ran (the `infrastructure/compose.yaml`
stack has no migrate service) has no such series at all until it is restarted
after migrating. Alert on its absence only if every API is started after
migrations, as `compose.published.yaml` and the Helm chart do.

### Alerts worth starting with

```yaml
groups:
  - name: flight-recorder
    rules:
      # Events refused. A new service with a mistyped environment shows up here
      # first, whatever the sending service does or does not report itself.
      - alert: FlightRecorderRejectingEvents
        expr: sum(increase(flight_recorder_events_total{result="rejected"}[15m])) > 0
        for: 15m

      # Retention has not completed anywhere for a day. Disk grows and data
      # outlives its retention window.
      - alert: FlightRecorderRetentionStalled
        expr: time() - max(flight_recorder_retention_last_success_timestamp_seconds) > 86400
        for: 2h

      # Queries are being cancelled, or requests are waiting for a connection.
      - alert: FlightRecorderDatabaseStrained
        expr: >
          sum(increase(flight_recorder_query_timeouts_total[10m])) > 0
          or max(flight_recorder_db_pool_connections{state="pending"}) > 0
        for: 10m
```

The gauge is 0 until a replica completes its first sweep, which runs an hour
after it starts and hourly after that. The `max` across replicas carries the
answer while some are young, and `for: 2h` keeps a restart of every replica at
once from firing it.

### Statement timeout

Every statement the API runs is cancelled after `DATABASE_STATEMENT_TIMEOUT_MS`
milliseconds, 15000 by default. That covers ingestion, search and the other
reads, so one slow query cannot hold a connection ingestion needs.

Deletions are the exception. Each retention batch, and each transaction of an
admin's journey deletion, erasure, or destination deletion, lifts the timeout
for itself with `SET LOCAL statement_timeout = 0`. They are bounded by batch
size and started by the system or an operator, a journey with many events
legitimately takes longer to cascade than a search should, and a retention batch
cancelled every hour would never let the sweep reach the next environment. On a
database with 1,000 expired journeys of 200 events each, one retention batch
took 2.4 seconds with migration 016's index and 9.5 seconds without it, beside
only 1,000 replay runs.

The request gets 503 `query_timeout` with its request
id; the API logs one warning naming the route and the request id, never the SQL
or its parameters, and counts it in `flight_recorder_query_timeouts_total`.

It is set on each connection when the pool opens it, with `SET statement_timeout`.
Behind PgBouncer in transaction pooling mode a session setting does not stay with
one client, so there set the timeout on the database role instead
(`ALTER ROLE flight_recorder SET statement_timeout = '15s'`) and
`DATABASE_STATEMENT_TIMEOUT_MS=0`.

`0` disables it, and `doctor` warns when it is. The database CLI never applies it:
`migrate` may build an index on a large table for a long time, and
`rotate:reencrypt` and the deletion commands bound each statement by batch size.

### Logs

The API writes JSON lines to standard output, at `LOG_LEVEL`
(`info` by default). At `info`, every request writes a line when it arrives and
one when it completes.

A request line carries the method, the path, and the names of its query
parameters with every value replaced by `[REDACTED]`:

```json
{ "req": { "method": "GET", "url": "/v1/search?q=[REDACTED]&limit=[REDACTED]" } }
```

A searched value is usually a customer identifier, and the Recent page's filters
name services and environments, so no query value is ever logged. A parameter
name that does not look like one (an email address pasted without `=`, or
anything longer than 64 characters) is replaced too, and so is anything after a
`;` in the path, where some clients put session ids. The path is logged whole,
so a journey id in `/v1/journeys/:journeyId` does appear. A request that matches
no route writes no line of its own beyond these two.

Headers are not logged. As a second guard, the logger censors `authorization`
and `cookie` in any `headers` object a log call includes, and also `x-api-key`,
`x-flight-api-key`, and a response's `set-cookie` under `req` and `res`.

A request too malformed for Node to parse never becomes a request line. At
`trace` it is logged as `client error`, with the parser's error code and message.
Node attaches the raw bytes it received to that error as `rawPacket`, headers
and query string included; no error the API logs ever carries that property.

One caveat remains: an error's own properties are logged, and a database error
can describe the row it refused, as PostgreSQL's `detail` does for a unique
violation. Those lines are at `warn` or `error`, for failures, and name columns
the API writes, not request headers.

Before this, the request line carried the full URL, so logs kept from an earlier
version hold searched identifiers and Recent filters in the clear. Treat them as
personal data, and let them age out or delete them.

## 14. When something is wrong

| Symptom | Look at |
| --- | --- |
| Not sure what is wrong | run `doctor` (§12) |
| `/ready` 503 `migrations_pending` | run `pnpm db:migrate` |
| Requests return 503 `query_timeout` | a statement ran past `DATABASE_STATEMENT_TIMEOUT_MS`: the route is in the API's warning log and `flight_recorder_query_timeouts_total`; check the database's load before raising the timeout (§13) |
| Every search returns nothing | which project the session selected — see `/projects` |
| A search that worked stops working | `rotate:status`: an unknown key id means `ENCRYPTION_KEY_PREVIOUS` was removed before re-encryption finished (§6) |
| Boot log warns of stored data the configured keys cannot read | restore the old key as `ENCRYPTION_KEY_PREVIOUS` and recreate the API (§6) |
| API exits at boot: `ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY` | set it to the key being replaced, not the new one |
| New keys changed nothing after `docker compose restart` | `restart` does not re-read `env_file`; recreate with `docker compose … up -d` |
| Replay blocked with `headers_key_not_configured` | the destination's headers are under a key that is not configured; restore it as `ENCRYPTION_KEY_PREVIOUS` and run `rotate:reencrypt` |
| `rotate:reencrypt` exits 1 saying the lock is held | another run is still going; let it finish, then `rotate:status` |
| `delete:range` exits 1 saying the retention lock is held | the retention sweep is running; run it again when that finishes |
| An audit row for a deletion says `complete: false` | the run stopped part way; run the same command again (§8) |
| SDK sends nothing | key validity, environment match, and the SDK's `onDiagnostic` counters |
| Ingestion returns 403 | the key's environment does not match the event's |
| Ingestion returns 401 after working | the key was revoked, which `pnpm key:list` shows, or it had not authenticated before `ENCRYPTION_KEY_PREVIOUS` was removed (§6) |

The SDK's `shutdown()` returns counters: `sent`, `rejected`, `dropped`,
`transportErrors`, `captureErrors`, and `breakerOpened`. `sent`, `rejected`, and
`dropped` add up to the events recorded; `payloadsOmitted` counts payloads
replaced by `[PAYLOAD_TOO_LARGE]` on events that were still sent. A non-zero `dropped` means events were
not delivered: the bounded queue shed them under backpressure, the server kept
refusing them for now past the retry budget, its reply gave no verdict for them,
or `shutdown()` finished with them undelivered. Each diagnostic's reason says
which (`packages/sdk-node/README.md`, "Is it sending?").
