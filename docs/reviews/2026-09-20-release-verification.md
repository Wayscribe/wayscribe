# Wayscribe 0.1.0 release verification

Date: 2026-09-20

Wayscribe 0.1.0 is published from protected annotated tag `v0.1.0` at commit
[`f6707c66ea2697a199871a4ef4263e52aa34c11c`](https://gitlab.com/jojithedev/wayscribe/-/commit/f6707c66ea2697a199871a4ef4263e52aa34c11c).
The [GitLab release](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0)
holds the install links and durable SBOM downloads. The
[GitHub mirror release](https://github.com/Wayscribe/wayscribe/releases/tag/v0.1.0)
points at the same commit.

## Release pipeline

The candidate [main pipeline](https://gitlab.com/jojithedev/wayscribe/-/pipelines/2865551354)
passed all 20 automatic jobs before the tag was created. The protected-tag
[release pipeline](https://gitlab.com/jojithedev/wayscribe/-/pipelines/2865565660)
passed 23 jobs, including:

- [unit tests](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009030):
  3,422 passed and 3 skipped;
- [release verification](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009042):
  7 acceptance tests against the built demo stack;
- [browser tests](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009037):
  71 tests with one project and 71 again with the project picker;
- [upgrade test](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009038):
  the previous release baseline remained readable after migration;
- Node SDK jobs on
  [22.12.0](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009031)
  and [24](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009032): 796
  tests on each;
- PostgreSQL jobs on
  [15](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009033),
  [17](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009034), and
  [18](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009035): 979
  integration tests on each;
- [SDK publication](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009044)
  and [image publication](https://gitlab.com/jojithedev/wayscribe/-/jobs/16613009043).

The ordinary manual `demo` job remained unused. It duplicates the seven
acceptance tests that the required `release-verify` job ran successfully.

## npm package

[`@wayscribe/node@0.1.0`](https://www.npmjs.com/package/@wayscribe/node/v/0.1.0)
is public, and `latest` resolves to it. The public tarball has npm integrity
`sha512-YggpB0/QlGpGbUoIy95GFKSIh+MH5Qm+3Sx38zTIiT1SGFMa4+PQwPirDSRHpqAsWqWYBkExOAvJ4PnAUMb+Mw==`.

`npm audit signatures` in an empty public consumer reported one verified
registry signature and one verified attestation. The SLSA provenance names:

- source and material commit
  `f6707c66ea2697a199871a4ef4263e52aa34c11c`;
- repository `git+https://gitlab.com/jojithedev/wayscribe`;
- entry point `publish-sdk`;
- GitLab runner builder
  `https://gitlab.com/jojithedev/wayscribe/-/runners/54907241`.

The provenance statement is recorded in Sigstore's
[transparency log](https://search.sigstore.dev/?logIndex=2901940323). The empty
consumer used Node 24 and verified both ESM and CommonJS imports plus actual SDK
recording. Node 22.12 support is established by the separate release-pipeline
SDK job above, not by that public-consumer run.

## Images, signatures and SBOMs

Anonymous registry access succeeded. Cosign verified each index and platform
manifest against issuer `https://gitlab.com` and certificate identity
`https://gitlab.com/jojithedev/wayscribe//.gitlab-ci.yml@refs/tags/v0.1.0`.
The `latest` tag matched each signed `v0.1.0` index at verification time.

| Image | Multi-platform index digest |
| --- | --- |
| `registry.gitlab.com/jojithedev/wayscribe/api:v0.1.0` | `sha256:0c95896c649454115c0db1945b53ef0502429b735e9af1154fa1516da361e582` |
| `registry.gitlab.com/jojithedev/wayscribe/web:v0.1.0` | `sha256:0aae74606d73ee3ef7214fe8ea7ad2577cfb34d7705e523ebd7b7da9178afe3d` |

Each platform manifest had a verified signature and a verified signed
CycloneDX attestation. The downloadable SBOM bytes match the original release
job artifacts, and their parsed JSON matches the verified attestation
predicates. The release also publishes their
[`SHA256SUMS`](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0/downloads/SHA256SUMS).

| Image | Platform | Manifest digest | SBOM | SBOM SHA-256 | Components |
| --- | --- | --- | --- | --- | ---: |
| API | linux/amd64 | `sha256:a0336fba5636c44c923b5f3985ba1082dc3626b263b95a889344144d42612de8` | [`api-v0.1.0-linux-amd64.cdx.json`](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0/downloads/api-v0.1.0-linux-amd64.cdx.json) | `b2d1b6e9d70da9ec74f155f61ac7bd7f0ba7f1ef55b3397ff858908d39486033` | 322 |
| API | linux/arm64 | `sha256:31fa1ca00906dcb99777ca67d0c46d370fedb24f13c6d3b451b08bdc5d73c4ab` | [`api-v0.1.0-linux-arm64.cdx.json`](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0/downloads/api-v0.1.0-linux-arm64.cdx.json) | `f11f221099d1d835935ae9f183a36a6ca1e880176bb6626634275472d86aacce` | 321 |
| Web | linux/amd64 | `sha256:68c54cc1d53fe694bb94b045efc18a5cdbf5262a0edb811724569cea1937d682` | [`web-v0.1.0-linux-amd64.cdx.json`](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0/downloads/web-v0.1.0-linux-amd64.cdx.json) | `8157d64ad2cf50059bcefeac6b2b4fc4572551dc4ee3884c782e0d9893349abc` | 368 |
| Web | linux/arm64 | `sha256:7c78f1366176121fd0814e9eedd8b6416616fb81b00d2577067ecfa2cd3b07db` | [`web-v0.1.0-linux-arm64.cdx.json`](https://gitlab.com/jojithedev/wayscribe/-/releases/v0.1.0/downloads/web-v0.1.0-linux-arm64.cdx.json) | `4fd0314c8bfe42012972a7d1853520f7dfa650fd27b4bbb862cdd28ee2627781` | 367 |

## Installation from public artifacts

The automated installation ran in a new isolated directory containing only the
tagged
[`compose.published.yaml`](https://gitlab.com/jojithedev/wayscribe/-/raw/v0.1.0/infrastructure/compose.published.yaml)
and
[`compose.bundled.yaml`](https://gitlab.com/jojithedev/wayscribe/-/raw/v0.1.0/infrastructure/compose.bundled.yaml).
It pulled the public `v0.1.0` images and installed the SDK from public npm.

The ARM64 API and web containers reported build version `v0.1.0` and commit
`f6707c66ea2697a199871a4ef4263e52aa34c11c`; the event read back from the API
reported the same SDK commit. Migrations, API and web health, project and key
creation, and all 12 `doctor` checks passed. The installed SDK recorded four
events: all four were sent, with none rejected or dropped and no transport or
capture errors. The readback exercised alias search, masked aliases, a field
diff, a recorded failure, deployment and SDK identity, and development replay
with the captured redacted input.

## Limits of this evidence

- The public runtime exercise used the linux/arm64 images on an existing macOS
  Docker host. The linux/amd64 manifests, signatures and SBOM attestations were
  verified, but those images were not run in this exercise.
- The successful automated run took 35.26 seconds after its inputs were ready.
  This is not a clean-machine result, an unaided human onboarding trial, or a
  measurement of a new developer's time to a first useful journey.
- The first install attempt stopped before pulling images when a 1.5 GiB free
  space guard failed. After only this release task's generated dependencies were
  removed, the retry completed. This verifies a safe low-space refusal and the
  successful retry, not installation on a storage-constrained host.
- The security review remains maintainer-directed AI review, not an independent
  audit. No outside pilot or unfamiliar-developer clarity review has happened.
