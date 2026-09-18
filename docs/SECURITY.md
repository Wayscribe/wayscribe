# Security

## 1. Security posture

Wayscribe may receive customer records, API requests, errors, identifiers, and internal system metadata.

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

Where redaction runs today:

1. in the SDK, before an event is queued;
2. on the server, before an event is stored, whoever sent it;
3. before a replay is sent, in effect: a replay sends the input as it was
   stored, so it carries the stored redaction (ADR-032);
4. before a replay's response is stored, for the destination's own header
   values only (section 7); name rules are not applied to a response body;
5. before any AI provider request, of which there are none (section 15).

Server policy is authoritative and may capture less data than the SDK requests.

A replacement keeps the evidence that a value existed:

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

### Names no rule covers

Because a rule matches a name, a credential under a name that neither the
built-in list nor an operator's rules name is stored in plain text. Renaming
`authToken` to `sessionCredential` is enough. Nothing redacts such a value on a
guess: a heuristic that replaced values would change what the timeline and its
diffs show, which is the evidence this product exists to keep (ADR-055).
Instead it is reported, in two places:

- **The Node SDK**, as it records. When redaction keeps a name that looks like
  a secret, under an object key or in one of the header shapes above, with a
  value that could be a credential, the SDK reports `unredacted_secret_name`
  with the field, the name and its path (array indices as `[*]`), never the
  value. It reports only for payloads the event still carries once it fits the
  server's budget, prints one line per process and name even with debug output
  off, and sends the event unchanged (SDK-61). The printed line is masked;
  `onDiagnostic` receives the name as written, cut to 128 characters, as it
  receives other diagnostics.
- **`doctor`**, for every sender, from what was stored. It samples the latest
  events of every environment's most recently active journeys and lists the
  secret-looking key names that hold plain values, with how many sampled events
  hold each, and no value (`OPERATIONS.md` §12).

A name looks like a secret when its end, with case, `-`, `_` and a version
suffix ignored, is one of a fixed list of terms such as `token`, `secret`,
`password`, `credential`, `auth`, `cookie`, `signature`, `apikey`,
`privatekey`, `connectionstring` or `dsn`; the full rule is in `SDK_SPEC.md`
section 13. Names that only start with a term (`tokenCount`), pagination,
cancel and tokenizer tokens (`nextPageToken`, `cancelToken`, `eos_token`),
objects, booleans, empty strings, setting words such as `none` or `basic`, and
strings under 8 characters under a name ending in `auth` are not reported.
Personal data such as `ssn` is not a term: whether it is captured is the
capture mode's question.

Webhook signature headers (`stripe-signature`, `x-hub-signature`,
`x-hub-signature-256`, `x-slack-signature`, `x-hubspot-signature`,
`x-hubspot-signature-v3`, `x-twilio-signature`, `x-shopify-hmac-sha256`) are on
the built-in list rather than warned about. A signature is not the signing
secret, but stored beside its body it is a request the receiver accepts, and
GitHub's has no timestamp, so the pair stays valid for as long as the secret
does.

What to do about a name reported:

- **It holds a secret.** Add `**.<name>` to the SDK's `redact` option, or to the
  environment's `redaction_paths` column for another sender, which the server
  applies in every mode but effective full capture. New values are replaced
  from then on. Values already stored stay until retention removes them or they
  are deleted (`OPERATIONS.md` §8). A name containing `.`, `*`, `[` or `]`
  cannot be named by any rule: rename the field, or leave it out of what is
  recorded.
- **It does not.** Add the name, as written, to the SDK's `knownSafeNames`,
  which silences the SDK's warning and changes nothing about redaction. `doctor`
  has no such list: its check is a warning and never changes its exit code.

The warning narrows the gap and does not close it. A credential under a name
the rule does not know, such as `plaintext`, is still stored and still
unreported, and doctor reads a sample rather than every event.

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
  `npm_`, SendGrid `SG.`, Hugging Face `hf_`, and Wayscribe `wsk_` keys
  (and `fr_` keys, the form issued before the rename)

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

What is built:

- A key is `wsk_` and 24 random bytes in base64url, 192 bits
  (`packages/payload-security/src/api-key.ts`), 36 characters in all. Keys
  issued before the rename to Wayscribe start `fr_` (35 characters) and still
  authenticate: the server looks a key up by its first 12 characters and
  verifies an HMAC of the whole key, so it never checks which prefix a key has
  (ADR-057).
- `key:create` prints the full key once. Only its first 12 characters, the
  prefix, and an HMAC-SHA256 verifier under a subkey of `ENCRYPTION_KEY` are
  stored, so a database read alone cannot verify a guess.
- A key is scoped to one project and one environment. The composite foreign
  key on `api_keys` makes a key for another project's environment
  unrepresentable.
