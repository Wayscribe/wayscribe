# Running Flight Recorder on a local cluster

A Helm chart for **a local single-node cluster**: kind, k3s, or Docker Desktop.
It has been installed, upgraded and used on kind; it has **not** been run on a
managed cluster, and this file will say so until it has (ADR-042).

Nothing here needs anything published. The chart pulls from whatever registry you
point it at, including images you build and load yourself.

## Try it

```bash
kind create cluster --name flight-recorder

docker compose -f infrastructure/compose.yaml build api web
docker tag flight-recorder-api:latest flight-recorder/api:local
docker tag flight-recorder-web:latest flight-recorder/web:local
kind load docker-image flight-recorder/api:local flight-recorder/web:local --name flight-recorder

helm install fr deploy/helm/flight-recorder -f deploy/helm/values-local.yaml \
  --set secrets.encryptionKey=$(openssl rand -hex 32) \
  --set secrets.adminToken=$(openssl rand -hex 32)

kubectl port-forward svc/fr-flight-recorder-web 3000:3000
```

Then open `http://localhost:3000` and sign in with the admin token you generated.

A new installation has no projects. Create one, and issue it a key:

```bash
kubectl run frcli --rm -i --restart=Never \
  --image=flight-recorder/api:local --image-pull-policy=Never \
  --env="DATABASE_URL=postgresql://flight:flight@fr-flight-recorder-postgresql:5432/flight" \
  --env="ENCRYPTION_KEY=$(kubectl get secret fr-flight-recorder-secrets -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d)" \
  --command -- node packages/database/dist/cli.js project:create acme "Acme Payments"
```

## Your own database

`values-local.yaml` turns on an in-cluster PostgreSQL, which is for evaluation.
A real installation points at the database your team already runs, the one that
is backed up and monitored (ADR-037). It needs PostgreSQL 15 or later and a role
with privileges on its own schema; `docs/OPERATIONS.md` §1 lists them:

```bash
helm install fr deploy/helm/flight-recorder \
  --set databaseUrl=postgresql://user:password@db.internal:5432/flight_recorder \
  --set secrets.encryptionKey=… --set secrets.adminToken=…
```

The chart refuses to render without a database rather than defaulting to one,
because a default here would write your payloads somewhere you did not choose.

If you manage secrets yourself, `secrets.existingSecret` takes the name of a
secret carrying `DATABASE_URL`, `ENCRYPTION_KEY` and `ADMIN_TOKEN`, and the
chart creates none of its own. During a key rotation the secret also carries
`ENCRYPTION_KEY_PREVIOUS`. The API pods do not restart when a secret changes, so
restart them yourself; the procedure is in `docs/OPERATIONS.md` §6.

## What is in it

| Resource | Notes |
| --- | --- |
| `api` Deployment + Service | readiness on `/ready`, which reports `migrations_pending` until schema is applied |
| `web` Deployment + Service | readiness on `/login` |
| `migrate` Job | a `post-install,post-upgrade` hook; see below |
| `Secret` | unless you bring your own |
| `postgresql` StatefulSet | only when `postgresql.enabled` |
| `Ingress` | only when `ingress.enabled`; off by default |
| `NetworkPolicy` per pod | only when `networkPolicy.enabled`; off by default |

`api.metricsPort` turns on the metrics listener and adds a container port named
`metrics`. Neither Service nor ingress carries it, so it is reachable only by
something that scrapes the pods; `api.databaseStatementTimeoutMs` sets the
statement timeout (`docs/OPERATIONS.md` §13).

Values are named after the environment variables they set, so the mapping to
`infrastructure/compose.published.yaml` is mechanical. Two deployment shapes now
exist and a variable added to one has to reach the other.

## Pod security

Every pod runs as a non-root user with `seccompProfile: RuntimeDefault`, no
privilege escalation, every capability dropped, and a read-only root filesystem.
The API, web and migrate pods run as the images' `node` user (uid and gid
1000); the bundled PostgreSQL runs as the postgres image's own user (uid and
gid 70), with `fsGroup` making its volume writable, since started that way its
entrypoint does not chown anything.

Writable paths are emptyDirs: `/tmp` in every pod, `.next/cache` in the web
pod, and the socket directory `/var/run/postgresql` in PostgreSQL. The API and
web images were started with `docker run --read-only`, no capabilities and no
new privileges, and served ingestion, the journey page and sign-in; they also
started with no writable mount at all, so the emptyDirs are for what Node and
Next.js may write rather than something observed. PostgreSQL initialised its
data directory and accepted connections the same way. The chart was then
installed on kind with these settings and the NetworkPolicies below, and
recorded and displayed an event.

Override `podSecurityContext`, `containerSecurityContext`, or the same two
under `postgresql`, if your images run as a different user.

## Network policies

`networkPolicy.enabled` (off by default) adds a NetworkPolicy per pod. A policy
is enforced only by a CNI that supports them; kind's default does.

| Pod | Ingress | Egress |
| --- | --- | --- |
| api | port 8080 from `networkPolicy.ingressFrom` plus the web pod (everything when `ingressFrom` is empty), and the metrics port when set | DNS, the database, `networkPolicy.apiExtraEgress` |
| web | port 3000 from `networkPolicy.ingressFrom` | DNS, the API on 8080 |
| migrate | none | DNS, the database |
| postgresql | 5432 from the api and migrate pods | none |

The database is the bundled PostgreSQL pod when `postgresql.enabled`, and
otherwise port `networkPolicy.database.port` (5432) to `networkPolicy.database.to`,
or to anywhere when that is empty.

Two things the policies change:

- **Replay.** The API sends replays to the hosts in `api.replayAllowedHosts`.
  Add those destinations to `networkPolicy.apiExtraEgress`, or replays fail to
  connect.
- **Running the CLI in the cluster.** With the bundled database, a pod without
  the chart's labels cannot reach PostgreSQL, so the `kubectl run` above times
  out. Give it the migrate pod's labels:
  `--labels=app.kubernetes.io/name=flight-recorder,app.kubernetes.io/instance=fr,app.kubernetes.io/component=migrate`.

## Why migrations run *after* install

This is the non-obvious part, and it was arrived at by watching the chart fail.

A `pre-install` hook runs before **every** regular resource in the release. The
migrate Job therefore could not see the Secret holding `DATABASE_URL` (the pod
sat in `CreateContainerConfigError`), and with `postgresql.enabled` there was no
database to migrate either. `helm lint` and `helm template` both passed. The
chart rendered perfectly and did not run.

Ordering is enforced by the application instead, which is a better place for it:
`/ready` returns 503 `migrations_pending` until the schema is applied, so new
pods stay out of service until the Job finishes, and during an upgrade the
previous pods keep serving.

The Job retries the migration itself rather than probing the database first: up
to 30 attempts, 2 seconds apart, while the error reads as a connection failure,
and once more for any other failure (`templates/migrate-job.yaml`). The whole
Job stops after `migrations.activeDeadlineSeconds`, 1800 by default. A probe
answers a different question than the operation does.

## Not yet

- **Managed clusters.** Ingress, TLS, storage classes and pull secrets all exist
  as values and are untested. They are options, not claims.
- **More than one replica.** `web` derives its session signing key from
  `ADMIN_TOKEN` so it scales, but the login rate limiter is per-process, so N
  replicas means N times the allowed attempts.
- **Resource requests and limits.** Empty by default. A local cluster does not
  need them and a real one should not inherit my guesses.
