# Operations

Running Flight Recorder for a team. It is deliberately small — one API, one web
application, one PostgreSQL database — so most of this is short.

## 1. What holds state

Everything is in PostgreSQL. There is no second datastore, no object storage, and
no external service (ADR-012). Back up the database and you have backed up
Flight Recorder.

The demo profile adds ElasticMQ, which holds nothing worth keeping.

## 2. Backup

The Compose stack keeps its data in the `postgres-data` volume.

```bash
docker compose -f infrastructure/compose.yaml exec -T postgres \
  pg_dump -U flight -d flight --format=custom > flight-$(date +%F).dump
```

Payload fields and entity identifiers are encrypted at rest with a key derived
from `ENCRYPTION_KEY`, which is **not** in the dump. A backup without that key
restores a database whose payloads cannot be read. Store the key separately, and
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

## 5. Key rotation

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

## 6. Retention

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

## 7. Exposure

Every published port binds to `127.0.0.1`. A `docker compose up` on a cloud host
does not expose the stack to the internet, and that is the only thing standing
between the default configuration and an open admin interface.

If you put Flight Recorder behind a reverse proxy, terminate TLS there and do not
republish the container ports on `0.0.0.0`.

The admin token grants project-wide read of every recorded payload. It is a
single shared secret with no user accounts and no audit of who used it — treat
it as an operator credential, not a login.

## 8. Sizing

Event volume drives everything. One journey is one row plus one row per event,
plus a row per alias. Payloads are stored inline as JSONB.

The practical lever is `captureMode`. `metadata-only` stores no payloads at all
and shrinks the table by roughly the size of your traffic; `redacted-payload`
(the default) stores both input and output per wrapped step.

Two indexes carry the read path: `journeys_entity_value_idx` for search and
`journeys_recent_idx` for retention selection.

## 9. When something is wrong

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
