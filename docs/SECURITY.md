# Security

## 1. Security posture

Flight Recorder may receive customer records, API requests, errors, identifiers, and internal system metadata.

Security and privacy are product requirements from the first release.

The safest default is:

> Capture metadata automatically. Capture values only when explicitly enabled.

## 2. Primary threats

### Secret capture

Payloads, headers, stack traces, and metadata may contain:

- API keys
- OAuth tokens
- cookies
- passwords
- webhook signatures
- database credentials

Stack traces and error messages carry these as free text, where redaction by
key name cannot reach. Section 4 describes how that text is masked, what the
masking does not catch, and why stacks are kept only under `full-payload`.

### Sensitive customer data

Captured entities may include:

- names
- email addresses
- phone numbers
- addresses
- health information
- financial information
- government identifiers

### Cross-project access

A query or API key must never expose another project or environment.

### Replay abuse

Historical payload replay could:

- charge a card
- send an email
- create duplicate records
- overwrite newer data
- trigger external webhooks
- reuse expired or privileged credentials

### Denial of service

Unbounded payloads, event batches, nesting, or SDK buffers could exhaust memory, CPU, database storage, or network capacity.

### Correlation leakage

Journey and entity identifiers propagated over HTTP may reveal business information to downstream systems.

## 3. Capture modes

Each environment supports one of:

### `metadata-only`

Store identifiers, operation metadata, timing, errors according to policy, and no business payload values.

### `allowlisted-fields`

Store only configured payload paths.

### `redacted-payload`

Store payload after configured sensitive paths are removed or replaced.

### `full-payload`

Store full payload subject to hard size limits and mandatory secret filtering.

`full-payload` must never mean “skip secret detection.”

## 4. Redaction

Redaction should occur:

1. in the SDK before buffering
2. on the server before persistence
3. before replay request creation
4. before replay response persistence
5. before any future AI provider request

Server policy is authoritative and may capture less data than the SDK requests.

Redaction replacements should preserve evidence that a value existed:

```json
{
  "access_token": "[REDACTED]"
}
```

### Credentials inside error text

Path redaction matches the name a value is filed under, so it cannot reach a
credential written inside a string. Error text is where those appear, so
`error.message` is also masked by shape, in the SDK before sending and on the
server before storing, whoever sent the event (ADR-045). The masker replaces:

- URL userinfo: `postgres://app:hunter2@db` becomes `postgres://[REDACTED]@db`
- `Bearer` and `Basic` credentials, keeping the scheme word
- values assigned to a secret name: the built-in secret names (`authorization`,
  `cookie`, `password`, `api_key`, `access_token` and the rest), compared as
  path redaction compares them, plus `token`, `signature`, `sig` and `apikey`,
  and `key` only as a query parameter
- JSON Web Tokens and PEM private key blocks
- provider-prefixed credentials: Stripe `sk_`, `rk_` and `whsec_`, Slack
  `xox?-`, GitHub `gh?_` and `github_pat_`, GitLab `glpat-`, AWS `AKIA` and
  `ASIA` key ids, Google `AIza`, and Flight Recorder `fr_` keys

What it does not do:

- **It does not guess at entropy.** A credential in a shape not listed is
  stored. Long random-looking strings are exactly the identifiers the product
  shows, such as Salesforce ids, UUIDs and hashes, so there is no "looks random"
  rule.
- **It matches secret names whole.** `password=` is masked; `DB_PASSWORD=` is
  not.
- **It does not scan `metadata` strings or payload strings.** Those keep path
  redaction only.

`error.stack` is stored only when the environment captures full payloads, which
requires both `ALLOW_FULL_PAYLOAD_CAPTURE` and the environment's `full-payload`
setting. In every other mode ingestion drops it. A kept stack is masked like a
message. The Node SDK never sends one.

## 5. API keys

- Generate high-entropy keys.
- Display the full key once.
- Store only a safe prefix and verification hash.
- Scope keys to one project and environment.
- Support revocation.
- Never log keys.
- Use constant-time verification where applicable.
- Track last use without storing request payloads in auth logs.

## 6. Searchable sensitive aliases

Do not store plaintext searchable email addresses or similar low-entropy values by default.

Use normalized HMAC search tokens with a server-held key.

Display values may be:

- omitted
- masked
- encrypted
- available only to permitted local users

## 7. Encryption

At minimum:

- HTTPS for non-local deployment
- encrypted database and backup volumes at the infrastructure layer
- application encryption for stored replay headers
- external encryption key supplied through environment or secret manager

