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
installation shows blank identifiers.

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

**`ENCRYPTION_KEY` rotation is destructive.** Three things derive from it by
HKDF: field encryption, search tokens, and the API-key pepper. Rotating it:

- makes every already-encrypted payload and entity ID undecryptable,
- orphans every search token, so existing journeys stop being findable by
  identifier,
- invalidates every issued API key.

There is no re-encryption tool in V0. Rotate only when you are willing to lose
access to existing data, or when the installation is new.

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
| A search that worked stops working | was `ENCRYPTION_KEY` rotated? |
| SDK sends nothing | key validity, environment match, and the SDK's `onDiagnostic` counters |
| Ingestion returns 403 | the key's environment does not match the event's |
| Ingestion returns 401 after working | the key was revoked; `pnpm key:list` shows it |

The SDK's `shutdown()` returns counters — `dropped`, `transportErrors`,
`captureErrors`, `breakerOpened`, `sent`. A non-zero `dropped` means the bounded
queue shed events under backpressure, which is by design and worth knowing.
