# Rename Flight Recorder to Wayscribe

Status: draft for the maintainer's approval, 2026-09-17.

## Why

"Flight recorder" is taken in this field: JDK Flight Recorder owns the `flight-recorder`
GitHub organization, Go ships `runtime/trace` FlightRecorder, and `pg_flight_recorder` is a
PostgreSQL tool. The first candidate, Clewline, was dropped on 2026-09-17 because clewline.com
is a live software company. The maintainer chose **Wayscribe** and holds github.com/wayscribe
and wayscribe.dev. The npm organization will be claimed later; nothing is published until then.

Nothing has been published and no outside team runs the tool, so every rename below is a clean
break with no compatibility aliases. After the first publish, each wire identifier would be a
breaking change, which is why the rename lands now.

## Names

| Kind | Now | After |
| --- | --- | --- |
| Product name in prose and the interface | Flight Recorder | Wayscribe |
| Root workspace package | `flight-recorder` | `wayscribe` |
| Workspace packages | `@flight-recorder/*` (api, web, demo, cli, config, database, payload-diff, payload-security, protocol) | `@wayscribe/*` |
| Public SDK package | `@flight-recorder/node` | `@wayscribe/node` |
| Example and recipe package names | `flight-recorder-example-*`, `flight-recorder-recipe-*` | `wayscribe-example-*`, `wayscribe-recipe-*` |
| CLI binary | `flight-recorder` | `wayscribe` |
| HTTP headers | `x-flight-journey-id`, `x-flight-entity-type`, `x-flight-entity-id`, `x-flight-replay`, `x-flight-project-id`, `x-flight-api-key` (log redaction) | `x-wayscribe-journey-id`, `x-wayscribe-entity-type`, `x-wayscribe-entity-id`, `x-wayscribe-replay`, `x-wayscribe-project-id`, `x-wayscribe-api-key` |
| Queue message attributes | `flightJourneyId`, `flightEntityType`, `flightEntityId` | `wayscribeJourneyId`, `wayscribeEntityType`, `wayscribeEntityId` |
| Payload envelope key | `_flight` | `_wayscribe` |
| Environment variables | `FLIGHT_RECORDER_API_KEY`, `_URL`, `_TOKEN`, `_PROJECT`, `_ENVIRONMENT`, `_VERSION`, `_WEB` | `WAYSCRIBE_API_KEY`, `_URL`, `_TOKEN`, `_PROJECT`, `_ENVIRONMENT`, `_VERSION`, `_WEB` |
| API key prefix | `fr_` | `wsk_` |
| Prometheus metrics | `flight_recorder_*` (eight families) | `wayscribe_*` |
| Alert rule names | `FlightRecorderRetentionStalled`, `FlightRecorderRejectingEvents`, `FlightRecorderDatabaseStrained` | `WayscribeRetentionStalled`, `WayscribeRejectingEvents`, `WayscribeDatabaseStrained` |
| Helm chart | `deploy/helm/flight-recorder`, helpers `flight-recorder.*`, example host `flight-recorder.local`, release examples `fr-flight-recorder-*` | `deploy/helm/wayscribe`, helpers `wayscribe.*`, `wayscribe.local`, `ws-wayscribe-*` |
| Default local database user and name | `flight` / `flight` (compose), `flight_recorder` (examples) | `wayscribe` / `wayscribe` |
| Compose project and network | `flight-recorder`, `flight-recorder_default` | `wayscribe`, `wayscribe_default` |
| Images | `registry.gitlab.com/jojithedev/flight-recorder/{api,web}`, `flight-recorder-demo:local` | `registry.gitlab.com/jojithedev/wayscribe/{api,web}`, `wayscribe-demo:local` |
| GitLab project path | `jojithedev/flight-recorder` | `jojithedev/wayscribe` |
| Example hosts in docs | `flight-recorder.internal`, `flight-recorder-api` | `wayscribe.internal`, `wayscribe-api` |
| Vendored SDK tarball name | `flight-recorder-node-<version>.tgz` | `wayscribe-node-<version>.tgz` |

`wsk_` rather than `ws_`: secret scanners match on the prefix, and a two-letter prefix is
common in unrelated code. `.gitleaks.toml` changes with it.

## What does not change

- **Key derivation labels.** `packages/payload-security/src/keys.ts` derives subkeys from
  `ENCRYPTION_KEY` with the HKDF labels `flight-recorder/field-encryption`,
  `flight-recorder/search-token`, `flight-recorder/api-key`, `flight-recorder/content-hash` and
  `flight-recorder/key-id`, and `apps/web/src/lib/session.ts` uses
  `flight-recorder/web-session`. Changing a label changes the derived key, so existing
  encrypted identifiers could not be read, search tokens would stop matching, key fingerprints
  would change, and every stored API key hash would stop verifying. These are internal
  domain-separation constants that no user sees. They stay as written, each with a comment
  saying why, and a test pins them.
