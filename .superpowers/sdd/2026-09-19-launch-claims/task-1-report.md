# Task 1 report: launch claims and release documentation

Date: 2026-09-19

Repository worktree:
`/Users/jorgepolanco/workspace/wayscribe/.claude/worktrees/release-claims`

Base revision: `173421bb12554bc71c16901affbdbc2a4a8d8ec7`

## Result

The launch claims now describe the selected, unpublished 0.1.0 preview from
current evidence. The update corrects the external comparison, replaces stale
SDK and current-scale database summaries, preserves historical million-scale
results with their original dates, records delivered runtime CI, corrects npm
trusted-publisher setup, and distinguishes completed technical work from owner
and publication gates.

No release tag was created. No package, image, site, social asset or announcement
was published. No account setting, service, repository remote or live system was
changed.

## Repository changes

- `README.md` and `site/src/content/docs/index.mdx` now acknowledge that spans
  can carry arbitrary application attributes. The comparison focuses on
  Wayscribe's paired step input/output, field diff, aliases and linked
  development replay. The README's demo image and top link block were left
  unchanged.
- `docs/ALTERNATIVES.md` now states that Honeycomb Private Cloud supports
  Honeycomb-managed and self-managed deployment in a customer's AWS account.
  Commercial status is separate from repository licence classifications. The
  update also scopes capability-absence statements to inspected documentation,
  names Bemi's SSPL v1 exactly, replaces the broken Convoy documentation link
  with its primary README, and corrects the Nodinite, Turbo360, Particular and
  n8n qualifications specified in the task brief.
- `packages/sdk-node/README.md` and `docs/FAQ.md` now use the current normal,
  awake, secret-name, sustained-load and concurrency results. They name source
  revisions, trees, Node version, hardware, method, shared-host condition,
  scheduler/power-state experiment, local stub, payload sizes and bounded
  drops.
- `docs/OPERATIONS.md` and `docs/FAQ.md` now report the completed current
  100,000-event-per-mode storage run and 120,000-journey list run. The historical
  million-event storage, million-journey identifier search and 2026-09-16
  index-removal comparison remain dated and labelled historical.
- The 120,000-journey script's actual scope is explicit: browse, text, admin,
  API-key and second-page cases with every index present, plus four `EXPLAIN`
  cases and ingestion. It did not remove indexes and did not measure the new
  timing predicates. The timing-filter evidence remains a separate 2026-09-18
  data set of 20,000 journeys and 60,000 events.
- `docs/OPERATIONS.md` now describes the existing reserved npm placeholder,
  removes the instruction to publish a real SDK manually to create the package,
  and tells the owner to enable direct `npm publish` because the protected
  release job uses that action. It records that current trusted-publisher
  configuration is unverified because `npm trust list` returned E401.
- `docs/RELEASE_NOTES_DRAFT.md` now identifies the selected version as the
  unpublished 0.1.0 preview, covers the reviewed per-record timing scope and
  migration 019 search-path repair, reports the green normal runtime pipeline,
  and keeps public artifacts and the three manual jobs pending.
- `CHANGELOG.md` retains the Unreleased heading and historical rename entries,
  while adding the selected 0.1.0 preview, timing/queue/retry fields, journey
  filters and migration 019 connection-state repair.
- `docs/claims-audit-2026-09-18.md` records each corrected claim, the current
  measurements and their limits, the npm account uncertainty and the runtime CI
  result.
- The completed timing task report was removed from
  `.superpowers/sdd/2026-09-18-record-timing/task-3-report.md` after verifying it
  is byte-for-byte identical to the archived evidence copy. Both files had
  SHA-256
  `ec7622e54f644f9758902e5e0ee12e8744698ced60de9b2bb56f572642817595`.
  Historical commits still contain the tracked copy.

## Local owner artifacts

These files are outside the repository and remain local artifacts:

- `/Users/jorgepolanco/workspace/wayscribe-launch-facts.md` now reflects
  delivered timing, current SDK/storage/journey evidence, normal runtime CI,
  reviewed local demo assets and remaining publication and human gates.
