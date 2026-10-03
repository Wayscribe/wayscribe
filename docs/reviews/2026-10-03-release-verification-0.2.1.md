# Wayscribe 0.2.1 release verification

Date: 2026-10-03

Every statement below was observed in this exercise unless it is marked "not
verified".

Wayscribe 0.2.1 is published from annotated tag `v0.2.1` (tag object
`a54c1563632400a0899d0fdbaad84aea2f1de0ec`) at commit
[`46d03a436931d9cc768db6d0eb1bc117d69c8aa4`](https://gitlab.com/jojithedev/wayscribe/-/commit/46d03a436931d9cc768db6d0eb1bc117d69c8aa4).
The [GitHub mirror release](https://github.com/Wayscribe/wayscribe/releases/tag/v0.2.1)
exists and its tag is the same tag object. The GitLab release for `v0.2.1` was
created after this check, with the four SBOM files and `SHA256SUMS` uploaded
from the `publish-images` job artifacts compared below. Whether the tag is
protected was not verified from outside.

## Release pipeline

The protected-tag
[release pipeline](https://gitlab.com/jojithedev/wayscribe/-/pipelines/2887656416)
(ref `v0.2.1`, commit `46d03a4`, source `push`) has status `success`: 29 jobs
succeeded and 2 manual jobs (`demo`, `e2e`) were not run. The succeeded jobs
include `unit`, `release-verify`, `upgrade-test`, `sdk-node: [22.12.0]`,
`sdk-node: [24]`, `sdk-python: [3.11]`, `sdk-python: [3.14]`,
`sdk-go: [1.22.0]`, `sdk-go: [1.26.4]`, `database: [15]`, `database: [17]`,
`database: [18]`, `sbom`, `container-scan`,
[`publish-images`](https://gitlab.com/jojithedev/wayscribe/-/jobs/16767120704),
[`publish-sdk`](https://gitlab.com/jojithedev/wayscribe/-/jobs/16767120705),
`github-release` and `mirror-to-github`.

```bash
curl -s https://gitlab.com/api/v4/projects/jojithedev%2Fwayscribe/pipelines/2887656416
curl -s "https://gitlab.com/api/v4/projects/jojithedev%2Fwayscribe/pipelines/2887656416/jobs?per_page=100"
git ls-remote https://gitlab.com/jojithedev/wayscribe.git 'refs/tags/v0.2.1*'
```

Not verified: test counts per job, and the candidate main pipeline that
preceded the tag. Job logs were not read.

## npm package

[`@wayscribe/node@0.2.1`](https://www.npmjs.com/package/@wayscribe/node/v/0.2.1)
is public and `latest` resolves to it. Its npm integrity is
`sha512-TqIgrlBPYDkHE0EH8YXq+Di7Sb7oieTn7gVFl/xAJlA55j5Jlo2CfZaQhbgEcsJ4BgJ7qHyNHnqFEpM0sIJV9Q==`.

```bash
docker run --rm -v "$PWD/node24:/w" -w /w node:24 sh -c \
  'npm init -y && npm install @wayscribe/node@0.2.1 && npm audit signatures'
docker run --rm -v "$PWD/node22:/w" -w /w node:22.12 sh -c \
  'npm init -y && npm install @wayscribe/node@0.2.1 && npm audit signatures'
```

On Node 24.21.0 (npm 11.19.0) and Node 22.12.0 (npm 10.9.0), `npm audit
signatures` reported one verified registry signature and one verified
attestation. The SLSA v0.2 provenance from
`https://registry.npmjs.org/-/npm/v1/attestations/@wayscribe%2fnode@0.2.1`
names:

- config source and material commit `46d03a436931d9cc768db6d0eb1bc117d69c8aa4`;
- repository `git+https://gitlab.com/jojithedev/wayscribe`;
- entry point `publish-sdk`;
- builder `https://gitlab.com/jojithedev/wayscribe/-/runners/54907241`.

The provenance statement is in Sigstore's
[transparency log](https://search.sigstore.dev/?logIndex=2982429530) and the
publish attestation at
[log index 2982469706](https://search.sigstore.dev/?logIndex=2982469706).

Each Node version then recorded a journey against the local stack, following
the SDK README's `createRecorder`, `startJourney`, `record`, `finish` and
`shutdown` usage with `endpoint: "http://api:8080"` on the Compose network.
Both runs reported `recorded: 2, sent: 2`, with nothing rejected or dropped
and no transport or capture errors. `GET /v1/search` found the journey, and
`GET /v1/events/:id` returned the sent input and `runtimeMetadata.sdk` of
`@wayscribe/node` `0.2.1`, commit `46d03a4`. Only the ESM import was exercised;
CommonJS was not verified.

The local `node:24` image on this host was linux/amd64 and ran under
emulation; `node:22.12` was linux/arm64.

## Python package

[`wayscribe==0.2.1`](https://pypi.org/project/wayscribe/0.2.1/) is on PyPI with
a wheel (`a914ad2043903e701e58699e723dc06b036b14a56e654617bd7861bafcb683d6`)
and an sdist (`673660eb741bb079b7ff1a9ba193438b2327e1e0fad9599c71da532bab6e0960`).
The wheel's PyPI provenance names publisher kind `GitLab`, repository
`jojithedev/wayscribe`, workflow `.gitlab-ci.yml`, environment `pypi`. The
provenance bundle was read but its signature was not independently verified.

```bash
docker run --rm python:3.11-slim pip install --no-cache-dir wayscribe==0.2.1
curl -s https://pypi.org/integrity/wayscribe/0.2.1/wayscribe-0.2.1-py3-none-any.whl/provenance
```

In `python:3.11-slim` (Python 3.11.16) the README's `create_recorder` context
manager recorded a three-event journey (`transform`, `record`, `complete`)
against `http://api:8080`: `recorded: 3, sent: 3`, nothing rejected or dropped.
The readback returned the input and `runtimeMetadata.sdk` of `wayscribe`
`0.2.1`.

## Go module

```bash
docker run --rm -e GOFLAGS=-mod=mod golang:latest sh -c \
  'go mod init x && go get wayscribe.dev/go@v0.2.1'
```

With Go 1.27.1, default `GOPROXY=https://proxy.golang.org,direct` and
`GOSUMDB=sum.golang.org`, `go get` added `wayscribe.dev/go v0.2.1`:

```text
wayscribe.dev/go v0.2.1 h1:TxFrLUAr/wcdlXC5Jl4nXkiqghnuXNPHEncxig9YpoI=
wayscribe.dev/go v0.2.1/go.mod h1:bJNUMlnMLomEkhbTo2adoDZ5NyGdWbFXqasEQm++dU8=
```

The module proxy reports origin
`refs/tags/packages/sdk-go/v0.2.1`, subdirectory `packages/sdk-go`, hash
`46d03a436931d9cc768db6d0eb1bc117d69c8aa4`, and `@latest` is `v0.2.1`. A
program using `wayscribe.New`, `Journey`, `Record`, `Complete` and `Shutdown`
recorded two events: `Recorded:2 Sent:2`, nothing rejected or dropped. The
readback returned the input and `runtimeMetadata.sdk` of `wayscribe.dev/go`
`0.2.1`.

## Images, signatures and SBOMs

Anonymous registry access succeeded. `latest` matched each `v0.2.1` index at
verification time.

| Image | Multi-platform index digest |
| --- | --- |
| `registry.gitlab.com/jojithedev/wayscribe/api:v0.2.1` | `sha256:5492479a864873a3a0bef1b5610d3c5608001e2b5f211d189939cfdf64f1831a` |
| `registry.gitlab.com/jojithedev/wayscribe/web:v0.2.1` | `sha256:f0b9803a87af302b8de619d31dbc3a31b4b594b520ae8acf465995b58e320e3f` |

Each index also lists two BuildKit `attestation-manifest` entries.

Cosign `v2.6.5` (commit `3e82f50a2839855693aacf7b3d0e7e2f30774cb4`), run from
`gcr.io/projectsigstore/cosign:v2.6.5`
(`sha256:ad281047f85c5e1fc6ffbc30c2b55be3b07b4032bef715a12122ce5829619aca`):

```bash
ID='https://gitlab.com/jojithedev/wayscribe//.gitlab-ci.yml@refs/tags/v0.2.1'
docker buildx imagetools inspect registry.gitlab.com/jojithedev/wayscribe/api:v0.2.1 --format '{{json .Manifest}}'
docker run --rm gcr.io/projectsigstore/cosign:v2.6.5 verify \
  --certificate-oidc-issuer https://gitlab.com --certificate-identity "$ID" \
  registry.gitlab.com/jojithedev/wayscribe/api@$DIGEST
docker run --rm gcr.io/projectsigstore/cosign:v2.6.5 verify-attestation --type cyclonedx \
  --certificate-oidc-issuer https://gitlab.com --certificate-identity "$ID" \
  registry.gitlab.com/jojithedev/wayscribe/api@$DIGEST
```

`cosign verify` with the exact identity passed for both indexes and all four
platform manifests; each platform manifest carries a `cosign/sign/v1`
signature alongside its CycloneDX attestation. The OPERATIONS regexp form
passed on both `v0.2.1` tags. As a negative control, the `v0.2.0` identity
failed against the API index.

`cosign verify-attestation --type cyclonedx` passed on all four platform
manifests and failed on both indexes with "none of the attestations matched
the predicate type". That is the documented design: an SBOM is attached to
each platform manifest, not to the multi-platform tag
([Operations](../OPERATIONS.md)).

Each attestation predicate, decoded from the DSSE payload, equals the matching
`publish-images` job artifact under a canonical JSON compare (sorted keys), and
the artifact files match their `SHA256SUMS`. Each statement's subject is the
platform manifest digest.

| Image | Platform | Manifest digest | SBOM | SBOM SHA-256 | Components | Predicate equals artifact |
| --- | --- | --- | --- | --- | ---: | --- |
| API | linux/amd64 | `sha256:273bfec397a2cb374b184bb1006f16246eb6fc2c89523cf733cef018aaa1a914` | `api-v0.2.1-linux-amd64.cdx.json` | `521707e51ab4c4997b2edbe1c3f4cf346397674f13b8921f9b364d0fea18f4e2` | 348 | yes |
| API | linux/arm64 | `sha256:cef1b178e523fde9ad3ea3c6feb40faf700d350447407c995d8fb1827a11a047` | `api-v0.2.1-linux-arm64.cdx.json` | `a793543b3a079ecdc050aca61ea4d7374b8da2385d97f06bbfba9c1a424c369a` | 347 | yes |
| Web | linux/amd64 | `sha256:2e28dab5e3a847d8278e637ad65c8a45d3f75d52217eb25b34101b40b2c5cd3d` | `web-v0.2.1-linux-amd64.cdx.json` | `a88cc765dcc2676560ba793d2fc4a27145a2595c100fae6ca21a18242ff2466b` | 368 | yes |
| Web | linux/arm64 | `sha256:e20fcfe2b2e8465e5325439df99864f6860713ef17f575b54b40ac5e59f9a45a` | `web-v0.2.1-linux-arm64.cdx.json` | `9dfffd2d7c983252ddc7d329d247fbb53cc0fe98f0aa57b95cdd0b65db8c0124` | 367 | yes |

The SBOMs are CycloneDX 1.6. No GitLab release downloads existed for 0.2.1 at
verification time, so the downloadable copies the 0.1.0 record compared could
not be compared here.

## Installation from public artifacts

The installation ran in a new directory holding only files downloaded from the
tag, on Docker 29.4.1 with Compose v5.1.3, following the README section
[Install 0.2.1 without a checkout](https://gitlab.com/jojithedev/wayscribe/-/blob/v0.2.1/README.md#install-021-without-a-checkout):

```bash
curl -O https://gitlab.com/jojithedev/wayscribe/-/raw/v0.2.1/infrastructure/compose.published.yaml
export COMPOSE_FILE=compose.published.yaml
export WAYSCRIBE_VERSION=v0.2.1
export DATABASE_URL=postgresql://user:password@db.internal:5432/wayscribe
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose up -d
curl -O https://gitlab.com/jojithedev/wayscribe/-/raw/v0.2.1/infrastructure/compose.bundled.yaml
export COMPOSE_FILE=compose.published.yaml:compose.bundled.yaml
docker compose up -d
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js project:create acme "Acme Payments"
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js key:create acme production checkout-worker
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js doctor --api-url http://api:8080 --api-key "$KEY"
```

The first `docker compose up -d`, run literally with the placeholder
`DATABASE_URL`, exited 1 because `migrate` could not resolve `db.internal`.
That is the expected result for a placeholder; the README presents the
bundled overlay as the way to try it without a database. With the overlay the
stack came up with no other change: `migrate` exited 0, the API was healthy,
and the web answered. The exported placeholder `DATABASE_URL` was harmless,
because the overlay sets `DATABASE_URL` on `migrate` and `api` directly.

The running containers used the signed index digests:
`api` `sha256:5492479a864873a3a0bef1b5610d3c5608001e2b5f211d189939cfdf64f1831a`
and `web` `sha256:f0b9803a87af302b8de619d31dbc3a31b4b594b520ae8acf465995b58e320e3f`
(`docker inspect`, containerd image store). `GET /ready` reported
`{"status":"ready","version":"v0.2.1","commit":"46d03a436931d9cc768db6d0eb1bc117d69c8aa4","source":"build"}`,
and the API container's `WAYSCRIBE_BUILD_VERSION` and `WAYSCRIBE_BUILD_COMMIT`
match. Project and key creation succeeded, and `doctor` reported
`0 failed, 0 warnings, 12 passed` against PostgreSQL 17.11.

SDK containers reached the API through the Compose network
`wayscribe_default` at `http://api:8080`, a single-label name the SDKs do not
report as an insecure endpoint. Readback used `http://127.0.0.1:8080` from the
host with `Authorization: Bearer <key>`.

## OTLP warning

[OTLP_LOGS.md](../OTLP_LOGS.md) says the published Compose file exposes
`OTLP_LOGS_ENABLED`. Before enabling it, `POST /v1/logs` answered 404. It was
enabled with:

```bash
export OTLP_LOGS_ENABLED=true
docker compose up -d   # recreated only the api container
```

One OTLP JSON record, shaped after
[`examples/otlp-json/export.json`](https://gitlab.com/jojithedev/wayscribe/-/raw/v0.2.1/examples/otlp-json/export.json),
carried `wayscribe.input` with `gatewayApiToken`, `cardNumber` and `amount`:

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/logs \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  --data-binary @otlp-secret-names.json
```

The answer was HTTP 200 with
`{"partialSuccess":{"rejectedLogRecords":"0","errorMessage":"Warning: stored unredacted under secret-looking names: wayscribe.input.gatewayApiToken. If these hold secrets, add the names to this environment's redaction paths or redact them in a Collector."}}`.
The warning names the path and neither value. Reading
`GET /v1/events/evt_otlp_verify_021` back showed `cardNumber` as `[REDACTED]`
and `gatewayApiToken` stored as sent, as ADR-055 and ADR-068 describe. Neither
test value appeared in the API container's logs.

## Limits of this evidence

- The stack ran the linux/arm64 images on an existing macOS Docker host. The
  linux/amd64 manifests, signatures and SBOM attestations were verified, but
  those images were not run.
- The SBOM comparison used the `publish-images` job artifacts. The same files
  were then uploaded to the `wayscribe-release-sboms` package for `v0.2.1`, and
  the uploaded `SHA256SUMS` has the same SHA-256 as the compared one
  (`333fbc52d5884c126e5a392f85754ad4d997bf5f4968302cc31718a48839ba2d`).
- The Node runs used ESM only. The PyPI provenance was read, not
  cryptographically verified. Go module authenticity rests on `sum.golang.org`
  through `go get`. A separate `sum.golang.org` lookup returned the same
  `h1:TxFrLUAr/wcdlXC5Jl4nXkiqghnuXNPHEncxig9YpoI=`, and proxy.golang.org
  reports origin commit `46d03a4` for `v0.2.1`.
- Pipeline job logs and test counts were not read; only job statuses were.
- The exercise was run by an AI agent on the maintainer's machine, following
  the README. It is not a clean-machine result or an unaided human onboarding
  trial, and it was not timed.