- `key:revoke` revokes a key by its prefix, and a revoked key answers 401.
- Verification compares with `timingSafeEqual`.
- Keys are not logged: request headers are not logged at all, and the logger
  also censors `authorization`, `x-api-key` and `x-wayscribe-api-key`
  (`OPERATIONS.md` §13, Logs).
- `last_used_at` records when a key last authenticated; nothing about the
  request is kept with it.
- Issuing and revoking a key each write an audit row (section 13).

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
  A trigger, `entity_aliases_clear_masked_display_value`, clears the copy of
  any row written masked before the check runs. It is there for the previous
  API during an upgrade: that build lowers the flag without clearing a copy it
  does not know about, and without the trigger the statement would fail and
  its database error, which prints the row, would log the value it was
  masking. With it, masking succeeds and the copy goes in the same statement.
  A value containing a NUL gets no copy, since a text column cannot hold one;
  it stays encrypted only, as every alias was before copies existed.

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

### Where the key and the admin token live at runtime

On the Compose install paths `ENCRYPTION_KEY` and `ADMIN_TOKEN` are container
environment variables, which means they are in the container's `Config.Env` and
readable by anything that can run `docker inspect` or `docker compose config` on
the host. That is the same access needed to start the stack at all, so on those
paths Docker access to the host is equivalent to holding the encryption key and
the admin token. Read "not a published default", which `doctor` checks, as
saying the value is not public, not that it is not exposed.

`ENCRYPTION_KEY_FILE`, `ENCRYPTION_KEY_PREVIOUS_FILE` and `ADMIN_TOKEN_FILE`
read each value from a file at startup instead, and
`infrastructure/compose.secret-files.yaml` mounts those files with Docker's own
secrets mechanism (docs/OPERATIONS.md §6). A Helm install does the equivalent
with `existingSecret`. Either way the value is still readable by anything that
can read the mounted file or enter the running container: this narrows what an
inspection of the container's configuration reveals, and narrows nothing else.

Giving both a variable and its `_FILE` is refused at startup, by name and with
no value printed, rather than one silently winning. An empty file is refused
too, because reading it as an unset setting would start the stack on a published
development default.

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

Every read and write the API makes is scoped by the authenticated project, and
the schema's composite keys make a row that crosses projects unrepresentable
(ADR-020, ADR-038). Integration tests attempt cross-project access for:

