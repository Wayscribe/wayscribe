# Wayscribe 0.2.2 release verification

Date: 2026-10-03

Every statement below was observed in this exercise unless it is marked "not
verified". 0.2.2 changes dependency versions (fastify, fast-uri) and docs
relative to 0.2.1; the full 0.2.1 record is
[2026-10-03-release-verification-0.2.1.md](2026-10-03-release-verification-0.2.1.md).

Wayscribe 0.2.2 is published from annotated tag `v0.2.2` (tag object
`0fe9668db9b4ef22ad6699dd013a97e8daca3d15`) at commit
[`8f71e16e5a5490a488531d82409291703209b40e`](https://gitlab.com/jojithedev/wayscribe/-/commit/8f71e16e5a5490a488531d82409291703209b40e).
The [GitHub mirror release](https://github.com/Wayscribe/wayscribe/releases/tag/v0.2.2)
answered 200. The GitLab release for `v0.2.2` was created after this check,
with the four SBOM files and `SHA256SUMS` uploaded from the `publish-images`
job artifacts compared below.

```bash
git ls-remote https://gitlab.com/jojithedev/wayscribe.git 'refs/tags/v0.2.2*'
curl -s https://gitlab.com/api/v4/projects/jojithedev%2Fwayscribe/releases/v0.2.2
```

Not verified: the release pipeline, its job statuses and logs.

## Installation from public artifacts

The installation ran in a new directory holding only files downloaded from the
tag, on Docker 29.4.1 with Compose v5.1.3, following the README section
[Install 0.2.2 without a checkout](https://gitlab.com/jojithedev/wayscribe/-/blob/v0.2.2/README.md#install-022-without-a-checkout)
and choosing the bundled database:

```bash
curl -O https://gitlab.com/jojithedev/wayscribe/-/raw/v0.2.2/infrastructure/compose.published.yaml
export COMPOSE_FILE=compose.published.yaml
export WAYSCRIBE_VERSION=v0.2.2
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export ADMIN_TOKEN=$(openssl rand -hex 32)
curl -O https://gitlab.com/jojithedev/wayscribe/-/raw/v0.2.2/infrastructure/compose.bundled.yaml
export COMPOSE_FILE=compose.published.yaml:compose.bundled.yaml
docker compose up -d
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js project:create acme "Acme Payments"
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js key:create acme production checkout-worker
docker compose run --rm --entrypoint node api \
  packages/database/dist/cli.js doctor --api-url http://api:8080 --api-key "$KEY"
```

The 0.2.1 cold read ran the placeholder `DATABASE_URL` before the overlay. At
`v0.2.2` the section separates the two choices: the secrets block no longer
exports `DATABASE_URL`, and "bring your own" and "bundled overlay" are
alternative blocks. Followed literally with the overlay, every step succeeded
on the first attempt with no change: `migrate` exited 0, the API became
healthy, and `GET /` on port 3000 answered 307. No step
failed or confused.

The running containers used the expected index digests (`docker inspect`):
`api` `sha256:048fedeefd15b7ed8ac77b5db9763e6c48ec9ee18652b87935aa6e421d295167`,
`web` `sha256:aa8fd80d07392d06121de0c3912bd9fb253ab272a8a07257e78f1b18f3cdcba5`.
`GET /ready` reported
`{"status":"ready","version":"v0.2.2","commit":"8f71e16e5a5490a488531d82409291703209b40e","source":"build"}`,
and the API container's `WAYSCRIBE_BUILD_VERSION` and `WAYSCRIBE_BUILD_COMMIT`
match. `doctor` reported `0 failed, 0 warnings, 12 passed` against PostgreSQL
17.11 and exited 0.

### Dependency versions in the API image

```bash
docker run --rm --entrypoint node -w /app/apps/api \
  registry.gitlab.com/jojithedev/wayscribe/api:v0.2.2 \
  -e "console.log(require('fastify/package.json').version, require.resolve('fastify/package.json'))"
```

This printed `5.12.5` from
`/app/node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/package.json`. A
`find` over the image found exactly one fastify (`5.12.5`) and two fast-uri
copies (`4.2.1` and `3.1.8`), on Node v24.21.0. Both API SBOM predicates list
the same three components.

SDK containers reached the API on the Compose network `wayscribe_default` at
`http://api:8080`. Readback used `http://127.0.0.1:8080` from the host with
`Authorization: Bearer <key>`: `GET /v1/search?q=<entity id>`, then
`GET /v1/journeys/:id/events`, then `GET /v1/events/:id`.

## npm package

[`@wayscribe/node@0.2.2`](https://www.npmjs.com/package/@wayscribe/node/v/0.2.2)
is public and `latest` resolves to it. Its npm integrity is
`sha512-ae1Xq09PKvQll0Ux1zncy/X4SGJ0hlV9jpJJIK3PEfx7ePGC6P1zmYRT+5UKymKhDZqh9dzZXVRDOYwv0yN3Qw==`.

```bash
docker run --rm --network wayscribe_default -e WAYSCRIBE_API_KEY -v "$PWD/node22:/w" -w /w node:22.12 sh -c \
  'npm init -y && npm install @wayscribe/node@0.2.2 && npm audit signatures && node run.mjs'
```

On Node 22.12.0 (npm 10.9.0, linux/arm64), `npm audit signatures` reported one
verified registry signature and one verified attestation. `run.mjs` is the
root README's "Instrument your own service" example verbatim, with stubs for
`account`, `toCustomer` and `db`, `endpoint: "http://api:8080"`,
`environment: "production"`, and a final `console.log(recorder.counters())`.
It printed `delivered_first: Connected to http://api:8080; the server accepted
3 events.` and counters `recorded: 3, sent: 3` with nothing rejected or
dropped and no transport, capture or configuration errors. Search by the
entity id and by the alias `internalCustomerId` each found the journey.
Readback returned three events (`transformed map-account`,
`persisted save-customer`, `identified identify`) with the sent inputs and
`runtimeMetadata.sdk` of `@wayscribe/node` `0.2.2`, commit `8f71e16`.

Not verified: the npm provenance statement contents, CommonJS import, Node 24.

## Go module

```bash
docker run --rm --network wayscribe_default -e GOFLAGS=-mod=mod -e WAYSCRIBE_API_KEY \
  -v "$PWD/go:/src" -w /src golang:latest sh -c \
  'go mod init x && go get wayscribe.dev/go@v0.2.2 && go run .'
curl -s https://sum.golang.org/lookup/wayscribe.dev/go@v0.2.2
curl -s https://proxy.golang.org/wayscribe.dev/go/@v/v0.2.2.info
```

With Go 1.27.1 (linux/arm64), default `GOPROXY=https://proxy.golang.org,direct`
and `GOSUMDB=sum.golang.org`, `go get` added `wayscribe.dev/go v0.2.2`:

```text
wayscribe.dev/go v0.2.2 h1:VREdvjLgd9fgFzEI/SKN42Yl2VseU523rk3x/QJ8l/M=
wayscribe.dev/go v0.2.2/go.mod h1:bJNUMlnMLomEkhbTo2adoDZ5NyGdWbFXqasEQm++dU8=
```

The separate `sum.golang.org` lookup returned the same two lines. The proxy
reports origin `refs/tags/packages/sdk-go/v0.2.2`, subdirectory
`packages/sdk-go`, hash `8f71e16e5a5490a488531d82409291703209b40e`, and
`@latest` is `v0.2.2`. A program after the Go README's `wayscribe.New`,
`Journey`, `Record`, `Complete` and `Shutdown` usage printed
`Recorded:2 Sent:2 Rejected:0 Dropped:0`. Readback returned
`received receive` with the sent input and `completed complete`, with
`runtimeMetadata.sdk` of `wayscribe.dev/go` `0.2.2` (the Go SDK reports no
commit).

## OTLP warning

[OTLP_LOGS.md](../OTLP_LOGS.md) names `OTLP_LOGS_ENABLED`, and
`compose.published.yaml` passes it to the API (default `false`). Before
enabling it, `POST /v1/logs` answered 404.

```bash
export OTLP_LOGS_ENABLED=true
docker compose up -d   # recreated api; migrate ran again and exited
curl -sS -X POST http://127.0.0.1:8080/v1/logs \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  --data-binary @otlp-secret-names.json
```

The record, shaped after
[`examples/otlp-json/export.json`](https://gitlab.com/jojithedev/wayscribe/-/raw/v0.2.2/examples/otlp-json/export.json),
carried `wayscribe.input` with test values for `gatewayApiToken`, `cardNumber`
and `amount`. The answer was HTTP 200 with
`{"partialSuccess":{"rejectedLogRecords":"0","errorMessage":"Warning: stored unredacted under secret-looking names: wayscribe.input.gatewayApiToken. If these hold secrets, add the names to this environment's redaction paths or redact them in a Collector."}}`.
The warning names the path and neither value. `GET /v1/events/evt_otlp_verify_022`
showed `cardNumber` as `[REDACTED]`, `gatewayApiToken` stored as sent, and
`amount` 1295. Neither test value appeared in the API container's logs.

## Images, signatures and SBOMs

Anonymous registry access succeeded. `latest` matched each `v0.2.2` index.

| Image | Multi-platform index digest |
| --- | --- |
| `registry.gitlab.com/jojithedev/wayscribe/api:v0.2.2` | `sha256:048fedeefd15b7ed8ac77b5db9763e6c48ec9ee18652b87935aa6e421d295167` |
| `registry.gitlab.com/jojithedev/wayscribe/web:v0.2.2` | `sha256:aa8fd80d07392d06121de0c3912bd9fb253ab272a8a07257e78f1b18f3cdcba5` |

Each index also lists two BuildKit `attestation-manifest` entries.

Cosign `v2.6.5` (commit `3e82f50a2839855693aacf7b3d0e7e2f30774cb4`), run from
`gcr.io/projectsigstore/cosign:v2.6.5`
(`sha256:ad281047f85c5e1fc6ffbc30c2b55be3b07b4032bef715a12122ce5829619aca`):

```bash
ID='https://gitlab.com/jojithedev/wayscribe//.gitlab-ci.yml@refs/tags/v0.2.2'
docker buildx imagetools inspect registry.gitlab.com/jojithedev/wayscribe/api:v0.2.2 --format '{{json .Manifest}}'
docker run --rm gcr.io/projectsigstore/cosign:v2.6.5 verify \
  --certificate-oidc-issuer https://gitlab.com --certificate-identity "$ID" \
  registry.gitlab.com/jojithedev/wayscribe/api@$DIGEST
docker run --rm gcr.io/projectsigstore/cosign:v2.6.5 verify-attestation --type cyclonedx \
  --certificate-oidc-issuer https://gitlab.com --certificate-identity "$ID" \
  registry.gitlab.com/jojithedev/wayscribe/api@$DIGEST
```

`cosign verify` with the exact identity passed for both indexes and all four
platform manifests. As a negative control, the `v0.2.1` identity failed against
the API index ("no matching CertificateIdentity found").

`cosign verify-attestation --type cyclonedx` passed on all four platform
manifests, one attestation each, and failed on the API index with "none of the
attestations matched the predicate type", as designed: SBOMs attach to
platform manifests ([Operations](../OPERATIONS.md)). The web index was not
tried.

Each predicate, decoded from the DSSE payload and normalized with `jq -S`, is
byte-identical to the matching `publish-images` job artifact normalized the
same way. Each statement's subject is the platform manifest digest, and the
predicate type is `https://cyclonedx.org/bom`. The four artifact files pass
`shasum -a 256 -c SHA256SUMS`; that `SHA256SUMS` has SHA-256
`6870bd099cc478e9f35f8e8d2f140d55fbe237b013b78e148875f04cb854ab1f`.

| Image | Platform | Manifest digest | SBOM | SBOM SHA-256 | Components | Predicate equals artifact |
| --- | --- | --- | --- | --- | ---: | --- |
| API | linux/amd64 | `sha256:ae15d3bdc7ec0cba2d6f4ad382ce60fdfe322524b68a7aa8cb49f9a3a3ba7e5b` | `api-v0.2.2-linux-amd64.cdx.json` | `6939ab0b59de6e23d15a0daf45bad0a17155babede315e28c40a29d0c46f89a3` | 348 | yes |
| API | linux/arm64 | `sha256:c047ee2afa766f3212d333ebc1526e207a0b3b8013cf64f29eac055342f7f409` | `api-v0.2.2-linux-arm64.cdx.json` | `7a8c4588ad294058540c6ffe42ff1d4afba755fe1a7dd21098a026907ce8b2c9` | 347 | yes |
| Web | linux/amd64 | `sha256:a9011974b0151b25296ee69187ffd0d054e80b4d3e53f4880fb79acb72c06575` | `web-v0.2.2-linux-amd64.cdx.json` | `d1567bb079177d44aee9770d2fc0addd827022836ffdb99bd9d9691353476c89` | 368 | yes |
| Web | linux/arm64 | `sha256:a497799408b8f02d0336dc3a43095c98ebbde0462ac101def359651108a89095` | `web-v0.2.2-linux-arm64.cdx.json` | `be32d6884bb6d46aacc92691c1f10d7d0cb1b8ae99f28d963340749d5cc4302c` | 367 | yes |

The SBOMs are CycloneDX 1.6.

## Python package

[`wayscribe==0.2.2`](https://pypi.org/project/wayscribe/0.2.2/) is on PyPI with
a wheel (`b91638d8ff847ad5e14b6faa5ba6bfd7905bff5050dbdd205f3dae16a47ac243`)
and an sdist (`ff24aaefb671c60df2d2eb827c5db49827eeb398e38d5145bf5ac42100342ca0`).

```bash
docker run --rm --network wayscribe_default -e WAYSCRIBE_API_KEY -v "$PWD/py:/w" -w /w python:3.11-slim sh -c \
  'pip install --no-cache-dir wayscribe==0.2.2 && python run.py'
```

At 20:47:43Z the PyPI JSON API listed 0.2.2, but the first `pip install`
seconds later failed with "from versions: 0.2.0, 0.2.1", a stale simple-index
cache. A retry at 20:48:10Z installed `0.2.2`. In Python 3.11.16, the Python
README's `create_recorder` context manager example (endpoint, key and
environment adapted) printed `recorded: 4, sent: 4`, nothing rejected or
dropped. Readback returned `identified`, `transformed normalize` (with the
sent input), `persisted write-invoice` and `completed complete`, with
`runtimeMetadata.sdk` of `wayscribe` `0.2.2`.

Not verified: PyPI provenance, and that the installed wheel's hash matches the
one listed above (pip did the download).

## Limits of this evidence

- The stack ran the linux/arm64 images on an existing macOS Docker host. The
  linux/amd64 manifests, signatures and SBOM attestations were verified, but
  those images were not run.
- The SBOM comparison used the `publish-images` job artifacts. The same files
  were then uploaded to the `wayscribe-release-sboms` package for `v0.2.2`; an
  anonymous download of the uploaded `SHA256SUMS` has the same SHA-256 as the
  compared one
  (`6870bd099cc478e9f35f8e8d2f140d55fbe237b013b78e148875f04cb854ab1f`).
- The release pipeline, job statuses, job logs and test counts were not read.
- npm and PyPI provenance contents were not read. Node ran ESM only, on 22.12
  only. Go module authenticity rests on `sum.golang.org`, cross-checked with a
  separate lookup.
- The exercise was run by an AI agent on the maintainer's machine, following
  the README. It is not a clean-machine result or an unaided human onboarding
  trial, and it was not timed.
