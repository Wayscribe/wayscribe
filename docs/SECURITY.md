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

Nor may an API key write into one. A journey belongs to the environment that created it,
and ingestion refuses an event for it from another environment's key with
`journey_environment_mismatch` (ADR-038).

That refusal is itself something a key can aim. A key for one environment that
records a journey id first owns it, so if ids are predictable (`jrn_order_1001`)
a leaked development key can pre-record the ids production will use, and
production's events for them are refused and never stored. Journey ids must be
unpredictable: the Node SDK uses random UUIDs, and an application choosing its
own should too (`EVENT_PROTOCOL.md` §4). Event ids are unique per project and can
be claimed the same way, answered `event_id_conflict`; they should be random for
the same reason. A journey id propagated across environments is refused too.

### Guessing the admin token

The admin token reads every payload of every project, and it is one shared
secret. The web login and the API both throttle failed attempts per source
address (an IPv6 address by its /64), five a minute and then five minutes locked
out. The count is of refusals, so a burst sent at once can have more than five
credentials checked before the lock lands (`OPERATIONS.md` §9). Neither keys that
address on `X-Forwarded-For` unless `TRUSTED_PROXY_COUNT` says how many proxies
to look through (`OPERATIONS.md` §9). The throttles are per process. They slow a
guesser; the token's length, 32 characters at least, is what makes guessing
hopeless.

### Script injection in the interface

The interface renders recorded payloads, which any API key holder can write. React
escapes what it renders, and every page is also served with a
Content-Security-Policy that allows scripts only from its own origin and, inline,
by a nonce generated for that response: `default-src 'self'; script-src 'self'
'nonce-…'; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action
'self'; object-src 'none'`, with `img-src`, `font-src` and `connect-src` also
`'self'`. Next.js's production build inlines scripts in every page, so a policy
without a nonce would need `'unsafe-inline'`, which would allow an injected script
too; `apps/web/middleware.ts` sets the nonce and Next puts it on its own scripts.
Every response also carries `X-Frame-Options: DENY`, `Referrer-Policy:
no-referrer`, and `X-Content-Type-Options: nosniff`, and no `X-Powered-By`. The
browser suite fails on any policy violation on the search, journey, journeys,
replay, and delete pages.

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

### What a name rule reaches

A built-in secret name, or a configured `**.name` rule, is matched against the
name a value is filed under, with case, `-` and `_` ignored. It is filed under
a name in exactly these shapes, in the SDK and on the server alike:

- **an object key**, at any depth, including in objects that are elements of an
  array, and in the rendered contents of a `Map`, `Headers` or
  `URLSearchParams`
- **a name-value pair**: an array element that is itself a two-element array
  whose first item is a string, such as the `[["Authorization", "Bearer …"]]`
  header list fetch and undici accept. The second item is replaced.
- **a name-value object**: an array element that is a plain object carrying a
  string `name`, as in a HAR file, or a string `key`, as in Playwright's
  `headersArray`, beside a `value`. Only `value` is replaced; every other field
  on the object is left as it is, however many there are. This once required
  **exactly** those two keys, which meant a third key defeated the rule
  completely: HAR's own header object allows a `comment`, and a client that adds
  a `line` or an index does the same, so an entry carrying one was read as an
  ordinary object, nothing on it was named a secret, and the credential was
  stored in the clear.
- **an interleaved header list**: a flat array of strings of even length whose
  every even-indexed item is a valid HTTP header name token or an HTTP/2
  pseudo-header (`:` followed by a token, such as `:path` or `:status`), and at
  least one of them a common header (`host`, `user-agent`, `content-type`,
  `authorization`, `cookie`, the HTTP/2 pseudo-headers and a few others). Node's
  `rawHeaders` is this shape, from `node:http` and `node:http2`, on a server's
  request and on a client's response. The item after a secret name is replaced.
  A list of strings that fails any of those tests is left as it is, so
  `["password", "x"]` on its own is not reinterpreted.
- **a header line in an HTTP header block**: a string holding a CRLF, read line
  by line up to the first empty line, where a line `Name: value` with a secret
  name has the rest of that line replaced, as in `Authorization: [REDACTED]`. A
  `http.ClientRequest`'s `_header`, which axios puts on `error.request`, is this
  shape. Nothing else in the string is touched, and a string without a CRLF is
  never examined, with one exception: a string ending in the truncation marker
  (`[TRUNCATED: <n> characters removed]`) is read as a block too. A client
  that cut a block to its first line lost the only CRLF with the cut, and that
  line must not escape masking. The Node SDK, cutting a string that holds a
  CRLF, puts the marker on a line of its own for the same reason: the
  environment's own redaction paths, which the SDK does not know, may name the
  first header (ADR-051).

