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
- **`infrastructure/compose.yaml` takes its keys from files.** `ENCRYPTION_KEY`
  and `ADMIN_TOKEN` come from `infrastructure/defaults.env` and then the
  repository-root `.env`, which wins. They used to be interpolated in
  `environment:`, which reads the shell and never the root `.env`, so a key set
  in `.env` as the README says never reached the API, the web app, or the demo
  bootstrap: they ran on the published defaults. `compose.published.yaml` is
  unchanged and still reads the shell.

### Added

- **`ENCRYPTION_KEY` can be rotated without losing data.** Every encrypted value
  now names the key that wrote it, and `ENCRYPTION_KEY_PREVIOUS` holds the key
  being replaced while the new one takes over. Through that grace period old
  journeys still decrypt and still search, and every API key still
  authenticates, moving to the new key the next time it does.
  `rotate:reencrypt` moves the stored data across in resumable batches, and
  `rotate:status` exits 0 once nothing is left under the old key, which is when
  the previous key comes out. If it comes out early, the API still starts and
  logs how much it cannot read. The procedure is in `docs/OPERATIONS.md` §6
  (ADR-044). Compose, the Helm chart, and `.env.example` all pass the new
  variable through.

- **The timeline is interactive.** Filter a journey to one service or to its
  failures, and move through its events with the arrow keys while the detail
  panel follows without a reload. The address keeps `?event=` in step, so a
  copied link still opens the event you were reading. A Live toggle follows a
  journey that is still recording as its events arrive, and turns itself off
  once a finished journey goes six seconds with nothing new. The page renders
  the first hundred events, however long the journey, and a "Show N more events"
  button reads the rest. The first paint is still server-rendered and the rows
  are still links, so nothing that worked before stopped working. The browser
  talks only to two session-checked route handlers in the web app, never to the
  API, so the admin token stays on the server (ADR-029). Long diffs collapse to
  eight rows behind a button that shows the rest.

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
- **Credentials inside error text are masked.** Redaction matched key names, so
  a password in a connection string or a token echoed in an error message was
  stored as written. The SDK now masks each error message before sending, and
  ingestion masks it again before storing, whoever sent the event. The masker
  recognises URL userinfo and Slack and Discord webhook URLs, `Bearer`, `Basic`
  and `Digest` credentials, values assigned to a secret name (including names
  like `DB_PASSWORD`, `STRIPE_API_KEY` and `x-auth-token`, read by their last
  words), JSON Web Tokens, PEM and PGP private keys, and provider-prefixed keys
  (Stripe, Slack, GitHub, GitLab, AWS, Google, OpenAI, Anthropic, npm,
  SendGrid, Hugging Face, and `fr_`). It does not guess at entropy, so an
  identifier is never masked and a credential in an unknown shape is not either;
  SECURITY.md §4 lists the other known misses. The SDK masks the first 8192
  characters of a message and then cuts the result to the protocol's 4096,
  ending in `[TRUNCATED]`. `metadata` and payload strings
  keep name-based redaction only (ADR-045).
- **Stack traces are stored only under full capture.** Ingestion drops
  `error.stack` unless the environment's capture mode is `full-payload` and
  `ALLOW_FULL_PAYLOAD_CAPTURE` is set, and masks a stack it keeps. The Node SDK
  never sent one; a client that did loses it below full capture.
- **A replay is never sent without its destination's headers.** Headers that
  could not be decrypted used to come back as an empty set, so the replay went
  out without the credentials the destination was configured with. It is now
  refused, recorded as blocked with the reason and the key id involved, and
  audited as `replay.blocked`.

### Fixed

The eight defects and seven smaller findings from the 2026-08-09 first-contact
audit, all merged the same day. The pattern behind them is written up in
[docs/WHAT_RUNNING_IT_FOUND.md](docs/WHAT_RUNNING_IT_FOUND.md).

- **The SDK reports what the server actually stored.** The batch route replies
  202 with a per-event verdict; the SDK checked only the HTTP status, so an
  `environment` typo produced `sent: 4`, no diagnostics, and an empty database.
  It now counts only accepted events and reports each refusal with the server's
  own message under a new `rejected` counter, kept separate from
  `transport_error` because a rejection is never retried.
- **`operation` is a typed union**, exported as `Operation`. A plausible verb
  like `"created"` used to compile, be refused, and vanish from the timeline.
- **A `Date` survives redaction, and a shared reference is not a change.**
  Redaction rebuilt objects from `Object.entries`, so every `Date` became `{}`
  on both sides of a transformation and a renewal that moved an expiry by a year
  diffed as "No fields changed". The cycle check never forgot a visited object,
  so two fields pointing at one address reported the second as `[CIRCULAR]`.
  Anything with a `toJSON` now serialises itself and the result is still walked;
  the cycle check holds only the ancestor chain.
