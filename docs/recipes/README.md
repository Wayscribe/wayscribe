# Recipes

Short guides to instrumenting a common stack: what to record, where, and the
code. Each assumes you have read the SDK's
[Record a journey](../../packages/sdk-node/README.md#record-a-journey) and have
a key from `key:create`.

| Recipe | Stack | Shows |
| --- | --- | --- |
| [Express, BullMQ and HubSpot](express-bullmq-hubspot.md) | webhook in, queue, worker, CRM call | an envelope around job data, retries by attempt, a terminal failure from BullMQ's `failed` event, redacting personal fields |
| [Fastify, SQS and Salesforce](fastify-sqs-salesforce.md) | HTTP in, queue, consumer, CRM upsert | HTTP headers and SQS attributes as carriers, the receive count as the attempt, a displayable alias |
| [Next.js route handlers and Stripe webhooks](nextjs-stripe.md) | serverless webhook | a journey id derived from the order, flushing with `after`, Stripe's signature header redacted by default |

## The code is checked

Every code block on these pages is taken from a project under
[`examples/recipes/`](../../examples/recipes), and
`tests/recipes-typecheck.test.ts`, part of `pnpm test`, checks two things:

- each project type-checks against the SDK's source, with the repository's
  strict compiler settings (`strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`), so a recipe that calls the SDK in a way it no
  longer accepts fails the build;
- each `typescript` block on a recipe page appears, as written, in that
  project's code.

The frameworks are not installed. Express, BullMQ, Fastify, the AWS SQS client,
Stripe and `after` from `next/server` are replaced by small type stubs in
`examples/recipes/stubs/`, which declare only what the recipes use, in the
shape of the real packages' types. A Next.js route handler needs nothing else:
it takes and returns the standard `Request` and `Response`. The stubs keep the
check inside this workspace and fast; the cost is that they are written by
hand, so a change in a framework's own API is not caught here.

To use a recipe in your application, install the packages its `package.json`
lists, and replace its `tsconfig.json` with your own: the one here points the
SDK at this repository's source and includes the stubs.

## Experimental parts

The recipes use parts of the SDK marked experimental, which may change in a
minor release before 1.0
([Stability](../../packages/sdk-node/README.md#stability)):

- the propagation helpers: `injectHttpHeaders`, `extractHttpContext`,
  `injectSqsAttributes`, `extractSqsContext`, `injectPayload`, `extractPayload`
- `label`, the method and the option
- `journeyIdFor` and `journeyIdSecret`
- `captureInput` and `captureOutput`
- the fields of `counters()`, to which new counters may be added