- search (`search.integration.test.ts`, "excludes another project's journeys")
- journey and event reads (`queries.integration.test.ts`, "returns 404 for
  another project's journey and event")
- replay runs (`replays.integration.test.ts`, "does not return another
  project's replay")
- deleting a journey or a replay destination (`deletions.integration.test.ts`)
- API keys (`schema.integration.test.ts`, "rejects an API key whose
  environment belongs to another project")

Audit events have no read route. `listAudit` takes a project id, and only tests
call it.

## 9. Replay security

What is built (ADR-008, ADR-019, ADR-032, ADR-033):

- A destination's `environmentType` must be `local`, `development` or `test`;
  anything else is refused when it is created.
- A replay goes only to a destination an admin created. The request names the
  destination by id and a relative path under its base URL.
- The destination's host must be on `REPLAY_ALLOWED_HOSTS` (below).
- A replay sends the recorded input with only these headers: the destination's
  own configured headers, `content-type`, Wayscribe's `user-agent`, and
  `x-wayscribe-replay: true`. Nothing from the recorded request's headers is sent,
  so no authorization header, cookie or webhook signature is copied.
- The request times out after 10 seconds, and at most 256 KiB of the response
  is read (`apps/api/src/replay/send.ts`). The request body is the recorded
  input, which ingestion already bounded (`INGESTION_CONTRACT.md` §3).
- Every replay that reaches a destination decision is stored as a run and
  audited as `replay.completed`, `replay.failed` or `replay.blocked`. A request
  refused before that (an unknown event, an event with no captured input, a
  disabled destination, a malformed body) is answered 4xx and not audited.
- The web interface shows the payload before it is sent, and cannot edit it.
- Destination header values are sent, and never stored with the run or
  returned.

`REPLAY_ALLOWED_HOSTS` is the load-bearing control. Replay deliberately allows
private addresses, because every development destination is one, so the list is
all that limits where an admin token can make the API send a request. A host
matches exactly, on any port. `host.docker.internal` reaches every service on the
Docker host, and `localhost` is the API's own container. The published Compose
file and the Helm chart default to `localhost` alone; a production installation
should set a minimal explicit list (`OPERATIONS.md` §9).

The header policy also drops these names from any caller-supplied header, and
stores them as `[REDACTED]` wherever they appear in a run
(`apps/api/src/replay/header-policy.ts`). `POST /v1/replays` accepts no caller
headers today, so the list guards the day it does. The list is fixed; a
project cannot extend it.

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

## 10. Propagation security

What the Node SDK propagates, by its `propagation` setting:

- `journey-only`: the journey id.
- `journey-and-type`, the default: the journey id and the entity type.
- `full`: those and the entity id, which is otherwise never sent.

Aliases are never propagated, at any level. Trace context is not written:
OpenTelemetry owns `traceparent` (ADR-010). The setting belongs to each
recorder, so a service that should send only the journey id sets
`propagation: "journey-only"`.

Propagation does not cross environments. A journey id propagated from a service
in one environment to one in another is refused at ingestion with
`journey_environment_mismatch`, and the receiving service's events for it are not
stored; the receiving service should start a journey of its own.

## 11. Input limits

Ingestion enforces a request body limit, at most 100 events in a batch, 262,144
bytes per envelope by default, 32 levels of nesting, 1,000 keys or elements per
object or array, and 65,536 UTF-16 code units per string. Metadata counts
toward the envelope's size, and a metadata key is at most 128 code points. The
normative table, checked against the code, is `INGESTION_CONTRACT.md` §3. The
size and structural limits are checked before anything walks the payload.
Replay reads at most 256 KiB of a response and waits at most 10 seconds
(section 9).

## 12. SDK resilience and safety

What the Node SDK does (its README, "It cannot break your application"):

- a bounded event queue, 1,000 events by default, that drops the oldest
- a recorder failure is counted, never thrown, and printing a diagnostic never
  throws
- recording never waits on the network; sending happens in the background
- a cycle is stored as `[CIRCULAR]`
- a cut string ends in `[TRUNCATED: <n> characters removed]`, and a replaced
  payload reads `[PAYLOAD_TOO_LARGE]` or `[UNCAPTURABLE]`
- the wrappers and `fail` send no stack; `record()` sends one only if the
  caller passes it
- every undelivered event is counted in `dropped`, with a diagnostic code
  saying why

## 13. Audit events

What writes an `audit_events` row, checked on 2026-09-16 against every call to
`recordAudit`:

| Action | Written by |
| --- | --- |
| `api_key.created` | `key:create` |
| `api_key.revoked` | `key:revoke` |
| `replay_destination.created` | `POST /v1/replay-destinations` |
| `replay_destination.deleted` | `DELETE /v1/replay-destinations/:destinationId`, `delete:destination` |
| `replay.completed`, `replay.failed`, `replay.blocked` | `POST /v1/replays` (section 9) |
| `journey.deleted` | `DELETE /v1/journeys/:journeyId`, the journey page, `delete:journey` |
| `erasure.completed` | `POST /v1/erasures`, `delete:identifier` |
| `range.deleted` | `delete:range` |

`tests/docs-audit-actions.test.ts` holds this table to the code. An action
taken through the API records the actor `admin`, and one taken through the
database CLI records `cli`. The key rows name the key by its prefix and never
hold the key. Keys the development seeds create (`db:seed`, and the demo's
bootstrap) are not audited.

What is **not** audited: changes to an environment's capture mode, redaction
paths, allowlist and retention. No code path changes them. They are changed
with SQL on `environments` (`OPERATIONS.md` §7), which leaves no audit row, as
does any other change made directly in the database. There is no route that
updates a replay destination.

Audit metadata passes through the built-in secret names before it is stored
(`packages/database/src/repositories/audit.ts`).

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

- An environment keeps journeys for its `retention_days`: 7, unless
  `DEFAULT_RETENTION_DAYS` said otherwise when the environment was created.
- The sweep runs hourly in the API process and deletes at most 1,000 journeys
  per transaction (`OPERATIONS.md` §7).
- Deleting a journey deletes its events with their payloads, its aliases, and
  the replay runs of its events with their stored responses, by cascade.
- `OPERATIONS.md` §2 and §8 say what backups keep.
- `audit_events` is not swept (`ROADMAP.md`, Known open).

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

Each item, and where it is checked, as of 2026-09-16:

- Project isolation tests pass: section 8.
- API keys are never stored in plaintext: section 5, and `api-key.test.ts`.
- The default capture mode is `redacted-payload`: migration 002, held by
  `tests/security-review.test.ts`.
- Redaction occurs before persistence: section 4, `redact.test.ts`, and the
  `wire` conformance cases.
- Common secret headers are filtered: the built-in list in
  `default-secrets.ts`.
- Payload and batch limits are enforced: section 11, held by
  `tests/docs-truth.test.ts`.
- Replay cannot target an unapproved host: section 9 and ADR-033.
- Replay cannot copy historical authorization: section 9.
- Audit events are generated: section 13.
- An SDK outage does not fail host operations: the SDK README, "It cannot
  break your application", and `isolation.test.ts`.
- Retention cleanup deletes all related data: section 14, and
  `retention.integration.test.ts`.
- The documentation warns against capturing regulated data: the README's
  "What Wayscribe is not", and `../SECURITY.md`.

The pre-release review of the same date is
[reviews/2026-09-16-security-review.md](reviews/2026-09-16-security-review.md).