- `/Users/jorgepolanco/workspace/flight-recorder-adoption-todos.md` now records
  delivered timing/runtime CI/demo work, the existing npm reservation, the
  unverified trusted-publisher setting, the configured security address and the
  remaining owner decisions. Its older handoff history is preserved.
- `/Users/jorgepolanco/workspace/wayscribe-human-checks.md` no longer describes
  timing as in progress or the demo as absent. It keeps every human check
  unperformed, records that only technical audio checks passed, distinguishes
  source installs from published installs, treats `security@wayscribe.dev` as
  configured, and leaves the Code of Conduct enforcement/private contact as an
  owner choice.

The local demo evidence is a 91.43-second narrated MP4, a 1.78 MB GIF and a
1200 by 630 social preview. Whole-branch review found no remaining issue.
Human audio audition, social-preview upload and every public release action are
still unperformed.

## Evidence used

### Primary-source audit

- `timing/claims-source-preparation.md`, SHA-256
  `4413282167a741540f63056f19621060ef3023593ef54664b261d35fdf5c1d98`
- Official npm trusted-publisher instructions at
  `https://docs.npmjs.com/trusted-publishers/`, checked for the September 2026
  staging default and allowed-action wording
- The exact product, pricing, community and repository sources listed in the
  primary-source audit and linked from `docs/ALTERNATIVES.md`

### SDK measurements

- `timing/sdk-benchmark-metadata.json`, SHA-256
  `c1ca4fbada290fe57da85400c3007975141e42e53ef988e8c7b6bba82f13c5e2`
- `timing/wayscribe-timing-sdk-overhead-final.log`, SHA-256
  `e587916adbcd001f0f75a3140ebbf6807db46559a64237d8b9dd808c135745c2`
- `timing/wayscribe-timing-sdk-overhead-awake-final.log`, SHA-256
  `ce778136ca2942eae34e0d1c0a865c1976f640876edeb7bcf08ab90fbeeff193`
- `timing/wayscribe-timing-secret-names-final.log`, SHA-256
  `15d5af52e0352d304d951c210063fff4a15c29017dea50a081e09785e1dc203c`

The normal source was `3fb2b4a`; the awake source was `5537d4c`. Both used SDK
tree `1d591a3`, protocol tree `69118f1`, Node 24.19.0 and the shared Apple M3 Pro
host. The secret-name run used source `0359d02`.

The launch summary reports p50/p99 added call latency, not query p95. For a 1 KiB
payload against the local stub, the normal run measured 76.3/1,208.6
microseconds for `transform` and 28.5/452.3 for `persist`; the awake experiment
measured 37.0/575.0 and 21.8/400.6. The 200 ms stub's two 1 KiB cases each
recorded 11,000 events and dropped 5,000. Every event was eventually dropped in
the unreachable cases. The normal run contains idle periods but is not an
idle-machine measurement; the awake run is a scheduler/power-state experiment,
not a representative production workload.

### Database measurements

- `measurement-repair/benchmark-metadata.json`, current SHA-256
  `9279f7adae6d82fc4547d0199ec33bdb6b4208aec64da5c0a947520b369a2c54`
- `measurement-repair/wayscribe-timing-bench-storage-final.log`, SHA-256
  `d1ce30256008d12446d7338eb9d9890e2a60552ab66667b3460cef7ca089f101`
- `measurement-repair/wayscribe-timing-bench-journeys-final.log`, SHA-256
  `82a3efd1b5ed818495033eed44a597f3f1455487c6ca342cd1c4f411c1f3d075`

Both completed with exit 0 at source
`9da8b375cf0bd2d1a5d9494138b708d5da753754`; neither triggered its guard. They
used PostgreSQL 17.11 in an aarch64 `postgres:17-alpine` container limited to 2
CPUs and 3 GiB with a 2 GiB tmpfs, on a shared Apple M3 Pro host with Node
24.19.0. The API dependency closure was built at `a13c9b3`; the change to
`9da8b37` affected regression-test setup, not production migration/API code.

The current storage run recorded 100,000 events per mode. Ingested/compacted
bytes per event were 1,217/944 for `metadata-only`, 1,476/1,190 for
`allowlisted-fields`, 1,655/1,377 for `redacted-payload` and 1,669/1,377 for
`full-payload`. This scale is one tenth of the historical 2026-09-15 run and the
values are not interchangeable.

