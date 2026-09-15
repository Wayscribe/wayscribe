# Secrets inside error text — design

Date: 2026-09-15. Status: approved for planning (autonomous v1 work).

## Why

Redaction matches key names. A credential stored under `authorization` or
`api_key` is replaced at any depth (ADR-035, ADR-039), but a credential pasted
*inside* a string is not: ADR-039 records `error.message` and `error.stack` as
unsolved, and the open debt `DEBT-1WQHGD` tracks it. Errors are exactly where
credentials end up in text:

- `connect ECONNREFUSED postgres://app:hunter2@db.internal:5432/app`
- `Request failed: Authorization: Bearer sk_live_…`
- `Invalid API key provided: sk_test_…`
- `GET https://api.example.com/v1/items?access_token=…`

What exists today:

- The Node SDK already omits `stack` (`packages/sdk-node/src/recorder.ts`,
  `toErrorRecord`: name, message, code). A stack is only ever stored when a
  client other than the SDK sends one; the protocol accepts up to 16 KiB.
- The server runs `redactAlways` on `error`, which cannot reach inside strings.

## Decision

1. **Mask credential-shaped substrings in error text**, on both sides:
   the SDK before sending and the server before storing, the same function in
   both places, so a non-SDK client gets the same protection. The function is
   idempotent: masking masked text changes nothing.
2. **Do not store stacks unless the environment captures full payloads.**
   Ingestion drops `error.stack` unless the environment's capture mode is
   `full-payload`, which already requires both the process-level
   `ALLOW_FULL_PAYLOAD_CAPTURE` and an explicit environment setting. A team that
   has deliberately opted into full capture gets stacks, masked like messages.
   No new setting.
3. **Recognise shapes, not entropy.** No generic "long random string" detection:
   the identifiers this product exists to show (Salesforce ids, UUIDs, order
   numbers, hashes) are long and random-looking, and masking them would destroy
   the record a reader came for. A missed unusual token shape is the accepted
   cost, stated in the docs.

## What is masked

`maskSecretsInText(text): string` in `packages/payload-security`, replacing each
match's secret part with `[REDACTED]` and keeping enough context to read the
error:

| Shape | Example (fake) | Becomes |
| --- | --- | --- |
| URL userinfo | `postgres://app:hunter2@db:5432` | `postgres://[REDACTED]@db:5432` |
| Authorization scheme | `Bearer abc.def-ghi`, `Basic dXNlcjpwYXNz` | `Bearer [REDACTED]` |
| Secret-named query parameter or assignment | `?access_token=xyz&page=2`, `password=hunter2`, `"api_key": "k"` | `?access_token=[REDACTED]&page=2` |
| JSON Web Token | `eyJhbGciOi….eyJzdWIi….sig` | `[REDACTED]` |
| PEM private key block | `-----BEGIN RSA PRIVATE KEY-----…-----END…` | `[REDACTED]` |
| Well-known provider prefixes | `sk_live_…`, `sk_test_…`, `rk_live_…`, `whsec_…`, `xoxb-…` (Slack `xox[abprs]-`), `ghp_…`, `gho_…`, `github_pat_…`, `glpat-…`, `AKIA` + 16, `AIza` + 35, Flight Recorder's `fr_` keys | `[REDACTED]` |

Secret-named parameters and assignments use the same normalised name list as path
redaction (`DEFAULT_SECRET_PATHS`'s names, compared lowercase with `-` and `_`
removed, per ADR-039), plus `token`, `signature`, `sig`, `apikey`, `key` only
when written as a query parameter (`[?&]key=`), never as a bare word.

## Where it runs

- **SDK:** `toErrorRecord` masks `message`. If a future change adds `stack`, it is
  masked there too.
- **Server:** in ingestion, before `redactAlways(event.error, …)`: drop `stack`
  unless the environment's capture mode is `full-payload`; mask `message` and any
  kept `stack`.
- Nowhere else in v1. `metadata` string values and payloads keep path redaction
  only; the docs say so.

## Boundaries

- `packages/payload-security/src/mask-text.ts` and `mask-text.test.ts`.
- `packages/sdk-node/src/recorder.ts` (`toErrorRecord`), with a bundled SDK: the
  SDK has zero runtime dependencies and bundles what it uses from
  `payload-security` (`packages/sdk-node/scripts/bundle.mjs`); confirm the masker
  is bundled and the SDK's dependency-free check still passes.
- `apps/api/src/ingestion/ingest-event.ts`.
- Remove `DEBT-1WQHGD`; update the ADR-039 consequence line's forward reference.

## Documentation

- `docs/DECISIONS.md`: a new ADR, "Error text is masked by shape, and stacks are
  kept only under full capture".
- `docs/SECURITY.md` §2 and the redaction section: what is masked, what is not
  (entropy, metadata strings, payload strings), and that stacks need
  `full-payload`.
- `packages/sdk-node/README.md`: the error record section.
- `CHANGELOG.md`, README ADR count.

## Testing

- **Unit, masker:** a positive corpus of realistic error messages built from
  real library shapes (pg connection strings, axios and fetch errors with
  headers and URLs, Stripe, AWS SDK, GitHub, Slack, JWT in a header echo, PEM in
  a TLS error), each asserting the secret is gone and the surrounding words
  remain; a negative corpus asserting unchanged output for Salesforce ids,
  UUIDs, ISO timestamps, SHA-256 hex, order numbers, email addresses, URLs
  without userinfo, `keyboard=`, `monkey=`, the word "token" in prose, and
  `[REDACTED]` itself (idempotence).
- **Unit, SDK:** a wrapped callback throwing an error whose message carries a
  credential sends a masked message.
- **Integration, API:** an event from a non-SDK client with a credential in
  `error.message` and a `stack` stores a masked message and no stack in
  `redacted-payload` mode; in `full-payload` mode stores a masked stack. Read the
  row back from PostgreSQL, as `WHAT_RUNNING_IT_FOUND.md` requires for redaction
  tests, and pair each "does not contain the secret" assertion with a "contains
  the surrounding text" assertion.
