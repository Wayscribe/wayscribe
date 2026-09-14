# Changelog

Notable changes to Flight Recorder. Dates are the day the work merged.

Versions follow [semantic versioning](https://semver.org). Before 1.0 the minor
version may carry breaking changes; the patch version will not.

The published artifacts are versioned together: the `api` and `web` images and
the `@flight-recorder/node` package share a version, because the event protocol
is the contract between them and a mismatch is not something a user should have
to reason about. The protocol itself carries its own `protocolVersion`, which
changes far less often.

## [Unreleased]

### Changed

- **Bring your own database.** `DATABASE_URL` is required and points at the
  PostgreSQL your team already runs — the one somebody backs up, monitors, and
  can restore. The bundled database moves to
  `infrastructure/compose.bundled.yaml`, an overlay for evaluation and local
  work (ADR-037). An installation that used the bundled database should add
  `-f compose.bundled.yaml` to keep the same behaviour.

### Added

- **`project:create` and `project:list`.** A new installation had no projects
  and no way to create one: `key:create` requires a project, and the only two
  that could exist came from the two hardcoded seeds, neither of which the
  published stack ran. Following the quick start reached "No projects yet" and
  stopped. The published image already carries the CLI, so this needs no
  checkout:

  ```bash
  docker compose -f compose.published.yaml run --rm --entrypoint node api \
    packages/database/dist/cli.js project:create acme "Acme Payments"
  ```

### Security

- **Built-in secret redaction now applies at any depth.** The shipped list paired
  each name with its `*.name` form, which together reached the top level of a
  payload and one level below it — and nothing inside an array, since an array
  with no matching `x[*]` rule was walked with no rules at all. A payload
  carrying `config.headers.authorization`, the shape every axios error has, was
  written to `journey_events.input_payload` as plaintext, in every capture mode
  and at both redaction points. Rules of the form `**.name` match a key name
  wherever it appears, and the built-in list is written entirely that way
  (ADR-035). The existing grammar is unchanged: a bare `authorization` still
  matches the top level only, and `*.password` still matches one below it.

### Fixed

- **`Map`, `Set`, `Error`, `RegExp`, `Headers` and `URLSearchParams` keep their
  contents.** All six store their data in internal slots, so the rebuild that
  makes redaction possible turned each into `{}` — including an `Error`, whose
  `name` and `message` are the two fields a reader most needs. They are now
  rendered inside the redaction walk, so redaction reaches into them, and the
  size guard measures them (ADR-036).
- **Cyclic and `BigInt` payloads are stored rather than discarded.** Both were
  reported as `payload_too_large`, which sent operators to a setting that could
  not help. A cycle becomes `[CIRCULAR]` and a `BigInt` its decimal string; a
  genuinely unserialisable value now reports `unserialisable_payload` (ADR-034).
- **A `__proto__` key in a payload survives.** `JSON.parse` makes it an ordinary
  own key, and rebuilding with assignment spent it on the object's prototype, so
  the field disappeared from the recorded payload.

### Upgrade notes

- A payload holding any of the values above now hashes differently, and
  `contentHash` is computed over what the SDK sent. Resending the same event id
  from a mixed-version fleet mid-rollout returns 409 `event_id_conflict`.
- A `Map` that measured as `{}` may now exceed `maxPayloadBytes` and record
  `[PAYLOAD_TOO_LARGE]` with a `dropped` diagnostic. That is the size guard
  seeing the data for the first time, not a regression.
- Redaction reaching further means more `[REDACTED]` than before. If a key name
  on the built-in list appears somewhere it is not a secret, scope it with a
  dotted path in your own `redact` list.

### Added

- Replay: destination management, request preparation and safety checks (exact
  host allowlist, DNS pinned to the resolved address, refusal of the cloud
  metadata range, a header blocklist, response caps and timeouts), the prepare
  and result UI, and the corrected demo endpoint. V0 reviews the payload before
  sending but does not allow editing it (ADR-032).

## [0.1.0] — unreleased

The first development release. Everything below works, is tested, and runs.

### Added

- **Ingestion.** `POST /v1/events` and `/v1/events/batch`, authenticated by an
  API key scoped to one project and environment, with server-side redaction,
  structural payload diffs, and idempotent duplicate handling.
- **Search and journeys.** Find a record by any identifier it is known by, then
  read its timeline across services. Alias search is independent of alias type,
  because a developer typing an identifier into a box does not know which type
  it was stored under.
- **Field-level transformation diffs**, which is the point of the product: the
  step where a value changed, shown as a field table rather than a text diff.
- **`@flight-recorder/node`**, the Node SDK. No runtime dependencies. Built so
  that a recorder failure cannot break the application it is recording.
- **Cross-process propagation** over HTTP headers and queue attributes, with
  three levels. The entity ID does not propagate by default; aliases never do.
- **The demo**, four services proving the reference journey end to end, and
  `pnpm test:demo`, which asserts all ten events, the diff, the retries, and the
  dead-letter state against a running stack.
- **Retention**, swept hourly inside the API process, per environment, behind an
  advisory lock.
- **API key lifecycle**: `key:create`, `key:revoke`, `key:list`.
- **Operations documentation** and a security disclosure policy.

### Known limitations

- The admin token is a single shared secret with no user accounts and no record
  of who used it.
- Rotating `ENCRYPTION_KEY` is destructive: it orphans every search token and
  invalidates every API key. There is no re-encryption tool.
- Propagated journey context is validated for shape but is not authenticated.
- Of the five verbs in the product promise, **changed** and **rejected** are
  demonstrated end to end. Duplication and loss are not yet first-class.
