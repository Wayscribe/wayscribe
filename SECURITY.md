# Security policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Open a [confidential issue](https://gitlab.com/jojithedev/flight-recorder/-/issues/new)
with the **Confidential** box ticked. That keeps the report visible only to
project members.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required.

This is a small project without a dedicated security team. Expect an
acknowledgement within a week. Please give a reasonable window for a fix before
disclosing publicly.

## Scope

Flight Recorder is self-hosted. There is no hosted service, so there is no
production environment to test against — please test against your own
installation.

In scope:

- the API (`apps/api`), the web interface (`apps/web`), and the Node SDK
- the published `@flight-recorder/node` package
- the published container images
- the default Compose configuration

Out of scope, because they are known and documented rather than undiscovered:

- **The development defaults are published.** `ENCRYPTION_KEY` and `ADMIN_TOKEN`
  ship with values committed to this repository so the demo runs with nothing
  configured. The API warns at every boot while they are in use. Running a real
  installation on them is a misconfiguration, not a vulnerability.
- **The admin token is a single shared secret.** There are no user accounts, no
  per-user permissions, and no record of who used it. It grants project-wide read
  of every recorded payload. See ADR-029.
- **Propagated journey context is not authenticated.** A caller who can set
  headers on a request to an instrumented service, and who knows a valid journey
  ID, can attach events to that journey. Extraction validates shape only, which
  stops injection and garbage but not a well-formed forgery. This is stated in
  the Phase 4 design and is not an authorization control.
- Anything requiring an attacker to already hold the admin token or a valid API
  key, unless it crosses a project boundary — cross-project access is structural
  (composite foreign keys) and a break there **is** in scope.

## What the product does with your data

Nothing captured is sent anywhere. There is no telemetry, no analytics, and no
outbound connection other than the ones your own configuration creates.

Entity identifiers and alias values are encrypted at rest with keys derived from
`ENCRYPTION_KEY`. **Payloads are not** — they are stored as `jsonb`, which is
exactly why redaction matters: payloads are redacted in your process before they
leave it, and again on the server before they are written, against a built-in
list of secret names matched at any depth.

**Flight Recorder records the contents of your integration payloads.** Treat the
database as holding whatever your workflows carry. If that includes regulated
data — health records, payment details, government identifiers — review
`captureMode` before enabling it. `metadata-only` records the shape of a journey
without storing payloads at all.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and
[docs/OPERATIONS.md](docs/OPERATIONS.md) for key handling.
