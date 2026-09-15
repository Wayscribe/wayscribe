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
export DATABASE_URL=postgresql://user:password@db.internal:5432/flight_recorder
docker compose -f compose.published.yaml up -d
```

It needs an ordinary database and an ordinary role: `CREATE`, `SELECT`,
`INSERT`, `UPDATE`, `DELETE` on its own schema. It installs no extensions and
touches nothing outside the tables its migrations create, so an existing
database with other tables in it is fine.

`-f compose.bundled.yaml` runs PostgreSQL in a container instead and sets
`DATABASE_URL` for you. That is for evaluation and for local work. Nothing about
it is unsuitable for production except that it is invisible to whoever is
responsible for your data — no backup schedule, no monitoring, and a `docker
compose down -v` away from gone.

### Schema changes

The `migrate` service applies migrations on boot, against your database, and it
is the only thing that writes schema. If your team applies migrations through
its own process, leave that service out and run the same command when you
choose to:

```bash
docker compose -f compose.published.yaml run --rm --entrypoint node api \
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

## 5. Projects and keys

A new installation has no projects, and a key belongs to one. Create the project
first; the environment is created for you by `key:create`.

```bash
docker compose -f compose.published.yaml run --rm --entrypoint node api \
  packages/database/dist/cli.js project:create acme "Acme Payments"

docker compose -f compose.published.yaml run --rm --entrypoint node api \
  packages/database/dist/cli.js key:create acme production checkout-worker
```

`project:list`, `key:list`, and `key:revoke` do what they say. A key is printed
once and is not recoverable — issue another rather than hunting for it.

A slug is lowercase letters, digits and hyphens, because it reaches project
selection, the CLI, and the interface. It cannot be changed afterwards without
touching everywhere an operator has written it down.

## 6. Key rotation

**Changing `ENCRYPTION_KEY` outright loses access to what is already stored.**
Three things derive from it by HKDF: field encryption, search tokens, and the
API-key pepper. Swap the value and restart, and every stored entity identifier,
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
# Published images
docker compose -f compose.published.yaml run --rm --entrypoint node api \
  packages/database/dist/cli.js rotate:status

# infrastructure/compose.yaml, which reads .env for the one-off container too
docker compose -f infrastructure/compose.yaml run --rm --entrypoint node api \
  packages/database/dist/cli.js rotate:status

# A source checkout
pnpm rotate:status
```

Replace `rotate:status` with `rotate:reencrypt` for the other command. On Helm,
add `ENCRYPTION_KEY_PREVIOUS` to the `kubectl run` that `deploy/helm/README.md`
uses for `project:create`. `key:create` and `key:revoke` during a rotation need
both keys as well, so a key issued mid-rotation verifies against the API beside
it.

### The procedure

1. Generate the new key: `openssl rand -hex 32`. Keep the old one. It is the
   only way back if something goes wrong, and a backup taken before the rotation
   needs it (see below).
2. Where your stack reads its keys (above), set `ENCRYPTION_KEY` to the new key
   and `ENCRYPTION_KEY_PREVIOUS` to the old one.
3. Recreate every API container with the new keys: `docker compose -f
   infrastructure/compose.yaml up -d` (or `-f compose.published.yaml`), or
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

A script can wait on step 5, since the exit code is the answer:

```bash
until pnpm rotate:status > /dev/null; do sleep 300; done
```

### What `rotate:status` lists

- **API keys not yet under the current key.** Each moves the next time it
  authenticates, because the presented key is the only thing a verifier can be
  recomputed from. Wait for the services holding them to send events. A key that
  will not be used again should be revoked with `key:revoke`, and reissued with
  `key:create` if something still needs one. Revoked keys are not counted.
- **API keys whose key id is `not recorded`.** Issued before key ids were
  stored. They record one the next time they authenticate. During a rotation
  they may be under either key, so they are treated like the keys above and keep
  the exit code at 1. With no previous key configured they are listed as `key id
  not recorded yet; recorded on next use` and do not affect the exit code: they
  can only be under the one key there is.
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

**A server `idle_in_transaction_session_timeout` shorter than the run drops the
lock**, because the connection holding it sits in an idle transaction. The data
stays safe, since every rewrite is conditional, but a second run could then
start beside the first. If PostgreSQL logs that it terminated a connection for
that timeout during a run, let the run finish and start it again. Check the
setting first with `SHOW idle_in_transaction_session_timeout;`.

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
pnpm key:revoke fr_theOldOne
```

