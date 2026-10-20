# CI layout and live-demo checks (#10): design

Date: 2026-10-19. Issue: GitLab jojithedev/wayscribe #10. Decisions by Jorge in the 2026-10-19 brainstorm.

## Problem

Four gaps, each of which has already let something through:

1. `e2e`, `demo` and `upgrade-test` are manual on MR and main pipelines. The 3px journeys link on phones (live until 0.2.4) and the broken smoke-check pattern both got past CI because nobody played them.
2. Every push to a branch with an open MR makes two pipelines. The MR pipeline holds one job (`python-publish-dry-run`), so a green MR pipeline says almost nothing. On 2026-10-19 MR !10 was merged on that green while the full branch pipeline was still running.
3. On a tag, `deploy-demo` shows "skipped" until `publish-images`, itself manual, has been played.
4. GitLab never checks demo.wayscribe.dev. `deploy/demo/smoke-check.sh` runs on the VM (5-minute timer, nightly reset) and once inside `deploy-demo`; nothing checks layout or the released version from outside.

## Measured cost

Recent successful jobs, all on `saas-linux-small-amd64` (the project runner is not in use for them today): `e2e` 3.4 to 4.6 min, `demo` 6.0 to 10.4 min, `upgrade-test` 3.9 to 4.7 min, `demo-overlay` 6.4 to 7.6 min, `publish-images` 16 to 35 min, `deploy-demo` about 1.3 min. Running all three browser and stack jobs on a merge to main adds about 15 to 20 SaaS minutes.

## Decisions

1. **One pipeline per push (MR pipelines).** A top-level `workflow: rules` block: when an MR is open, MR pipelines run and branch pipelines do not; with no MR, branch pipelines run; `main`, tags and schedules run as today.
2. **Browser and stack jobs are path-scoped on MRs, always on main and schedules.** On an MR each job runs automatically when its paths change and stays manual otherwise. On `main` and on schedules all three always run. `allow_failure: true` is removed, so a red job blocks the merge.
3. **A live check of the demo**, daily on a schedule and after every `deploy-demo`, alerting through a failed pipeline plus ntfy.
4. **On a tag, publishing runs on its own; deploying stays manual.** A pushed `v*` tag is the decision to release. The gates in front of publishing (`release-verify`, `upgrade-test`, `demo-overlay`) are what catches a bad tag.

