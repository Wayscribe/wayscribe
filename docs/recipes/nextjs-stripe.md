# Next.js route handlers and Stripe webhooks

A storefront built on Next.js receives Stripe's `checkout.session.completed`
webhook in a route handler, verifies it, and marks the order paid. Stripe
delivers again until it gets a 2xx, so one order can see several deliveries.

The complete code, which this repository type-checks against the SDK, is in
[`examples/recipes/nextjs-stripe`](../../examples/recipes/nextjs-stripe).

## What to instrument, and where

| Step | Where | Call | Operation recorded |
| --- | --- | --- | --- |
| The verified webhook arrives | route handler | `journeyIdFor`, `continueJourney`, `record` | `received` |
| Stripe's ids are known | route handler | `identify` | `identified` |
| The order is marked paid | route handler | `persist` | `persisted` |
| The handler is done | route handler | `finish` | `completed` |
| Events leave the function | route handler | `after(() => recorder.flush())` | nothing |

The entity is your order id, which the checkout session carries as
`client_reference_id`. Stripe's session and customer ids become aliases, so a
search for either finds the order's journey.

## The recorder

Create it once per server process. `next dev` reloads modules on every edit, so
the recorder is kept on `globalThis` rather than created again each time.

```typescript
const cache = globalThis as typeof globalThis & { flightRecorder?: Recorder };

export const recorder: Recorder = (cache.flightRecorder ??= createRecorder({
  endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
  apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
  serviceName: "storefront",
  environment: process.env.FLIGHT_RECORDER_ENVIRONMENT ?? "development",
  // Stripe's checkout session carries the buyer's details.
  redact: ["**.customer_details", "**.email"],
  // Experimental: at least 32 bytes, kept like any other credential.
  journeyIdSecret: process.env.JOURNEY_ID_SECRET,
  logDiagnostics: process.env.NODE_ENV !== "production"
}));
```

`journeyIdSecret` is what lets every delivery for one order land on one journey
(below). Without it, `journeyIdFor` returns a random id each time, reports a
`configuration_error`, and prints one warning line per process.

## The route handler

The SDK is written for Node (22.12 or later), so the handler declares the
Node.js runtime rather than the Edge runtime:

```typescript
export const runtime = "nodejs";
```

Verify first. An unverified body can name any order, so nothing is recorded for
it:

```typescript
  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      raw,
      request.headers.get("stripe-signature") ?? "",
      process.env.STRIPE_WEBHOOK_SECRET ?? ""
    );
  } catch {
    // Unverified: nothing in it can be trusted to name a record.
    return new Response("invalid signature", { status: 400 });
  }
```

Then join the order's journey, and make sure the events leave:

```typescript
  const entity = { type: "order", id: orderId };
  const journey = recorder.continueJourney({
    journeyId: recorder.journeyIdFor(entity),
    entity,
    // Experimental. Public text: no ids, no names, no email addresses.
    label: `Checkout ${session.payment_status} · ${formatAmount(session.amount_total, session.currency)}`
  });

  // A serverless function can be frozen once it has answered. `after` runs
  // once the response is sent, success or not, so the events still leave.
  after(() => recorder.flush());
```

- **`journeyIdFor` and `label` are experimental.** The id is derived from the
  entity under your secret, so it is the same on every delivery, every
  instance, and every deploy, and nobody without the secret can compute it.
  Each delivery adds its own `received` step to that one journey, which is what
  happened.
- **Flush before the function is frozen.** The SDK sends in the background, in
  batches, about once a second. On a serverless platform the function may be
  suspended as soon as it has answered, with the batch still queued.
  `after` (from `next/server`, stable since Next.js 15.1) runs once the response
  is finished, and `recorder.flush()` sends what is queued. On a long-running
  `next start` server the flush is harmless.
- The label names the payment state and the amount. It is stored and shown in
  plain text, so it carries no order id, no customer id, and nothing about the
  buyer.

Record what arrived:

```typescript
  // The Stripe-Signature header is on the built-in redaction list, so it is
  // stored as [REDACTED]; the signature and the body together would be a
  // request your endpoint accepts.
  journey.record({
    operation: "received",
    name: "receive-stripe-webhook",
    input: { headers: request.headers, event },
    metadata: { stripeEventId: event.id }
  });
```

**Stripe's signature header is redacted by default.** `stripe-signature` is on
the built-in list, with the webhook signature headers of GitHub, Slack, HubSpot,
Twilio and Shopify, so you do not add a rule for it. A `Headers` object is
stored as a plain object, and the redaction applies inside it. Stored, the
input above reads:

```json
{
  "headers": { "content-type": "application/json", "stripe-signature": "[REDACTED]" },
  "event": { "id": "evt_1", "data": { "object": { "customer_details": "[REDACTED]" } } }
}
```

That was taken from a local stack on 2026-09-16 with this recorder's configuration, trimmed
to the fields shown. `**.customer_details` replaces the buyer's name, email and
address as one value; drop it from `redact` only if the environment's capture
mode already keeps payloads out.

The rest of the handler identifies the journey by Stripe's ids and records the
write:

```typescript
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  // Aliases are masked when read; these are customer identifiers.
  journey.identify({
    stripeCheckoutSession: session.id,
    ...(customerId === undefined ? {} : { stripeCustomer: customerId })
  });

  try {
    await journey.persist("mark-order-paid", { orderId, checkoutSessionId: session.id }, () =>
      markOrderPaid(orderId, session.id)
    );
  } catch {
    // Recorded by persist. A 500 makes Stripe deliver it again.
    return new Response("could not record payment", { status: 500 });
  }

  journey.finish();
  return new Response(null, { status: 200 });
```

`persist` rethrows the exact error your write threw, after recording the step
with it, so the handler answers 500 and Stripe delivers again. The next
delivery lands on the same journey, and the timeline shows the failed write,
then the one that worked.

## What you will see

Search for an order id, or paste a Stripe checkout session id. The timeline
shows one `received`, `identified` and `persisted` for each delivery, the
failed ones marked, and `completed` at the end. The Journeys page lists the
journey under its label, such as `Checkout paid · 19.99 USD`.