In the three positional shapes, a value that is itself one of those common
header names is kept, so a list of header names such as
`allowedHeaders: ["Authorization", "Content-Type"]` or a `vary` list is not
altered. No credential is a header name.

A secret filed in any other shape keeps whatever the payload held. Payload
strings are deliberately not masked by shape (ADR-046). These are known and not
covered:

- **Header values held as `Buffer`s**, as undici can report them. A `Buffer` is
  stored as its bytes, `{"type": "Buffer", "data": [...]}`, and no name rule
  reads bytes.
- **A header block whose lines end in LF alone, or CR alone**, including one
  that mixes them with CRLF before the secret line. Only CRLF marks a header
  block.
- **A header line after an empty line**, such as a second request logged after
  the first one's headers. The first empty line ends the block.
- **obs-fold continuation lines.** In `Authorization: Bearer\r\n abc`, only
  the first line's value is replaced, and ` abc` is stored.
- **Names padded with whitespace**: a key `" Authorization"`, a pair or list
  item `" Authorization"`, a header line indented by a blank, or
  `Authorization :` with a blank before the colon.
- **Arrays of three or more elements**, such as `["authorization", "…", "x"]`,
  which are not pairs, and interleaved lists holding any item that is not a
  string.
- **Header-looking text inside prose**: a line such as `x Authorization: …`
  whose name is not at the start of the line.

The shapes also replace some values that were not secrets: a two-element array
such as `["secret", "public-tag"]`, and a line such as `Secret: the surprise
party` in text that happens to use CRLF line endings. Scope a rule with a dotted
path in your own `redact` list if a name on the built-in list appears in such a
place.

### Credentials inside error text

Path redaction matches the name a value is filed under, so it cannot reach a
credential written inside a string. Error text is where those appear, so
`error.message` is also masked by shape, in the SDK before sending and on the
server before storing, whoever sent the event (ADR-046). The masker replaces:

- URL userinfo: `postgres://app:hunter2@db` becomes `postgres://[REDACTED]@db`
- the secret path segment of Slack and Discord webhook URLs, keeping the
  workspace and channel
- `Bearer`, `Basic` and `Digest` credentials of at least eight characters,
  keeping the scheme word. A value that reads as words, such as
  `Basic plan-2026`, and the auth-params of a challenge such as
  `Bearer realm="api"` are kept.
- values assigned to a secret name. A name is split into words on `_`, `-`, `.`
  and case changes:
  - the built-in secret names (`authorization`, `cookie`, `password`, `api_key`,
    `access_token` and the rest) count in every form
  - `token`, `signature`, `sig`, `passwd`, `pwd` and `pass` count when assigned
    with `=` or as a quoted key, and after an unquoted colon only with a quoted
    value, as in `util.inspect` output such as `pass: 'hunter2x'`. A number
    assigned to `pass` is a count, as in `tests pass=12`, and is kept. `key`
    counts only as a query parameter.
  - a name of several words counts when it ends in `password`, `passwd`, `pwd`,
    `passphrase`, `secret`, `token`, `credential` or `credentials`, or in a pair
    such as `api key`, `secret key`, `private key` or `access key`. A token that
    pages or protects a form (`pageToken`, `nextToken`, `csrf_token`) does not
    count, and nor does a name ending in `id`, `arn`, `name` or `url`. So
    `DB_PASSWORD`, `STRIPE_API_KEY` and `x-auth-token` are masked, and
    `password_hash`, `SecretId` and `max_tokens` are not.
- JSON Web Tokens, and PEM and PGP private key blocks
- provider-prefixed credentials: Stripe `sk_`, `rk_` and `whsec_`, Slack
  `xox?-` and `xapp-`, GitHub `gh?_` and `github_pat_`, GitLab `glpat-`, AWS
  `AKIA` and `ASIA` key ids, Google `AIza`, OpenAI and Anthropic `sk-`, npm
  `npm_`, SendGrid `SG.`, Hugging Face `hf_`, and Flight Recorder `fr_` keys

After an unquoted colon, a value is only read when a blank follows the colon,
so `secret:prod/db` inside an ARN is left alone.

What it does not catch, by design or by limitation:

- **A credential in a shape not listed.** It does not guess at entropy. Long
  random-looking strings are exactly the identifiers the product shows, such as
  Salesforce ids, UUIDs and hashes, so there is no "looks random" rule.
- **Prose after a secret name.** An unquoted value that is a plain word after a
  colon, or after `=` and a blank, is read as a sentence:
  `client_secret: missing`, `DB_PASSWORD: not set`. A credential that is a
  single dictionary word in that position, such as `DB_PASSWORD: sunshine`, is
  stored. Attached to `=`, as `.env` and Compose files write it,
  `DB_PASSWORD=sunshine` is masked.