The current journey run recorded 120,000 journeys, 360,000 events and 360,000
aliases with four producers, 40 samples per query case and every index present.
The default admin 24-hour list measured 6.7/14.1 ms p50/p95. An admin no-match
text query over 30 days measured 483.3/594.2 ms and the API-key-scoped case
268.8/432.2 ms. A 100-event ingestion batch measured 383.1/450.3 ms and a
single new-journey event 6.0/8.2 ms. These are warm-cache, in-process API
measurements; network and physical storage I/O are excluded.

The current list script did not remeasure the timing predicates. Their separate
2026-09-18 warm-cache `EXPLAIN (ANALYZE, BUFFERS)` data set used 20,000 journeys
and 60,000 events and measured 0.157 ms for `minDurationMs`, 0.227 ms for
`minStepDurationMs` and 0.086 ms for `inactiveBefore`. Those plan executions are
not p50/p95 request distributions or production latency promises.

### Delivery evidence

- `remote-ci/wayscribe-9da8b37-normal-final.json` records pipeline `2863343305`
  at `9da8b375cf0bd2d1a5d9494138b708d5da753754` as successful. All 20 normal jobs
  passed. PostgreSQL 15, 17 and 18 each passed 979/979 integration tests; SDK
  jobs passed on Node 22.12 and 24; site, scans, build, SDK dry run and GitHub
  mirror passed.
- The e2e, demo and upgrade jobs remain manual and intentionally wait for the
  final docs/assets revision. Their status is not reported as success.
- `remote-ci/leadline-f65d3e0-final.json` records Leadline pipeline `2863343364`
  as successful across eight jobs. The documentation does not convert that
  result into an external adoption claim.

## Current and historical boundaries

- The current storage run is 100,000 events per mode. The 2026-09-15
  million-event values remain historical and continue to back the existing
  worked sizing example.
- The current journey-list run is 120,000 journeys and uses every index. The
  2026-09-16 before/after index-removal table remains a historical comparison.
- The 2026-09-15 exact identifier search results at up to a million journeys
  remain historical; the current list script does not replace them.
- The SDK p99 values are intentionally not presented as journey-query p95.
- Shared-host scheduling, local stubs, bounded drops, warm cache, tmpfs and
  in-process API injection remain visible limitations.
- Runtime CI is green for the delivered runtime revision, but this task's final
  docs/assets revision has not run the three manual jobs and has not been
  published.

## Verification

All commands used Node 24.19.0 from
`/Users/jorgepolanco/.nvm/versions/node/v24.19.0/bin`.

```text
pnpm exec vitest run tests/docs-truth.test.ts tests/docs-claims.test.ts tests/docs-links.test.ts tests/site.test.ts tests/supported-versions.test.ts
```

Result: 5 files passed, 136 tests passed, exit 0.

```text
pnpm format:check
```

Result: all matched files used Prettier style, exit 0.

```text
pnpm --dir site build
```

Result: 32 pages built, Pagefind completed, sitemap created and all internal
links validated, exit 0. Astro emitted its existing module-directive and empty
i18n/404 content warnings; the build completed.

`git diff --check` passed. The final file review confirmed that only the
evidence-affected repository files, this report and the archived duplicate
report removal are included; the README's demo image/link block is untouched.
No whole runtime suite or benchmark was run for this documentation task. The
benchmark logs were supplied by the controller.

## Remaining gates

- Configure and verify the npm trusted publisher for the already reserved
  `@wayscribe/node` package, including permission for direct `npm publish`.
- Protect and push `v0.1.0`, run the manual publication jobs, then verify the
  public package, images, signatures, provenance and Compose installation from
  outside the repository.
- Upload the social preview and write public launch text.
- Complete the clean-machine timing, unfamiliar-developer walkthrough, human
  narration audition and outside pilot feedback.
- Decide support commitments, inbound Apache-2.0 terms versus DCO, and the Code
  of Conduct enforcement/private contact. The security address is already
  configured.