- **One bad value no longer stops a service's telemetry.** A 4xx was retried
  like a 5xx, drove the breaker open, and put the batch back at the front of
  the queue, so one malformed payload blocked every event behind it for the
  life of the process. A 4xx is permanent now. NUL bytes and lone surrogates
  are repaired before they leave the SDK, a poisoned event is rejected alone
  rather than failing its batch, `metadata` passes through capture, `batchSize`
  is clamped to the server's ceiling, and a PostgreSQL error code no longer
  reaches the client as the API's error code (`unstorable_payload`).
- **Flushes are awaited and bounded.** `flush()` and `shutdown()` waited on
  nothing, so counters were read before the send finished and the last batch
  was lost on `process.exit`. A burst of 1,000 records opened 200 sockets and
  posted every event three times; at most four sends run at once. `shutdown()`
  reports an event recorded after it as dropped instead of discarding silently.
- **The timeline shows the whole journey.** The web layer hardcoded `limit=100`
  and discarded the cursor, so the hundred oldest events rendered and the
  dead-letter event you opened the page for was absent, under a header stating
  the true count. The page now follows the cursor, loading the rest of a long
  journey on request, and the count line says how many of the total are
  showing. Every row now carries a full UTC timestamp, the date appears
  when a journey spans more than one day, and an event whose recorded time is
  more than two minutes from its arrival carries a clock warning.
- **No blank 500s.** An API that was still booting rendered a blank page whose
  only text was "Flight Recorder". An error boundary explains the likely cause,
  and a 401 says the token does not match rather than "unreachable".
- **Propagation cannot kill the host.** The six propagation helpers were the
  only public entry points outside the failure boundary, so
  `injectHttpHeaders({}, extractHttpContext(req.headers))` killed the process on
  the first un-instrumented caller. Injected values are validated on the way
  in as well as on the way out.
- **A failure always registers.** A failed event stamped earlier than the
  journey's watermark left the journey `active` with a failure in its own
  timeline, which ADR-031 made the common case rather than a race.
- **`maxPayloadBytes` scales the string limit with it**, a discarded payload
  emits a diagnostic, and the event detail no longer claims "No fields changed"
  when neither side was captured.
- **Wrappers preserve the shape of their callback.** Every wrapper was async, so
  wrapping a synchronous call inside a synchronous handler changed its control
  flow: a handler that correctly returned 400 became a 200 with an empty body
  and an unhandled rejection. A synchronous callback now returns and throws
  synchronously, and the types carry overloads that say so.
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
- **A client that sends `error.stack` stops having it stored** unless the
  environment uses `full-payload` on an installation with
  `ALLOW_FULL_PAYLOAD_CAPTURE`.
- **Rows written before the upgrade are not masked retroactively.** Their error
  messages and their stacks stay exactly as they were stored, including any
  credential in them. Masking applies to events ingested after the upgrade.
  Removing the old rows is the job of deleting captured data, which is not yet
  available and is listed as open in the roadmap. Until it is, there is no
  supported way to remove them.
- Redaction reaching further means more `[REDACTED]` than before. If a key name
  on the built-in list appears somewhere it is not a secret, scope it with a
  dotted path in your own `redact` list.
- **Keys are trimmed of surrounding whitespace.** An `ENCRYPTION_KEY` that was
  configured with surrounding whitespace, usually a trailing newline, derives different keys after this upgrade,
  so data written before it stops decrypting and every API key issued before it
  answers 401. No setting reads that data afterwards: `ENCRYPTION_KEY_PREVIOUS`
  is trimmed the same way. A trailing newline does not come from a `.env` line;
  it comes from a secrets file, such as a Kubernetes secret created with
  `--from-file` from a file that ends in one.
  Check before upgrading:

  ```bash
  kubectl get secret <name> -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d | od -c | tail -2
  ```

  A `\n` before the final offset means the key has one.
- **Shell exports no longer reach `infrastructure/compose.yaml`.** A stack that
  was configured with `export ENCRYPTION_KEY=…` now starts on the published
  defaults instead. Move the values into the repository-root `.env`. After
  changing keys, recreate the containers with `docker compose … up -d`;
  `docker compose restart` does not re-read `env_file`.
- **Values written before this release carry no key id.** They read as before.
  `rotate:status` counts them as legacy and exits 1 until they are rewritten.
  Run `rotate:reencrypt` once with only `ENCRYPTION_KEY` set: with no previous
  key it upgrades legacy values the current key opens into the new format, under
  the same key, and `rotate:status` then exits 0. API keys issued before this
  release show `key id not recorded yet; recorded on next use` and do not hold
  the exit code at 1 unless a rotation is under way.
- **This release cannot be rolled back once it has written `fr1.` values.** An
  earlier build cannot read them, and it would send replays without their
  destination headers. To roll back, restore the backup taken before upgrading.

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
  invalidates every API key. There is no re-encryption tool. (Resolved under
  Unreleased: rotation is a grace period with `rotate:reencrypt`, ADR-044.)
- Propagated journey context is validated for shape but is not authenticated.
- Of the five verbs in the product promise, **changed** and **rejected** are
  demonstrated end to end. Duplication and loss are not yet first-class.