## 7. Retention

Each environment has its own `retention_days`. A sweep runs hourly inside the
API process, guarded by a PostgreSQL advisory lock so replicas do not delete
concurrently (ADR-026), and deletes in bounded batches.

Deleting a journey removes its events, aliases, and replay runs by cascade.

Retention stops while the API is down and resumes on the next start. There is no
metrics endpoint; each sweep that deleted anything writes one line:

```json
{ "journeysDeleted": 1420, "batches": 2, "environmentsExamined": 3, "durationMs": 91 }
```

`DEFAULT_RETENTION_DAYS` applies to environments created by `db:seed` and
`key:create`. Changing it does not alter environments that already exist —
update `environments.retention_days` for those.

## 8. Exposure

Every published port binds to `127.0.0.1`. A `docker compose up` on a cloud host
does not expose the stack to the internet, and that is the only thing standing
between the default configuration and an open admin interface.

If you put Flight Recorder behind a reverse proxy, terminate TLS there and do not
republish the container ports on `0.0.0.0`.

The admin token grants project-wide read of every recorded payload. It is a
single shared secret with no user accounts and no audit of who used it — treat
it as an operator credential, not a login.

## 9. Sizing

Event volume drives everything. One journey is one row plus one row per event,
plus a row per alias. Payloads are stored inline as JSONB.

The practical lever is `captureMode`. `metadata-only` stores no payloads at all
and shrinks the table by roughly the size of your traffic; `redacted-payload`
(the default) stores both input and output per wrapped step.

Two indexes carry the read path: `journeys_entity_value_idx` for search and
`journeys_recent_idx` for retention selection.

## 10. Security scanning

Three jobs run in the `security` stage, and all three block.

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

## 11. When something is wrong

| Symptom | Look at |
| --- | --- |
| `/ready` 503 `migrations_pending` | run `pnpm db:migrate` |
| Every search returns nothing | which project the session selected — see `/projects` |
| A search that worked stops working | `rotate:status`: an unknown key id means `ENCRYPTION_KEY_PREVIOUS` was removed before re-encryption finished (§6) |
| Boot log warns of stored data the configured keys cannot read | restore the old key as `ENCRYPTION_KEY_PREVIOUS` and recreate the API (§6) |
| API exits at boot: `ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY` | set it to the key being replaced, not the new one |
| New keys changed nothing after `docker compose restart` | `restart` does not re-read `env_file`; recreate with `docker compose … up -d` |
| Replay blocked with `headers_key_not_configured` | the destination's headers are under a key that is not configured; restore it as `ENCRYPTION_KEY_PREVIOUS` and run `rotate:reencrypt` |
| `rotate:reencrypt` exits 1 saying the lock is held | another run is still going; let it finish, then `rotate:status` |
| SDK sends nothing | key validity, environment match, and the SDK's `onDiagnostic` counters |
| Ingestion returns 403 | the key's environment does not match the event's |
| Ingestion returns 401 after working | the key was revoked, which `pnpm key:list` shows, or it had not authenticated before `ENCRYPTION_KEY_PREVIOUS` was removed (§6) |

The SDK's `shutdown()` returns counters — `dropped`, `transportErrors`,
`captureErrors`, `breakerOpened`, `sent`. A non-zero `dropped` means the bounded
queue shed events under backpressure, which is by design and worth knowing.