Alias display values, entity identifiers, and replay destination headers are
already encrypted at rest with a key derived from `ENCRYPTION_KEY`, in the format
and under the keys ADR-044 describes. Payloads are not, and this is a settled
decision rather than an interim state (ADR-040): redaction, not encryption, is
the payload control.

Encryption keys must not be stored in the same database as ciphertext.

### Key identifiers and rotation

Every encrypted value is stored as `fr1.<keyId>.<ciphertext>`. The key id is a
12-character HKDF fingerprint of `ENCRYPTION_KEY` under its own label: it
identifies the key without revealing anything about the subkeys, so it is safe
to log, and it is derived rather than configured, so a key cannot be
mislabelled. Values written before key ids existed have no prefix and are still
read.

Rotation is a grace period rather than a cut-over (ADR-044):

- `ENCRYPTION_KEY_PREVIOUS` holds the key being replaced. The API writes only
  under the current key and reads under both.
- Search matches either key's token until the data is re-encrypted.
- API key verifiers are HMACs and cannot be recomputed without the key itself,
  so each moves to the current key the next time it authenticates. A key that
  does not authenticate during the grace period stops working when the previous
  key is removed; `rotate:status` lists every such key so it can be revoked and
  reissued.
- `rotate:reencrypt` rewrites the stored values and tokens, and `rotate:status`
  confirms nothing is left under the old key before it is removed.
- GCM authentication makes a value under the wrong key fail to decrypt rather
  than produce garbage. A value under a key that is not configured is reported
  with that key's id, once per id, and the API logs a count at boot.
- A replay whose destination headers cannot be decrypted is refused and audited
  as blocked, never sent without them.

A suspected leak of `ENCRYPTION_KEY` is a reason to rotate, and a rotation does
not undo what the leaked key could already read: any dump or replica taken
before it stays readable with the old key. Rotation takes the live database out
of the old key's reach once re-encryption finishes, not the copies made before.

## 8. Project isolation

Every query must be explicitly scoped by authenticated project.

Tests must attempt cross-project access for:

- search
- journey reads
- event reads
- replay destinations
- replay runs
- audit events

Avoid unscoped repository functions.

## 9. Replay security

V0 replay rules:

- development destinations only
- explicit destination configuration
- host allowlist
- no automatic production credentials
- no copied authorization header
- no copied cookies
- no copied webhook signatures
- strict timeout
- request and response size limits
- audit every attempt
- user reviews payload before send

Blocked headers should include at least:

```text
authorization
proxy-authorization
cookie
set-cookie
x-api-key
x-amz-security-token
x-hook-signature
stripe-signature
```

Projects may add more.

## 10. Propagation security

By default, propagate only:

- journey ID
- non-sensitive entity type
- primary entity ID when explicitly allowed
- standard trace context

Do not propagate aliases automatically.

Allow projects to propagate only the journey ID.

## 11. Input limits

Enforce:

- maximum request body
- maximum batch count
- maximum event payload
- maximum JSON depth
- maximum number of object keys
- maximum string length
- maximum metadata size
- maximum replay response body
- replay timeout

Reject dangerous or malformed payloads before expensive processing.

## 12. SDK resilience and safety

- bounded event queue
- no recursive logging of recorder failures
- no synchronous network dependency
- safe serialization of circular values
- truncation indicators
- configurable stack capture
- clear dropped-event diagnostics

## 13. Audit events

Audit at least:

- API-key creation and revocation
- capture-policy changes
- replay destination creation and update
- replay attempt
- replay blocked by policy
- retention changes
- deletion or cleanup operations

Audit metadata must itself be sanitized.

## 14. Retention

- default to short local retention
- configure per environment
- delete in bounded batches
- document backup implications
- ensure deleted aliases and payloads are removed
- avoid retaining replay responses longer than the source environment requires

## 15. Future BYOK AI security

AI is not part of V0.

Future BYOK rules:

- disabled by default
- explicit project enablement
- user-owned credentials
- provider credentials encrypted
- redaction before request
- field-selection preview
- no automatic background export of payloads
- full request audit
- provider endpoint allowlist
- output clearly labeled as inference
- deterministic evidence remains authoritative

## 16. Pre-release security checklist

- [ ] Project isolation tests pass.
- [ ] API keys are never stored in plaintext.
- [ ] Default capture mode is safe.
- [ ] Redaction occurs before persistence.
- [ ] Common secret headers are filtered.
- [ ] Payload and batch limits are enforced.
- [ ] Replay cannot target an unapproved host.
- [ ] Replay cannot copy historical authorization.
- [ ] Audit events are generated.
- [ ] SDK outage does not fail host operations.
- [ ] Retention cleanup deletes all related data.
- [ ] Documentation warns against capturing regulated data without proper controls.