`TESTING_STRATEGY.md` section 8 and the job comments say these suites stay off every push because a red pipeline needing the whole stack trains people to ignore it. Path scoping keeps that reason: a suite runs when its code changed, which is when red means something. The change gets its own ADR in `docs/DECISIONS.md` (and the README's ADR count moves with it, which `tests/docs-truth.test.ts` checks).

## Design

### 1. Pipeline selection

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS
      when: never
    - if: $CI_COMMIT_BRANCH
    - if: $CI_COMMIT_TAG
    - if: $CI_PIPELINE_SOURCE == "schedule"
```

Every job's `rules` is reviewed against it. Jobs that today say `merge_request_event: never` because the branch pipeline covered them (`site`, `video`, `pages` and others) are rewritten so the work they did on a branch now happens in the MR pipeline. `python-publish-dry-run` and `sdk-publish-dry-run` become ordinary MR-and-branch jobs.

### 2. Path-scoped browser and stack jobs

| Job | Runs on its own on an MR when these change |
|---|---|
| `e2e` | `apps/web/**`, `apps/api/src/**`, `apps/web/e2e/**`, `playwright.config.ts`, every workspace package `apps/web` or `apps/api` depends on, `pnpm-lock.yaml`, `.gitlab-ci.yml` |
| `demo` | `apps/demo/**`, `deploy/demo/**`, `infrastructure/compose.*.yaml`, `apps/api/src/**`, `apps/web/**`, `.gitlab-ci.yml` |
| `upgrade-test` | `packages/database/**`, `deploy/**`, `infrastructure/**`, `.gitlab-ci.yml` |

Rules per job, in order: `main` or schedule, always; tag, as today; MR with `changes:` (compared to the target branch), automatic; any other MR or branch, `when: manual` with `allow_failure: true` (so an unplayed manual job does not block the merge).

A path list can go stale: a new dependency of the web app that is not on the list would skip `e2e` on the MR and fail only after merge. A unit test closes that (below).

### 3. Live demo check

- `apps/web/e2e-live/demo.spec.ts`, read-only, at 375 and 1440 px, with its own `playwright.live.config.ts` whose `baseURL` defaults to https://demo.wayscribe.dev. `pnpm test:e2e` never reaches production; `pnpm test:live` runs it.
- Assertions: no horizontal scroll on the home page, the journeys list and the pinned journey; every journey link at least 44 px tall; the pinned journey shows `value lost` and `Likely cause: phone`; the footer version equals the newest `v*` tag (from `git describe --tags --abbrev=0 --match 'v*'` on the pipeline's ref, passed in as `EXPECTED_VERSION`).
- Job `live-demo`: Playwright image, on `$RUNNER_TAG`, runs on a schedule (`$CI_PIPELINE_SOURCE == "schedule"` and `$LIVE_DEMO_CHECK == "1"`, so the existing scan schedule does not run it unless set) and on tags after `deploy-demo` (`needs: ["deploy-demo"]`).
- On failure an `after_script` posts one line with the pipeline URL to `$NTFY_TOPIC_URL` (masked, protected; `main` and `v*` are protected, so both the schedule and tag pipelines see it). A missing variable prints a warning and does not fail the job a second time.
- Jorge creates the schedule in the GitLab UI: branch `main`, daily at 04:30 UTC (after the 04:00 reset), variable `LIVE_DEMO_CHECK=1`. The plan gives the exact settings.

### 4. Release flow

On a tag, `publish-images`, `publish-sdk`, `publish-python` and the GitHub release lose `when: manual`. `publish-images` gains `demo-overlay` in its `needs` (a demo the overlay failed is not published). `deploy-demo` keeps `when: manual` and `needs: ["publish-images"]` only, so it becomes playable as soon as images exist. `publish-python-testpypi` stays manual. `docs/DEMO_HOSTING.md`, `docs/OPERATIONS.md` and `docs/CI_RUNNER.md` are updated to the new order.

## Tests and verification

- **`tests/ci-rules.test.ts`** (unit, parses `.gitlab-ci.yml` with the `yaml` package already in the workspace):
  - every job except the release jobs (allow list in the test) runs in an MR pipeline;
  - no job outside the allow list has an MR rule ending `when: never`;
  - `e2e`'s `changes:` covers every workspace dependency in `apps/web/package.json` and `apps/api/package.json` (resolved to their package directories);
  - `e2e`, `demo` and `upgrade-test` have no `allow_failure: true` on `main`, schedule or path-matched MR rules;
  - `deploy-demo` stays manual and needs only `publish-images`.
  Each assertion is shown failing against today's `.gitlab-ci.yml` before the change.
- `glab ci lint` on the changed file.
- **The MR itself** touches `.gitlab-ci.yml`, so its own MR pipeline must run `e2e`, `demo` and `upgrade-test` without anyone playing them, and only one pipeline appears per push.
- **A deliberate regression**: a commit on the branch that shrinks the journeys link to 3px must turn `e2e` red in the MR pipeline; it is reverted before merge.
- **A throwaway MR** touching only `README.md` must show the three jobs as manual and stay green.
- `live-demo` is run once against the live demo from the branch by a manual trigger, and once with a wrong `EXPECTED_VERSION` to see it fail and post to ntfy.
- **Not verifiable before a release**: the tag path (automatic publish, playable deploy, `live-demo` after deploy). It is proven on the next release (0.2.7, which also carries !8, !9 and !10), and the MR says so rather than calling it verified.

## Out of scope

- #9 failure alerts in the product.
- Moving these jobs to the project runner (a `RUNNER_TAG` change, already supported).
- The timeline cursor repeat noted in the root-cause handoff.

## Changed during implementation

The sections above record the design as approved. Review and the first runs changed these points; ADR-073 and the plan hold the final form.

- `github-release` never had `when: manual`. It moved to the release stage and waits, with optional `needs`, for `publish-images` and `publish-sdk`, so a failed publish leaves no GitHub Release.
- The `demo` table has no `deploy/demo` (that is `demo-overlay`'s) and lists the six workspace dependencies (`config`, `database`, `payload-diff`, `payload-security`, `protocol`, `sdk-node`), the manifests and `.dockerignore`. `upgrade-test` also covers `apps/api`, those six packages, the manifests and `.dockerignore`. A merge request touching only the SDKs, the CLI or the documents leaves `e2e`, `demo` and `upgrade-test` manual.
- `live-demo` runs on the hosted runner (`saas-linux-small-amd64`), not `$RUNNER_TAG`, because it holds the protected `NTFY_TOPIC_URL`. It has `RUNNER_SCRIPT_TIMEOUT` 12m and `RUNNER_AFTER_SCRIPT_TIMEOUT` 1m so the alert fires on a hang, and the `demo` resource group.
- `publish-sdk` gates on `release-verify`, `upgrade-test` and `demo-overlay`, like `publish-images`. `publish-python` runs on its own only on a final protected `packages/sdk-python/v*` tag and is manual on `a`, `b` and `rc` tags, so a TestPyPI rehearsal happens on a pre-release tag before the final tag. Every release rule requires `$CI_COMMIT_REF_PROTECTED == "true"`.
- `scripts/publish-image.sh` refuses to overwrite an existing image tag and moves `latest` only for the highest final `vX.Y.Z`.
- The workflow's `never` rule applies only to `push` pipelines on a branch with an open merge request; API, trigger, schedule and UI pipelines are created anywhere.