- **A name without separators.** `DBPASSWORD` is one word and not on any list.
- **The error's `type` and `code`.** Only `message`, and a kept `stack`, are
  masked.
- **`metadata` strings and payload strings.** Those keep name redaction only,
  which reaches a header line inside an HTTP header block and no other text
  (section 4, "What a name rule reaches").
- **Rows written before this masking existed.** Their messages and stacks are
  stored as they arrived, until they are deleted (section 14, deletion on
  demand).

`error.stack` is stored only when the environment captures full payloads, which
requires both `ALLOW_FULL_PAYLOAD_CAPTURE` and the environment's `full-payload`
setting. In every other mode ingestion drops it. A kept stack is masked like a
message. The Node SDK never sends one of its own. It masks a window of twice
the protocol's limit and then cuts the result, a message to 4096 characters and
a stack passed to `record()` to 16384, ending in `[TRUNCATED]`; it masks the cut
text once more, so the server's pass leaves it unchanged.

The content hash stored with each event covers the event as received, before any
masking or redaction, so that a policy change cannot turn an identical resend
into a conflict (ADR-021). It is an HMAC-SHA256 under a subkey of
`ENCRYPTION_KEY`, stored as `h1.<keyId>.<hex>` (ADR-048), so a database read
without the key cannot confirm guesses at a masked or redacted value by
rebuilding the event and comparing hashes. Rows written before ADR-048 keep an
unkeyed SHA-256, with no prefix, and remain that oracle for what they masked
until they are deleted (section 14).

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

What is built: every alias value is stored encrypted (section 7) and matched
through its search token, and a masked alias is **masked when read**, because an
alias is another identifier for the record and a reader may not be entitled to
it. A masked alias has no plain-text form anywhere in the database. The primary
entity id is shown in full, since it is what the reader searched for.

**The one exception** is an alias the instrumenting code marked displayable
(ADR-053). An event may list alias types in `displayableAliases`, and an alias
is then shown in full only while **every** event that stated it listed it: a
later statement can mask it and nothing can unmask it again. The default is
masked, a server that predates the field masks everything, and nothing a reader
sends can change the flag. Mark only identifiers that are public by nature, such
as a posting id on a public job board, and never an email address or a customer
number.

### What is stored in plain text, and why

Two kinds of value are stored in plain text, both declared public by the code
that records them (ADR-054):

- **Journey labels** (`journeys.label`), the display text an event sets with
  `journeyLabel`. The host writes a label on purpose, to be shown and found, so
  it is **not redacted**: whatever the label says is stored and shown as sent.
  Do not put personal data in a label, such as a person's name or email
  address. What a label says is the host's responsibility.
- **Copies of displayable alias values** (`entity_aliases.display_value`),
  beside the encrypted value, so that the journey list can match them by
  partial text without decrypting every alias. A copy exists only while the
  alias is displayable. The database enforces that with a check constraint,
  `entity_aliases_display_value_only_when_displayable`
  (`displayable or display_value is null`), so no code path, including a
  future bug or a manual update, can leave a masked alias with a plain value.

Masked aliases and entity identifiers stay encrypted and tokenised exactly as
before.

### What the journey list's text filter can match

`q` on `GET /v1/journeys` matches, ignoring case, part of a journey's label or
part of the value of one of its displayable aliases, and nothing else. It never
matches a masked alias value, an entity id, a journey id or an entity type, even
when the text is exactly one of them: those are found by exact value through
search and its tokens, and a reader who does not already know one learns
nothing about it from `q`. It is always bounded by a time window, and it keeps
the list's scope: an API key reads its own environment only.

### A masked alias's copy outlives the row version

When an event masks an alias that was displayable, the same statement clears
the live row's copy, so no read returns it and `q` no longer matches it. The
text is not gone from the disk at that moment:

- PostgreSQL keeps the earlier row version until `VACUUM` reclaims it, and
  anyone who can read the table files can read it until then.
- It remains in the write-ahead log, in streaming replicas until they replay
  past it, in WAL archives, and in every backup taken while the alias was
  displayable.
- Unlike ciphertext, it is **not covered by key destruction**: destroying or
  rotating `ENCRYPTION_KEY` makes encrypted values unreadable, and does nothing
  to a plain-text copy.

To purge a value that should never have been displayable, delete the journeys
that hold it (`POST /v1/erasures` or `delete:identifier`, `docs/OPERATIONS.md`
section 8), then run `VACUUM` on `entity_aliases` so the dead row versions are
reclaimed. Copies in WAL archives and backups age out under the operator's
retention policy for those, which this service does not control. The same holds
for a label: replacing it leaves the old text in earlier row versions, WAL and
backups until the same cleanup.

## 7. Encryption

At minimum:

