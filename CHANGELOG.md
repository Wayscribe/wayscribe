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

### Added

- Replay's outbound safety module: destination and path validation, an exact
  host allowlist, DNS resolution pinned to the address that was checked, refusal
  of the cloud instance metadata range, a header blocklist, response caps, and
  timeouts. The rest of replay is not built yet.

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

- **Replay is not implemented.** The safety module exists; the rest does not.
- The admin token is a single shared secret with no user accounts and no record
  of who used it.
- Rotating `ENCRYPTION_KEY` is destructive: it orphans every search token and
  invalidates every API key. There is no re-encryption tool.
- Propagated journey context is validated for shape but is not authenticated.
- Of the five verbs in the product promise, **changed** and **rejected** are
  demonstrated end to end. Duplication and loss are not yet first-class.
