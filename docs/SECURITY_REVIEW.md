# Security review packet

For a security engineer deciding whether a Flight Recorder pilot may run in
their environment. Every statement links to its source; the threat model is
[SECURITY.md](SECURITY.md).

## Data location

- Self-hosted, with no hosted service and no account
  ([../SECURITY.md](../SECURITY.md#scope)). All state is in **your own
  PostgreSQL**, with an ordinary role and no extensions
  ([OPERATIONS §1](OPERATIONS.md#bring-your-own-database),
  [ADR-037](DECISIONS.md#adr-037-the-database-is-the-operators-and-a-project-is-something-they-create)).
- The running services send no telemetry. Building the images downloads
  packages; Next.js build telemetry is disabled
  ([../SECURITY.md](../SECURITY.md#what-the-product-does-with-your-data)).
- The API's only outbound requests are replays to admin-configured
  destinations on `REPLAY_ALLOWED_HOSTS`
  ([send.ts](../apps/api/src/replay/send.ts),
  [SECURITY §9](SECURITY.md#9-replay-security)).

## What is stored

Capture mode is per environment, and new environments get `redacted-payload`
([migration 002](../packages/database/migrations/002_environments.js)).
`metadata-only` stores no input or output payloads; `full-payload` also needs
`ALLOW_FULL_PAYLOAD_CAPTURE`, off by default
([INGESTION_CONTRACT §7](INGESTION_CONTRACT.md#7-what-the-server-does-to-an-accepted-event)).

| Stored as | What |
| --- | --- |
| plain `jsonb`, after redaction | payloads; error, runtime, deployment and custom metadata |
| plain text | event names, timings, trace ids, entity type |
| plain text, by the host's choice | journey labels; copies of aliases marked displayable |
| AES-256-GCM | entity identifiers and alias values (searched by HMAC tokens), replay destination headers |

Sources: [ingest-event.ts](../apps/api/src/ingestion/ingest-event.ts),
[SECURITY §6](SECURITY.md#what-is-stored-in-plain-text-and-why),
[SECURITY §7](SECURITY.md#7-encryption),
[ADR-053](DECISIONS.md#adr-053-instrumenting-code-may-mark-an-alias-displayable-and-it-takes-every-statement-to-keep-it-so),
[ADR-054](DECISIONS.md#adr-054-a-journey-may-carry-a-public-label-and-the-journey-list-matches-partial-text-on-public-values-only).
Error messages are masked by shape, and stacks are dropped unless full capture
is on ([ADR-046](DECISIONS.md#adr-046-error-text-is-masked-by-shape-and-stacks-are-kept-only-under-full-capture)).

## Redaction

- By field name at any depth, including header shapes, in the SDK and again on
  the server; a match becomes `[REDACTED]`
  ([ADR-035](DECISIONS.md#adr-035-a-secret-is-identified-by-its-key-name-at-any-depth),
  [SECURITY §4](SECURITY.md#what-a-name-rule-reaches)). The built-in list
  includes eight webhook signature headers
  ([default-secrets.ts](../packages/payload-security/src/default-secrets.ts)).
- **Not caught:** a credential under a name no rule knows. The SDK and `doctor`
  warn about secret-looking names but do not redact them
  ([SECURITY §4](SECURITY.md#names-no-rule-covers),
  [ADR-055](DECISIONS.md#adr-055-a-secret-looking-name-no-rule-covers-is-warned-about-never-redacted-on-a-guess)).

## Authentication and authorisation

- **One admin token** (at least 32 characters) reads any project and can
  delete and replay. There are no user accounts, no roles, and no record of who
  used it ([ADR-029](DECISIONS.md#adr-029-admin-principal-is-project-wide-api-keys-stay-environment-scoped),
  [schema.ts](../packages/config/src/schema.ts)).
- **API keys** carry 192 random bits, are stored as a prefix and an HMAC, and
  are scoped to one project and one environment. They cannot delete, or write
  into another environment's journey
  ([api-key.ts](../packages/payload-security/src/api-key.ts),
  [SECURITY §2](SECURITY.md#cross-project-access),
  [SECURITY §14](SECURITY.md#deletion-on-demand)).
- **Throttle:** five failed credentials a minute from one address locks it
  for five minutes, per process. Ingestion is not throttled
  ([OPERATIONS §9](OPERATIONS.md#guessing-the-admin-token)).
- **Web session:** a cookie signed with a key derived from the admin token;
  `HttpOnly`, `SameSite=Strict`, `Secure` in the image, 12 hours
  ([login route](../apps/web/app/api/login/route.ts),
  [web Dockerfile](../apps/web/Dockerfile)). A nonce-based CSP and
  anti-framing headers are set on every page
  ([SECURITY §2](SECURITY.md#script-injection-in-the-interface)).

## Deletion, retention, key rotation

- Retention is per environment, swept hourly
  ([OPERATIONS §7](OPERATIONS.md#7-retention)). Deletion is hard and audited
  without the value, and erasure does not search payload contents
  ([OPERATIONS §8](OPERATIONS.md#8-deleting-data)).
- Deleted or masked data stays in dead row versions until vacuum, and in WAL,
  replicas and backups ([OPERATIONS §8](OPERATIONS.md#what-deletion-does-not-remove)).
- Key rotation has a grace period with the old key read alongside the new one
  ([OPERATIONS §6](OPERATIONS.md#6-key-rotation),
  [ADR-044](DECISIONS.md#adr-044-keys-carry-an-identifier-and-rotation-is-a-grace-period-not-a-migration)).

## Supply chain

CI blocks on `pnpm audit`, gitleaks and Trivy. Nothing is published yet, and
releases will be 0.x. Images will be signed with Sigstore keyless signing and
carry a CycloneDX SBOM per platform; the npm package will be published through
GitLab OIDC with provenance ([OPERATIONS §11](OPERATIONS.md#11-security-scanning),
[ROADMAP](ROADMAP.md#where-this-actually-is)). To verify, with your tag
([full steps](OPERATIONS.md#verifying-a-published-image)):

```bash
cosign verify registry.gitlab.com/jojithedev/flight-recorder/api:vX.Y.Z \
  --certificate-identity 'https://gitlab.com/jojithedev/flight-recorder//.gitlab-ci.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://gitlab.com
```

## Network

- API on 8080, web on 3000, published on `127.0.0.1` only; terminate TLS at a
  proxy ([OPERATIONS §9](OPERATIONS.md#9-exposure)).
- Metrics are off unless `METRICS_PORT` is set
  ([OPERATIONS §13](OPERATIONS.md#metrics)). `X-Forwarded-For` is ignored
  unless `TRUSTED_PROXY_COUNT` is set
  ([OPERATIONS §9](OPERATIONS.md#guessing-the-admin-token)).

## Known gaps

- **Not there:** SSO, user accounts, roles, per-user audit, and encryption of
  payloads beyond the database's own ([ROADMAP](ROADMAP.md#not-doing),
  [ROADMAP](ROADMAP.md#if-this-goes-public)).
- `audit_events` is never swept, and the login limiter is per process
  ([ROADMAP](ROADMAP.md#known-open-and-honest-about-it)). The development
  secrets are published, and propagated context is not authenticated
  ([../SECURITY.md](../SECURITY.md#scope)).
- The [pre-release security review of 2026-09-16](reviews/2026-09-16-security-review.md),
  done by an AI review agent at the maintainer's direction and not an
  independent audit, found no Critical, High or Medium issues. No outside
  party has reviewed the code. Among its low notes: a dry run
  holds row locks for the whole batch
  ([INGESTION_CONTRACT §8](INGESTION_CONTRACT.md#8-validating-without-storing)),
  and a text search that matches nothing scans its whole window, bounded only
  by the statement timeout ([OPERATIONS §10](OPERATIONS.md#listing-journeys)).

## Reporting a vulnerability

Open a confidential issue at
<https://gitlab.com/jojithedev/flight-recorder/-/issues/new>. Expect an
acknowledgement within a week
([../SECURITY.md](../SECURITY.md#reporting-a-vulnerability)).
