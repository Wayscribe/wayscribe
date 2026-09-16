# Security review packet

For a security engineer deciding whether a Flight Recorder pilot may run in
their environment. Every statement links to the document or code it comes
from. The threat model is [SECURITY.md](SECURITY.md); this page is its summary.

## What it is, and where data lives

- Self-hosted: an API, a web app and a database migrator, with no hosted
  service and no account ([../SECURITY.md](../SECURITY.md#scope)).
- All state is in **your own PostgreSQL** (15 or later), reached through
  `DATABASE_URL`, with an ordinary role and no extensions
  ([OPERATIONS §1](OPERATIONS.md#bring-your-own-database),
  [ADR-037](DECISIONS.md#adr-037-the-database-is-the-operators-and-a-project-is-something-they-create)).
  There is no second datastore or object storage
  ([OPERATIONS §1](OPERATIONS.md#1-what-holds-state)).
- The running services send no telemetry or analytics. Building the images
  downloads base images and packages; Next.js build telemetry is disabled with
  `NEXT_TELEMETRY_DISABLED=1`
  ([../SECURITY.md](../SECURITY.md#what-the-product-does-with-your-data),
  [tests/next-telemetry.test.ts](../tests/next-telemetry.test.ts)).
- The only outbound requests the API makes are replays, to destinations an
  admin configured and `REPLAY_ALLOWED_HOSTS` permits
  ([apps/api/src/replay/send.ts](../apps/api/src/replay/send.ts),
  [SECURITY §9](SECURITY.md#9-replay-security)). The web app talks only to the
  API, server-side ([compose.published.yaml](../infrastructure/compose.published.yaml)).

## What is stored

Capture mode is set per environment; new environments get `redacted-payload`
([migration 002](../packages/database/migrations/002_environments.js),
[INGESTION_CONTRACT §7](INGESTION_CONTRACT.md#7-what-the-server-does-to-an-accepted-event)).

| Mode | Input and output payloads |
| --- | --- |
| `metadata-only` | not stored |
| `allowlisted-fields` | only the configured paths, then the built-in secret list |
| `redacted-payload` | stored after the built-in list and the operator's paths |
| `full-payload` | stored after the built-in list only; needs `ALLOW_FULL_PAYLOAD_CAPTURE=true` too, which is off by default, or it acts as `redacted-payload` |

([capture.ts](../packages/payload-security/src/capture.ts))

- **Payloads are plain `jsonb`** after redaction. Flight Recorder does not
  encrypt them; redaction is the control (ADR-040,
  [SECURITY §7](SECURITY.md#7-encryption)).
- **Every mode** stores event names, services, timings, trace and correlation
  ids, the entity type, the journey label, and error, runtime, deployment and
  custom metadata after redaction
  ([ingest-event.ts](../apps/api/src/ingestion/ingest-event.ts)).
- **Entity identifiers and alias values** are encrypted with AES-256-GCM under
  keys derived from `ENCRYPTION_KEY`, stored as `fr1.<keyId>.<ciphertext>`, and
  searched by HMAC tokens
  ([encryption.ts](../packages/payload-security/src/encryption.ts),
  [search-token.ts](../packages/payload-security/src/search-token.ts),
  [SECURITY §7](SECURITY.md#key-identifiers-and-rotation)). Replay destination
  headers are encrypted the same way ([SECURITY §7](SECURITY.md#7-encryption)).
  The event content hash is an HMAC ([ADR-048](DECISIONS.md#adr-048-the-content-hash-is-keyed-and-compared-under-the-key-it-names)).
- **Plain text by the host's choice:** journey labels (never redacted), and a
  copy of an alias value while the instrumenting code marks it displayable. A
  database constraint forbids a copy on a masked alias
  ([SECURITY §6](SECURITY.md#what-is-stored-in-plain-text-and-why),
  [ADR-053](DECISIONS.md#adr-053-instrumenting-code-may-mark-an-alias-displayable-and-it-takes-every-statement-to-keep-it-so),
  [ADR-054](DECISIONS.md#adr-054-a-journey-may-carry-a-public-label-and-the-journey-list-matches-partial-text-on-public-values-only)).
- **Error text:** `error.message` is masked by shape (URL userinfo, bearer
  credentials, JWTs, private keys, known provider key prefixes) in the SDK and
  on the server; `error.stack` is dropped unless full capture is in effect
  ([SECURITY §4](SECURITY.md#credentials-inside-error-text),
  [ADR-046](DECISIONS.md#adr-046-error-text-is-masked-by-shape-and-stacks-are-kept-only-under-full-capture)).

## Redaction

- By field name, at any depth, ignoring case, `-` and `_`, in the SDK before
  sending and again on the server before storing. A match becomes
  `[REDACTED]` ([INGESTION_CONTRACT §7](INGESTION_CONTRACT.md#7-what-the-server-does-to-an-accepted-event),
  [ADR-035](DECISIONS.md#adr-035-a-secret-is-identified-by-its-key-name-at-any-depth)).
- Header shapes are covered: name-value pairs, HAR-style objects, Node's
  `rawHeaders`, and CRLF header blocks. The known misses are listed
  ([SECURITY §4](SECURITY.md#what-a-name-rule-reaches)).
- The built-in list includes eight webhook signature headers (Stripe, GitHub,
  Slack, HubSpot, Twilio, Shopify)
  ([default-secrets.ts](../packages/payload-security/src/default-secrets.ts)).
- **Not caught:** a credential under a name no rule knows is stored in plain
  text. The SDK warns once per name (`unredacted_secret_name`) and `doctor`
  lists such names from a sample of stored events; neither redacts
  ([SECURITY §4](SECURITY.md#names-no-rule-covers),
  [ADR-055](DECISIONS.md#adr-055-a-secret-looking-name-no-rule-covers-is-warned-about-never-redacted-on-a-guess),
  [OPERATIONS §12](OPERATIONS.md#secret-looking-names-stored-in-plain-text)).
  Values inside payload strings are not masked by shape.

## Authentication and authorisation

- **One admin token** (at least 32 characters) reads every project, one
  project per request, and can delete and replay. No user accounts, no roles,
  no record of who used it
  ([ADR-029](DECISIONS.md#adr-029-admin-principal-is-project-wide-api-keys-stay-environment-scoped),
  [../SECURITY.md](../SECURITY.md#scope),
  [schema.ts](../packages/config/src/schema.ts)).
- **API keys** carry 192 random bits, are shown once, stored as a prefix and an
  HMAC verifier, and are scoped to one project and one environment. They ingest
  and read their own environment; they cannot delete. A key cannot write into a
  journey another environment created (`journey_environment_mismatch`)
  ([SECURITY §2](SECURITY.md#cross-project-access),
  [SECURITY §14](SECURITY.md#deletion-on-demand),
  [api-key.ts](../packages/payload-security/src/api-key.ts)).
- **Throttles:** five failed credentials a minute per source address (IPv6 by
  /64) locks that address for five minutes, on the web login and the API. Held
  in memory per process. Ingestion is not throttled and has no rate limit
  ([OPERATIONS §9](OPERATIONS.md#guessing-the-admin-token),
  [ROADMAP](ROADMAP.md#if-this-goes-public)).
- **Web session:** after the admin token is entered, a cookie signed with a key
  derived from the token; `HttpOnly`, `SameSite=Strict`, `Secure` in the image,
  12 hours. Rotating `ADMIN_TOKEN` ends every session
  ([login route](../apps/web/app/api/login/route.ts),
  [web Dockerfile](../apps/web/Dockerfile),
  [OPERATIONS §6](OPERATIONS.md#admin_token-and-api-keys)).
- **Browser headers:** a nonce-based Content-Security-Policy with
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, no
  `X-Powered-By`; cross-origin form posts are refused
  ([SECURITY §2](SECURITY.md#script-injection-in-the-interface),
  [OPERATIONS §9](OPERATIONS.md#9-exposure)).

## Deletion, retention, key rotation

- **Retention:** per environment `retention_days`, swept hourly in bounded
  batches ([OPERATIONS §7](OPERATIONS.md#7-retention)).
- **Deletion:** hard delete of a journey, an identifier (erasure), a time
  window (CLI only) or a replay destination, by admin token, web session or
  CLI, each audited without the value. Erasure matches entity ids and aliases, not
  payload contents ([OPERATIONS §8](OPERATIONS.md#8-deleting-data),
  [ADR-045](DECISIONS.md#adr-045-deletion-is-hard-admin-only-and-audited-without-the-value)).
- **Deleted, masked or relabelled data persists** in dead row versions until
  vacuum, and in WAL, replicas, WAL archives and backups; key rotation does not
  reach plain-text copies ([OPERATIONS §8](OPERATIONS.md#what-deletion-does-not-remove),
  [SECURITY §6](SECURITY.md#a-masked-aliass-copy-outlives-the-row-version)).
- **Key rotation:** a grace period. `ENCRYPTION_KEY_PREVIOUS` is read beside the
  new key, `rotate:reencrypt` rewrites stored values, and `rotate:status` says
  when the old key can go. API keys move as they authenticate; one unused for
  the whole period stops working. Dumps taken before rotation stay readable with
  the old key ([OPERATIONS §6](OPERATIONS.md#6-key-rotation),
  [ADR-044](DECISIONS.md#adr-044-keys-carry-an-identifier-and-rotation-is-a-grace-period-not-a-migration)).

## Supply chain

- CI blocks on `pnpm audit` (high and above), gitleaks over the full history,
  and Trivy on both images (high and critical); a CycloneDX SBOM is generated
  per image ([OPERATIONS §11](OPERATIONS.md#11-security-scanning),
  [ADR-041](DECISIONS.md#adr-041-scanners-run-the-real-tools-and-the-baseline-is-cleared-before-they-block)).
- Released images are signed with Sigstore keyless signing from the GitLab
  release pipeline, with a signed CycloneDX SBOM attestation per platform. The
  npm package is published through GitLab OIDC trusted publishing with
  provenance ([OPERATIONS §11](OPERATIONS.md#verifying-a-published-image),
  [OPERATIONS §11](OPERATIONS.md#publishing-the-sdk-to-npm)).
- Nothing is published yet; releases will be 0.x, where a minor release may
  change the API ([ROADMAP](ROADMAP.md#where-this-actually-is),
  [RELEASE_NOTES_DRAFT.md](RELEASE_NOTES_DRAFT.md)). Verify an image with its
  exact tag, replacing `vX.Y.Z` (`api` or `web`):

```bash
cosign verify registry.gitlab.com/jojithedev/flight-recorder/api:vX.Y.Z \
  --certificate-identity 'https://gitlab.com/jojithedev/flight-recorder//.gitlab-ci.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://gitlab.com
```

The signature is only as strong as the protection on `v*` tags, which must be
in place before the first release ([../SECURITY.md](../SECURITY.md#verifying-the-images-you-run)).

## Network behaviour

- API on 8080, web on 3000; the Compose files publish both on `127.0.0.1`
  only ([OPERATIONS §9](OPERATIONS.md#9-exposure),
  [compose.published.yaml](../infrastructure/compose.published.yaml)). Both
  images run as the non-root `node` user
  ([api](../apps/api/Dockerfile), [web](../apps/web/Dockerfile)).
- The API serves plain HTTP. Terminate TLS at a reverse proxy; the SDK warns
  when its endpoint is `http:` off the machine
  ([OPERATIONS §9](OPERATIONS.md#9-exposure),
  [SDK README](../packages/sdk-node/README.md#an-endpoint-that-is-not-encrypted)).
- Metrics are off unless `METRICS_PORT` is set, then served unauthenticated on
  that port only, with no request values in labels
  ([OPERATIONS §13](OPERATIONS.md#metrics),
  [ADR-047](DECISIONS.md#adr-047-metrics-on-their-own-port-in-a-format-written-here)).
- `X-Forwarded-For` is ignored unless `TRUSTED_PROXY_COUNT` is set, on the API
  and the web app; set it only when nothing reaches the containers except
  through those proxies ([OPERATIONS §9](OPERATIONS.md#guessing-the-admin-token)).
- `REPLAY_ALLOWED_HOSTS` is the only limit on where replay can send, and
  private addresses are allowed; the published defaults are `localhost` alone
  ([OPERATIONS §9](OPERATIONS.md#replay-destinations)).

## Known gaps

- **Not there:** SSO, user accounts, roles, per-user audit, a read-only
  principal, audit of reads or of API key creation and revocation, and
  encryption of payloads beyond what the database or disk provides
  ([ROADMAP](ROADMAP.md#not-doing), [ROADMAP](ROADMAP.md#if-this-goes-public),
  [repositories/audit.ts](../packages/database/src/repositories/audit.ts)).
- `audit_events` is never swept, and the login limiter is per process, so N
  replicas allow N times the attempts ([ROADMAP](ROADMAP.md#known-open-and-honest-about-it)).
- The development `ENCRYPTION_KEY` and `ADMIN_TOKEN` are published; the API
  warns at every boot while they are in use, and `doctor` checks for them.
  Propagated journey context is not authenticated
  ([../SECURITY.md](../SECURITY.md#scope),
  [ROADMAP](ROADMAP.md#if-this-goes-public)).
- A pre-release security review on 2026-09-16 reported no Critical, High or
  Medium findings. Its two low notes are documented behaviour: a dry run holds
  its row locks for the whole batch
  ([INGESTION_CONTRACT §8](INGESTION_CONTRACT.md#8-validating-without-storing)),
  and a journey text search that matches nothing reads every journey in its
  window, which has no maximum length, so it is bounded only by the 15-second
  statement timeout ([OPERATIONS §10](OPERATIONS.md#listing-journeys),
  [journey-list-query.ts](../apps/api/src/routes/journey-list-query.ts)).

## Reporting a vulnerability

Open a confidential issue at
<https://gitlab.com/jojithedev/flight-recorder/-/issues/new> with the
**Confidential** box ticked. Expect an acknowledgement within a week; there is
no dedicated security team ([../SECURITY.md](../SECURITY.md#reporting-a-vulnerability)).
