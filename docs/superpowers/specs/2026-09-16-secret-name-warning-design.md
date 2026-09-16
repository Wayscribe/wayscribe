# Secret-looking names that no rule covers: design

Redaction matches a secret by the name it is filed under: the eleven built-in
names, plus the names an operator configures (the SDK's `redact` option, an
environment's `redaction_paths`). A credential filed under any other name is
stored in plain text. Renaming `authToken` to `sessionCredential` is enough.

The owner decided the response: **warn, never redact automatically**. A
heuristic that replaced values would change what the timeline shows on a guess,
and a diff that hides a real change is the failure this product exists to
prevent. Everything else below is decided here, with the reason beside it.

## 1. The heuristic

`looksLikeSecretName(name)` in `packages/payload-security`, exported from the
client-safe `redaction` entry point so the SDK bundle can use it.

### The rule

1. **Fold** the name as redaction does (`normaliseName`: lower case, `-` and
   `_` removed). `X-Auth-Token`, `x_auth_token` and `xAuthToken` are one name.
2. **Drop a version suffix**: trailing digits, and a `v` directly before them.
   `x-hub-signature-256`, `X-HubSpot-Signature-v3` and `password2` are read as
   ending in `signature`, `signature` and `password`.
3. **Match the end of the name** against a fixed table of secret terms. A
   secret name nearly always ends with the noun that makes it secret
   (`stripeWebhookSecret`, `sessionCredential`), and a name that only starts
   with one nearly never is secret (`tokenCount`, `passwordPolicy`,
   `secretName`, `authorName`). Matching the end is what makes the rule
   precise.
4. **Three kinds of term**:
   - a plain term matches the name or any name ending in it (`token`,
     `secret`, `password`, `passwd`, `passphrase`, `passcode`, `credential`,
     `credentials`, `authorization`, `auth`, `bearer`, `cookie`, `cookies`,
     `jwt`, `otp`, `cvv`, `cvc`, and the compound terms below);
   - a term with **exceptions** does not match when the name ends in one of
     the listed words followed by the term: `token` is not a secret after
     `page`, `next`, `continuation`, `pagination`, `sync`,
     `client` or `idempotency` (pagination and idempotency tokens), and
     `signature` is not after `email` (an email signature);
   - a **short term** matches only on its own or after a listed qualifier,
     because English is full of words ending in it: `pin` (not `spin`,
     `hairpin`) matches `pin`, `cardpin`, `atmpin`, `userpin`, `accountpin`,
     `securitypin`, `loginpin`, `newpin`, `oldpin`, `currentpin`; `pwd` matches
     only after a qualifier (`dbpwd`, `userpwd`, `adminpwd`), never alone,
     because `PWD` is the working directory in every environment dump;
     `key` is not a term at all (`monkey`, `publicKey`, `idempotencyKey`,
     `partitionKey`), only the compounds `apikey`, `accesskey`, `secretkey`,
     `privatekey`, `signingkey`, `encryptionkey`, `masterkey`, `sessionkey`,
     `authkey`, `hmackey` and `sharedkey`.
   - further compounds whose last word alone is not a secret: `sessionid`,
     `sessid` (`PHPSESSID`), `secretstring` and `secretvalue` (what AWS
     Secrets Manager returns), `codeverifier` and `clientassertion` (OAuth),
     `authcode`, `authorizationcode`, `otpcode` and `mfacode`.
5. **Not terms**, by decision: bare `session` (a Stripe Checkout session id is
   not a credential), bare `key`, bare `code`, plurals such as `tokens` (LLM
   token counts), `hash` suffixes (`passwordHash` is not the password), and
   personal data such as `ssn` or `cardNumber`, which is a separate question
   from credentials.

The table is fixed and small (41 terms). Terms are looked up by the name's
last three characters, the length of the shortest term, and each candidate is
an `endsWith`, so the cost is linear in the name's length with a small
constant. The version suffix is found by a backward scan, not a regular
expression, which would be quadratic on a long run of digits. The result
depends on the name alone.

### Only a scalar is reported

The walk reports a name only when its value is a non-empty string or a number.
A name that looks secret but holds an object (`auth: { type: "basic" }`,
`credentials: {...}`) is a container whose children are examined in turn, and a
boolean (`hasPassword: true`, `requireAuth`) is never a credential. This removes
the commonest false positives without touching the name rule.

### Covered names are never reported

A value redaction replaced is not reported: the check runs only on keys the
walk kept. A name covered by an any-depth rule (every built-in, and every
configured `**.name`) is therefore never reported anywhere. A name covered by a
scoped rule (`customer.sessionCredential`) is not reported where the rule
applies, and is reported where it does not, because that value is stored in the
clear.

### The table

`secret-name.test.ts` holds 62 true and 70 false positives, drawn
from Stripe, Salesforce, HubSpot, GitHub, AWS, OAuth and Slack payloads and
headers, and a test that every built-in name is reported by the heuristic and
never by the walk.

## 2. Where it runs: the redaction walk

`redact(value, paths, onUnredacted?)` gains an optional third argument, called
with `(name, path)` for each kept key whose name looks secret and whose value is
a scalar. The walk already visits every key and already folds each name, so
the check adds a type test per key and a suffix test for string and number
values, and no second traversal.

The path is the dotted key path from the walked value's root, with every array
index written as `[*]`: `items[*].apiToken`. It is built only when a name is
reported: the walk keeps the current segments on a stack and joins them then.
Nothing else in the walk changes, and without the argument it does exactly
what it did.

## 3. The SDK warning

- **Kind** `unredacted_secret_name`, a `FailureKind`, with `detail`
  `{ field, name, path }`: `field` is `input`, `output` or `metadata`; `name`
  is the key as written; `path` is `field` plus the generalised path. Never the
  value.
- **Reason**: `A field named "<name>" (at <path>) looks like a secret and was
  sent unredacted. If it holds a secret, add "**.<name>" to the redact option;
  if it does not, add "<name>" to knownSafeNames.`
- **Once per distinct folded name**: reported once per recorder, printed once
  per process whatever `logDiagnostics` says (like SDK-56 and SDK-60), and with
  `logDiagnostics` on, printed through the ordinary line exempt from the rate
  limit, so a second name the same minute is not hidden. Both
  sets stop growing at 100 names, so a payload keyed by generated names cannot
  grow the host's memory.
- **Counter** `unredactedSecretNames`: the distinct names this recorder
  reported.
- **When**: inside capture, after redaction, before the event is queued. The
  event is sent unchanged. A payload later omitted for size still reported its
  names, which is right: the host still holds those fields.
- **Never throws**: the observer runs inside capture's existing `try`, and the
  report is wrapped like every other.
- **Printed safely**: through `printDiagnostic`, which masks, strips control
  characters and bounds the line. The name is cut to 128 characters and the
  path to 256 before either is used.

### `knownSafeNames`

A false positive that cannot be quieted prints at every deploy, and the only
way out would be redacting a value that is not secret, which damages the
diffs. So the SDK takes `knownSafeNames: string[]`: plain key names, folded
like redaction, that the warning skips. It changes nothing about redaction: a
name on both lists is still redacted. An entry that is not a string, is empty,
or contains `.`, `*`, `[` or `]` is ignored and reported as a
`configuration_error`, as `redact` does.

## 4. The server: a doctor check

Senders that are not the Node SDK never see the warning, so `doctor` checks
what was stored.

### The sample

Bounded by rows, not by time, so a quiet installation still has something to
read, and every step is an index scan:

1. For each environment, its 100 most recently active journeys
   (`journeys_recent_idx`, `(project_id, environment_id, last_event_at desc)`).
2. For each of those, its 20 latest events (`journey_events_timeline_idx`).
3. At most 2,000 events in all.
4. For each event's `input_payload`, `output_payload` and `custom_metadata`,
   every object at any depth (`jsonb_path_query(doc, 'strict $.**')`), and
   each key of those (`jsonb_each`) whose value is a non-empty string or a
   number and not `"[REDACTED]"`.
5. Grouped by key name: the name, how many sampled events hold it.

Only the key names and counts leave the database. Values are compared with the
marker inside the query and never selected. The heuristic runs in doctor on the
distinct names, so SQL and TypeScript cannot disagree about the rule.

The check runs in a read-only transaction with `SET LOCAL statement_timeout =
'5s'`, so a slow sample is a `FAIL` with SQLSTATE 57014 and its fix, not a stall.

### The output

- `PASS  Secret-looking names  No unredacted secret-looking key in the 2,000
  most recent events sampled.`
- `WARN  Secret-looking names  2 key names that look like secrets hold
  unredacted values in the sampled events: authToken (in 12), sessionCredential
  (in 3).` with `Fix: if they hold secrets, add "**.<name>" to the SDK's redact
  option or the environment's redaction_paths; values already stored remain
  until deleted (docs/OPERATIONS.md §8). If they do not, ignore this warning.`
- At most 10 names are printed, each cut to 64 characters, with "and n more".
- A warning, never a failure: a false positive must not break a script.

Key names can be data (a map keyed by customer email), so only names the
heuristic accepts are printed, and they are bounded.

### Cost

Measured on a seeded database (see the plan) with `EXPLAIN (ANALYZE, BUFFERS)`
and recorded in OPERATIONS.md §12.

## 5. The API: no change

Considered: a response field per event naming unredacted secret-looking keys,
and a log line per new name.

Not adopted:

- A response field is a wire contract change every SDK has to handle, for a
  warning nothing at runtime can act on. A sender cannot fix its redaction
  from a response.
- A log line would put payload-derived names into the API's log stream on the
  ingestion hot path, would need a per-process set bounded against hostile
  senders, and would repeat per API replica. Doctor reads the same facts from
  what was stored, which is the truth an operator needs, at a moment the
  operator chose.
- The ingestion path stays byte for byte what it was: `redactAlways` and
  `applyCapture` do not pass the observer.

Revisit if a pilot team runs a non-Node sender and does not run doctor.

## 6. Conformance

The case format gains an optional `expect.diagnostics`, a list of
`{ "kind": "…", "detail": { … } }` an SDK must report: of the diagnostics
reported whose kind the list names, the kinds must equal the list's in order,
and each `detail` is compared as `wire` is. `sdk/unredacted-secret-name` records a
payload with `sessionCredential` and a nested `authToken`, expects both
diagnostics, and expects the wire to carry both values unchanged beside a
redacted `password`. The API's dry-run harness ignores the field.

## 7. Documents

ADR-055; `SDK_SPEC.md` SDK-61 (the warning) and SDK-62 (`knownSafeNames`),
SDK-40 naming the new exception; `INGESTION_CONTRACT.md` section 9
(`expect.diagnostics`); `SECURITY.md` section 4; `OPERATIONS.md` §12; the SDK
README; `NODE_SDK_SPEC.md` where it lists options and kinds; CHANGELOG; the
README's ADR count.
