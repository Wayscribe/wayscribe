# Phase 5: Demo Services — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** Four demo services, ElasticMQ wiring with a real dead-letter queue, the trigger
command, and the end-to-end test that is the V0 product proof.

## 1. Context

Every phase so far proved a technical property. This one proves the product: a developer
starts the stack, runs one command, and sees where a customer's phone number disappeared —
without instrumenting anything themselves.

`DEMO_SCENARIO.md` section 11 is the release gate.

## 2. Services

| Service | Port | Responsibility |
|---|---|---|
| `demo-source` | 3100 | Simulates Salesforce. `POST /trigger` fires the account webhook. |
| `demo-integration` | 3200 | Receives the webhook, transforms, persists a customer, publishes to the queue. |
| `demo-worker` | — | Consumes, delivers to the target, and watches the dead-letter queue. |
| `demo-target` | 3300 | Simulates HubSpot. `POST /contacts` returns 422 when `phone` is null. |

`demo-integration` and `demo-worker` are instrumented with `@flight-recorder/node`.
The queue hop carries context through SQS message attributes, exercising the Phase 4 path
for real.

`demo-source` and `demo-target` are deliberately **not** instrumented. They stand in for
Salesforce and HubSpot — systems the team using Flight Recorder does not own. A timeline
that covers only the services you control is the honest picture, and building it that way
proves the tool does not need cooperation from either end.

### One package, four processes

All four live in `apps/demo` with four entry points, one `package.json`, and one image.
They share the account fixture, the queue helpers, and the recorder construction; four
near-identical package scaffolds would triple the boilerplate and hide that sharing.
Compose runs the one image four times with different commands.

A fifth entry point, `bootstrap`, runs once before the others: it applies Flight
Recorder's migrations, registers the demo API key, and creates the demo database and its
customer table.

## 3. The defect

```typescript
phone: account.Phone__c ?? null
```

The incoming payload carries `Phone`. The transformation reads `Phone__c`, which does not
exist, so the phone number becomes null.

This stays exactly as `DEMO_SCENARIO.md` section 4 specifies. It should look like the
mistake a real Salesforce mapping actually contains — a plausible field name that is not
the one that arrived.

## 4. Dead-lettering is real

`elasticmq.conf` defines `customer-updates` with a redrive policy targeting
`customer-updates-dlq` and a `maxReceiveCount`. The message is genuinely redelivered,
genuinely fails each time, and genuinely arrives in the dead-letter queue.

The worker polls both queues. A message arriving on the DLQ continues its journey and
records `move-message-to-dead-letter`.

This depends on message attributes surviving redrive, which is how SQS behaves, and on
`ApproximateReceiveCount` being reported so the worker can tell a retry from a first
attempt.

**Both were verified against a running stack rather than assumed.** ElasticMQ preserves
message attributes across redrive, so the dead-letter event joins the journey it belongs
to, and it reports the receive count, so the retries record as `retried` (ADR-022). The
worker keeps an in-process tally as a fallback for the receive count; it was written
before the check and kept afterwards, because it costs two lines and the failure it
guards against is silent.

## 5. Two decisions the documents do not cover

### The demo gets its own database, not its own container

`demo-integration` writes a customer row. That must not sit alongside Flight Recorder's
own tables, which would confuse anyone reading either schema.

A separate `demo` database inside the existing PostgreSQL container, created by the
`demo-bootstrap` service (`apps/demo/src/bootstrap.ts`, a Knex `CREATE DATABASE` guarded
by a `pg_database` check, not an init script), keeps the container count unchanged while
keeping the schemas apart.

### Visibility timeout is seconds, not minutes

`DEMO_SCENARIO.md` section 6 shows 30-second and 60-second gaps between retries. That is
realistic for production and useless for a demo somebody is watching.

The queue uses a short visibility timeout so the whole journey completes in roughly ten
seconds. The retries are real and the delays are real; they are simply compressed.

### The demo API key is fixed, not generated

`seedLocal` issues a random key and prints it once. Demo services cannot read a printed
key, so the demo needs one known in advance.

`packages/payload-security` gains `apiKeyRecord(pepper, apiKey)`, which builds the stored
prefix and verifier for a key the caller already holds; `generateApiKey` is rewritten in
terms of it. The bootstrap registers `DEMO_API_KEY` — a placeholder value in the committed
Compose file — into a `demo` project.

This is a demo convenience and is documented as one. Anywhere a key is issued to a person,
`generateApiKey` remains the entry point.

## 6. Dependencies

`@aws-sdk/client-sqs` and `knex`/`pg` are added to demo applications only.

`compose.yaml` still lists exactly postgres, api, and web. The demo services and ElasticMQ
live in `compose.demo.yaml`, so ADR-012's "PostgreSQL is the only required backing
service" is unaffected.

## 7. Running it

```bash
docker compose -f infrastructure/compose.yaml \
               -f infrastructure/compose.demo.yaml up --build
pnpm demo:trigger
```

Then open the interface and search `0018Z00002ABC`.

## 8. Expected journey

```text
received      receive-salesforce-webhook     demo-integration
transformed   transform-salesforce-account   demo-integration
persisted     persist-customer               demo-integration
identified    identify                       demo-integration
published     publish-customer-updated       demo-integration
consumed      consume-customer-updated       demo-worker
delivered     deliver-customer-to-target     demo-worker      (error, 422)
retried       retry-customer-delivery        demo-worker      (error, 422)
retried       retry-customer-delivery        demo-worker      (error, 422)
failed        move-message-to-dead-letter    demo-worker
```

Ten events. Three delivery attempts, matching `maxReceiveCount: 3` and
`DEMO_SCENARIO.md` section 6's two retries.

`identify` comes after `persist` because `internalCustomerId` — the `18492` of section 5's
alias list, and a required search case in section 9 — does not exist until the row does.
The Salesforce ID is known earlier, but one identify call carrying both aliases beats two
events saying the same thing.

The transformation diff follows ADR-030: the transformation renames every field, so the
defect reads as a pair — `Phone` leaves carrying a value, `phone` arrives null.

## 9. Testing

**Unit.** The transformation is a pure function, so the defect is a unit test: given the
section 3 account, the output carries the name and the status and `phone` is null. That
test fails the moment somebody fixes `Phone__c`, which is the point — Phase 6 replays
against the corrected version, and the demo depends on the broken one.

**End to end.** The test from `DEMO_SCENARIO.md` section 11: start the stack, wait for
readiness, trigger, poll for the journey, then assert the event count and order, the phone
diff, the 422 rejection, the retry events, and the terminal dead-letter state.

It needs Docker Compose rather than a process, so it runs under its own configuration
(`pnpm test:demo`) against an already-running stack, and as a manual CI job alongside the
browser suite. `pnpm test` and `pnpm test:integration` stay unaffected.

Steps 10 through 12 of section 11 — replay — belong to Phase 6 and are not written here.

## 10. Acceptance criteria

- One documented Compose command starts everything.
- `pnpm demo:trigger` produces the journey with no further input.
- Searching `0018Z00002ABC` finds it; searching the Salesforce alias finds it too.
- The timeline shows all ten steps across two services in order.
- The transformation event shows `Phone` leaving with a value and `phone` arriving null.
- The delivery events carry the 422 error.
- The journey ends `failed` after a real dead-letter transition.
- `pnpm test:demo` passes against the running stack.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 11. Not in this phase

Replay (Phase 6), retention, publishing, and the quick start (Phase 7).