- HTTPS for non-local deployment
- encrypted database and backup volumes at the infrastructure layer
- application encryption for stored replay headers
- external encryption key supplied through environment or secret manager

Alias values, entity identifiers, and replay destination headers are already
encrypted at rest with a key derived from `ENCRYPTION_KEY`, in the format and
under the keys ADR-044 describes. A displayable alias also has a plain-text
copy, and a journey label is plain text (section 6). Payloads are not
encrypted, and this is a settled decision rather than an interim state
(ADR-040): redaction, not encryption, is the payload control.

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
- Event content hashes are compared under the key they name, current or
  previous, and are never rewritten: a hash can only be recomputed from the
  event, which is not stored. After the previous key is removed, a duplicate
  delivery of an event whose hash names it is refused with 409
  `event_id_conflict`, which the SDK treats as permanent. The stored event is
  unaffected (ADR-048).
- GCM authentication makes a value under the wrong key fail to decrypt rather
  than produce garbage. A value under a key that is not configured is reported
  with that key's id, once per id, and the API logs a count at boot.
- A replay whose destination headers cannot be decrypted is refused and audited
  as blocked, never sent without them.
- Decrypted destination headers are held in memory for the request being sent.
  A replay run stores and returns them by name with the value `[REDACTED]`, and
  audit rows name blocked headers without values. Encrypting a credential on
  the destination would mean nothing if every run copied it out in the clear,
  which runs written before migration 015 did.
- A destination that echoes its request would put those values back into the
  run through its response. Before a run's response body and error message are
  stored, every occurrence of each destination header value at least 8
  characters long is replaced with `[REDACTED]`: within every string of a JSON
  body, and within a text body or message, in both the raw and the JSON-escaped
  form. That is exact matching, and it has limits. A value shorter than 8
  characters is not replaced. A body cut at the response size cap can end part
  way through a value, and the fragment is not matched. A value the destination
  encodes some other way, such as base64, is not recognised. Responses stored
  before this release are not scrubbed, because a migration has no key to
  decrypt the headers it would have to look for.

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
- destination header values are sent, never stored with the run or returned

`REPLAY_ALLOWED_HOSTS` is the load-bearing control. Replay deliberately allows
private addresses, because every development destination is one, so the list is
all that limits where an admin token can make the API send a request. A host
matches exactly, on any port. `host.docker.internal` reaches every service on the
Docker host, and `localhost` is the API's own container. The published Compose
file and the Helm chart default to `localhost` alone; a production installation
should set a minimal explicit list (`OPERATIONS.md` §9).

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

Propagation does not cross environments. A journey id propagated from a service
in one environment to one in another is refused at ingestion with
`journey_environment_mismatch`, and the receiving service's events for it are not
stored; the receiving service should start a journey of its own.

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

A deletion's audit row is written in the same transaction as the delete, so
data never leaves without a record. An erasure's row records the search token
of the erased identifier under the current key, and counts, **never the
identifier itself**: the identifier is the personal data the erasure removed,
and an audit trail that kept it would be the one place it survived. A later
erasure of the same value produces the same token, so the two rows can be
matched without storing what they erased. A replay destination's creation and
deletion record its name, not its base URL, which can carry credentials or name
a host the operator considers internal (ADR-045). **Audit rows written before
this change record the base URL at creation**, and deleting the destination does
not remove them; `OPERATIONS.md` §8 gives the statement that strips the URL
from them.

## 14. Retention

- default to short local retention
- configure per environment
- delete in bounded batches
- document backup implications
- ensure deleted aliases and payloads are removed
- avoid retaining replay responses longer than the source environment requires

### Deletion on demand

Retention is not the only way out. An operator can delete one journey, every
journey matching an identifier (an erasure request, or the rows a redaction miss
wrote), an environment's time window, or a replay destination
(`OPERATIONS.md` §8).

- Deletion is hard: rows are deleted, and a journey's events, aliases, and replay
  runs go with it. A soft delete would keep what the operator asked to remove.
- Only the admin token, a signed-in web session, and the database CLI can delete.
  An API key cannot: it sits in application configuration on many servers, and a
  leaked one must not be able to erase the record of what it sent.
- Erasure matches the identifier's search tokens under every configured key, so
  it finds journeys still under the previous key during a rotation.
- Erasure matches an entity id or an alias, which is what search finds, and
  nothing else. An identifier that appears only inside a payload, such as an
  email address in `input` that was never recorded as an alias, is not matched,
  so an erasure request for it deletes nothing and reports zero journeys. Finding those
  journeys is the operator's work, and deleting each is `delete:journey`
  (`OPERATIONS.md` §8). An erasure that scans payloads is not built.
- Deleted rows remain in PostgreSQL's files until vacuum, and in every backup
  taken before the deletion. The documentation says so rather than implying
  otherwise.

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
