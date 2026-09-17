# What running it found

Every defect below was live in `main`, in code with a passing test suite, and
none was found by a test. Each was found by running the thing against something
nobody had written to make it look good.

They are collected here because the pattern is more useful than any individual
fix.

---

## The one that mattered

The tool's promise is that payloads are redacted before they leave your process.
The built-in secret list held `authorization`, `password`, `api_key` and eight
others, and applied them at every capture point the security model asks for.

It reached two levels deep.

```json
{"items": [{"api_key": "ak_ARRAY_PROOF"}],
 "config": {"headers": {"authorization": "Bearer sk_live_DEPTH3_PROOF"}},
 "request": {"body": {"user": {"password": "hunter2-DEPTH3"}}}}
```

That is the raw contents of `journey_events.input_payload`, read out of
PostgreSQL, after passing through both redaction points in the default capture
mode. `authorization` at depth two was masked. At depth three it was not, and
arrays terminated redaction entirely.

`config.headers.authorization` is the shape every axios error carries, the most
common way a live key reaches a captured payload at all.

It was found in the first sixty seconds of looking at an unrelated problem. The
fix ([ADR-035](DECISIONS.md#adr-035-a-secret-is-identified-by-its-key-name-at-any-depth))
matches a secret by the name it is filed under rather than by where somebody
nested it, and made the list *shorter*: twenty-two rules covering two levels
became eleven covering all of them.

---

## The pattern

Four more surfaced the same day, from the same exercise:

| What | Why it was invisible |
| --- | --- |
| `Map`, `Set`, `Error` stored as `{}` | They have no own enumerable properties, so the walk that enables redaction emptied them. An `Error` (on a debugging tool) lost the two fields that say what went wrong. |
| Cyclic and `BigInt` payloads discarded | Reported as `payload_too_large`, which sends an operator to raise a limit that could never have helped. |
| A `__proto__` key silently destroyed | `JSON.parse` makes it an ordinary key; assignment spends it on the prototype. The field vanished from the record. |
| A `development` key could read `production` payloads | The environment boundary was enforced on search and on none of the three routes that return data. |

And one more, which is the one that should be most uncomfortable: the README
claimed payloads were **encrypted at rest**. They are `jsonb`. The operations
guide went further and told operators that a `pg_dump` taken without the
encryption key restores unreadable payloads, so following the documented backup
procedure exported every captured customer payload in the clear, while the
document said it had not.

---

## Why the tests did not catch any of it

They all passed. That is the interesting part.

**The test data was written by the same person as the code.** Every payload the
demo emits is flat plain JSON: never a `Date`, never a shared reference, never
an object graph that points back at itself. The first real ORM row exposed three
defects, because a real ORM row is none of those things.

**Several tests asserted the absence of a symptom rather than the presence of
correct behaviour.** A cyclic payload was covered by
`expect(() => checkLimits(cyclic)).not.toThrow()`, which passes while the payload
is silently discarded. A BigInt was covered by `rejected > 0 || stored`, which
passes either way.

**One test covered the boundary next to the broken one.** The suite contained
*"returns 404 for another project's journey and event"*, and it passed, because
composite keys make cross-*project* access structurally impossible. Nothing
tested another *environment* of the same project, which is where the hole was.

**A secret-redaction test proves a rule matches a payload built to fit it.** The
question that mattered was the reverse: whether the shipped list reaches where
real secrets sit. That is a different test, and it did not exist.

---

## What changed as a result

Not just the fixes.

- **Every `not.toContain(secret)` assertion is now paired with a contents
  assertion.** On its own the first passes vacuously: an empty object contains
  no secret either. The pair fails if the data is dropped *or* if it leaks.
- **Regression tests read the row back out of PostgreSQL** rather than checking
  a function's return value, because the two disagreed.
- **Claims the repository can check about itself are tested**
  ([ADR-040](DECISIONS.md#adr-040-the-documentations-checkable-claims-are-tested)):
  the stated ADR count, that ADR numbers run without gaps, and that no document
  claims payloads are encrypted at rest. It caught its own first drift within a
  minute of being written.
- **Fixes are verified by reproducing the original failure**, not by observing
  that a new test passes. Each one above has a recorded before and after against
  a running stack.

---

## The one that came from looking, not running

A later question (can a demo application live in this repository without
shipping?) was answered by listing the image rather than reading the Dockerfile,
and the answer was no.

The API image contained 62 test files, ten source directories, the demo
application and the web application. `apps/api/Dockerfile` ended its build stage
with `COPY --from=build /app /app`, and the comment above it gave a real reason
(keeping the whole tree keeps the paths the documentation uses) that justified
far less than it was taking, since those paths are `dist` paths.

Nothing shipped was reachable. The entrypoint runs `dist`, and the workspace
`exports` maps name `./src/index.ts` only under a `development` condition nothing
passes. But this repository's test fixtures contain credential-shaped strings on
purpose, because they have to look real enough to exercise the parsers, and a
scanner reading a published image cannot tell a fixture from a leak.

Trivy had been scanning these images for days. It answers which packages have
known vulnerabilities, not what is in here that should not be, so the job that
existed to inspect the image was structurally incapable of finding this.

The guard that replaced it ([ADR-043](DECISIONS.md#adr-043-the-runtime-image-carries-only-what-the-runtime-executes))
was then run against an image built *without* the fix, to watch it fail. It
reported two violations and stopped, because `set -e` killed it on the third. A
guard that reports the first problem and hides the rest is the same failure as a
test that asserts nothing, and it was found the same way: by making it fail on
purpose.

---

## The one that was fixed in the middle and broken at both ends

The `__proto__` key in the table above was fixed where the walk lost it: the
redaction walk and the SDK's serializer both write it with `Object.defineProperty`
now, and a unit test reads it back. That was written up as closed.

Writing a conformance case for it, which meant sending the key over HTTP for the
first time rather than calling the functions, found it was closed only in the
middle.

At the far end, the parser still lost it. Zod's `z.record` builds its result by
assigning parsed keys onto a fresh object, so `aliases` and `metadata` came back
without theirs, while `input` and `output` kept theirs because they are
`z.unknown()` and are handed back untouched. That is why it stayed invisible: a
reader looking at a captured payload saw the key, and the alias it was filed
under had quietly gone. Worse, `z.record` does not validate that key's value
either, so `{"__proto__": {"nested": true}}` in `aliases` parsed successfully as
a field the rest of ingestion treats as a string. Restoring the key blindly would
have carried an object into encryption and the search token.

At the near end, the request never arrived. Fastify parses bodies with
`secure-json-parse`, whose defaults throw on `__proto__` and on
`constructor.prototype` anywhere in the document, so the whole request came back
`400`: *Body is not valid JSON but content-type is set to 'application/json'*,
about a body that is valid JSON. The SDK treats a 4xx as permanent and does not
resend, so every event in that batch was lost, for a key the recorder had gone
out of its way to preserve one process earlier.

Three things are worth taking from it:

- **A fix inside a function is not a fix on the wire.** The three earlier fixes
  were correct and were tested at the level they were written at. Nothing had
  ever sent the key through the actual door.
- **A parser that drops a key does not necessarily check it.** The data loss was
  the visible half; the validation hole underneath it was not visible at all,
  and only appeared when the value was deliberately made wrong.
- **A framework default can refuse what the product exists to record.** The
  guard is against a pattern this code deliberately does not have, and it was
  turning a customer's payload into a lost batch.

---

## The honest remainder

Fixing things is easy to write up. Nothing from this account is open now. The
three items this list once held have closed, and each is recorded as a decision
rather than as a promise:

- **Rotating `ENCRYPTION_KEY` was permanently destructive**, because the
  ciphertext envelope carried no key identifier. Every value now names its key,
  and rotation is a grace period with a re-encryption command (ADR-044).
- **There was no way to delete captured data**, so when redaction missed, fixing
  the matcher did nothing about the rows already written. A journey, every
  journey matching an identifier, or an environment's time window can now be
  deleted, each audited and each with a dry run where it selects by criteria
  (ADR-045).
- **Free text inside `error.message` and `error.stack` was not redacted**,
  because path redaction matches key names and cannot reach inside a string.
  That text is now masked by shape in the SDK and at ingestion, and a stack is
  stored only under full capture (ADR-046). Masking by shape catches the common
  credential formats and not an unfamiliar one, which is a narrower gap than
  before rather than none. The tests for it follow the rules above: the stored
  row is read back from PostgreSQL, and every "does not contain the secret" is
  paired with "still contains the error".

The first version of that masker passed all of those tests and was still wrong
in two ways a review found by attacking it rather than reading it. Trimming
trailing dots with `/\.+$/` was quadratic, so `Bearer ` and 64 KiB of dots took
almost two seconds, while a test asserting 16 KiB of near-matches finished under
50 ms passed on a fast machine. And "masking is idempotent" had been checked on
the corpus somebody wrote; generated input broke it three different ways. The
timing tests now compare two sizes instead of reading a clock, and a seeded
generator checks idempotence on text nobody chose.

What is still known to be missing, and not part of this account, is on
[the roadmap](ROADMAP.md).