- **History.** ADRs 001 to 056, `docs/superpowers/specs/` and `plans/` dated before this
  spec, `docs/claims-audit-2026-09-16.md`, `docs/reviews/`, and past CHANGELOG entries stay as
  written. `docs/DECISIONS.md` gets one note at the top saying the product was called Flight
  Recorder until 2026-09-17.
- **Migration files.** Migrations 001 to 019 are not edited. Two mention the name: a comment in
  015 and the connection `application_name` "flight-recorder migration 019", which only shows
  in `pg_stat_activity` while that migration runs. Neither is stored in the schema.

## Decisions

1. **No compatibility aliases on the wire.** Old headers, attributes, the `_flight` key and
   `FLIGHT_RECORDER_*` variables are not accepted after the rename. There are no outside users.
2. **Existing `fr_` keys keep working; new keys start `wsk_`.** The server finds a key by its
   stored first 12 characters and verifies an HMAC of the whole key; nothing on the server
   checks the prefix (`packages/payload-security/src/api-key.ts`). So old keys stay valid with
   no code for it, and the upgrade test, which checks that old keys still work, keeps passing.
   Two places that do know the prefix accept both: error-text masking
   (`packages/payload-security/src/mask-text.ts`), so an old key in an error message is still
   hidden, and `doctor`'s key check (`packages/database/src/doctor.ts`). Keys are 36 characters
   instead of 35. The published demo key becomes `wsk_demo...`, and `.gitleaks.toml` allows
   both fixture forms.
3. **Local database volumes break.** The default user and name change, so an existing
   `flight-recorder` compose volume will not match. `docs/LOCAL_DEVELOPMENT.md` and the
   CHANGELOG say so and give the one-line reset. The stopped `frdogfood` stack and its volume
   are left alone.
4. **ADR-057** records the rename, the name table, the unchanged derivation labels and why.
5. **GitLab project path.** The registry has no image tags today, so GitLab allows the rename.
   Order: merge the code change to main while the path is still `flight-recorder` (CI uses
   `CI_REGISTRY_IMAGE`, so it keeps working), then rename the path to `jojithedev/wayscribe` with
   the maintainer's go-ahead, then push a commit that confirms CI and the published compose
   file resolve the new image names. GitLab redirects the old repository URL; the old registry
   path does not redirect.
6. **Local directory.** `~/workspace/flight-recorder` stays where it is during the change and
   is renamed to `~/workspace/wayscribe` afterwards, with Leadline's docs and the memory files
   updated.

## Order of work

1. Code, config and wire names (packages, imports, headers, attributes, envelope key, env vars,
   key prefix, metrics, CLI binary), with tests updated. The lockfile is regenerated.
2. Deployment: compose files, Dockerfiles, Helm chart directory and helpers, CI variables and
   scripts, image names, `.gitleaks.toml`.
3. Interface text: page title and any product name in the web app. Screenshots regenerated with
   `pnpm screenshots`.
4. Present-tense docs: README, `docs/` (except history), AGENTS.md, CONTRIBUTING.md,
   SECURITY.md, CODE_OF_CONDUCT.md, `.github/` templates, NOTICE, CHANGELOG entry, release notes
   draft, ADR-057 and the note in DECISIONS.md.
5. Docs-truth and claims tests updated to the new names.
6. After merge: GitLab path rename (maintainer's go-ahead), CI confirmation, local directory
   rename.
7. R2: other repos (`jojithedev.gitlab.io`, `ask-jorge` with a rebuild and redeploy, `job-radar`
   profile files). Resumes are the maintainer's call and are not edited.
8. Leadline: its SDK install, env vars and any header or attribute names move to the new names
   in one pass, coordinated with the maintainer's Leadline session.

## Done when

- `git grep -iE 'flight.?recorder|x-flight|flightJourney|flightEntity|_flight\b|\bfr_'`
  returns only the history listed above, the derivation labels, the two migration mentions, the
  legacy `fr_` handling in masking, `doctor` and `.gitleaks.toml`, and ADR-057.
- A test pins the derivation labels, and a test fails if a new `flight-recorder` name appears
  outside the allowed files.
- CI is green on every job, including e2e, demo and upgrade-test.
- A clean-clone demo run shows a journey and its diff.
- The published compose file names `registry.gitlab.com/jojithedev/wayscribe/*` and requires
  `WAYSCRIBE_VERSION`.
- The upgrade test still passes from the last pre-rename database, since derivation labels and
  schema are unchanged.
