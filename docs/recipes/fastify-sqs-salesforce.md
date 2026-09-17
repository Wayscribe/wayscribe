# Fastify, SQS and Salesforce

A Fastify API accepts a customer, saves it, and sends it to an SQS queue. A
consumer upserts it into Salesforce as an Account, and leaves failed messages
for SQS to deliver again until the queue's redrive policy moves them to a
dead-letter queue. A calling service, if it records too, passes its journey in
HTTP headers.

The complete code, which this repository type-checks against the SDK, is in
[`examples/recipes/fastify-sqs-salesforce`](../../examples/recipes/fastify-sqs-salesforce).

## What to instrument, and where

| Step | Where | Call | Operation recorded |
| --- | --- | --- | --- |
| The caller sends the customer | calling service | `deliver`, with `injectHttpHeaders` | `delivered` |
| The request arrives | Fastify route | `extractHttpContext`, `continueJourney`, `record` | `received` |
| Body becomes a customer | Fastify route | `transform` | `transformed`, with the diff |
| The customer is saved | Fastify route | `persist` | `persisted` |
| The message is sent | Fastify route | `publish`, with `injectSqsAttributes` | `published` |
| SQS's message id is known | Fastify route | `identify`, with `displayableAliases` | `identified` |
| The consumer receives it | consumer | `extractSqsContext`, `continueJourney`, `record` | `consumed` |
| Customer becomes an Account | consumer | `transform` | `transformed` |
| Salesforce is called | consumer | `deliver`, with `attempt` from the receive count | `delivered`, or `retried` |
| The last receive failed | consumer | `fail` | `failed` |
| Salesforce's id is known | consumer | `identify` | `identified` |

The propagation helpers (`injectHttpHeaders`, `extractHttpContext`,
`injectSqsAttributes`, `extractSqsContext`) are **experimental**: the header and
attribute names carry the product's current name, which will change.

## The API

```typescript
app.post("/customers", async (request, reply) => {
  const externalId = externalIdOf(request.body);
  if (externalId === undefined) return reply.code(400).send({ error: "externalId is required" });

  // Experimental. A caller that records sent its journey in headers; one that
  // does not sent none, and continueJourney starts a new journey.
  const journey = recorder.continueJourney({
    context: recorder.extractHttpContext(request.headers),
    entity: { type: "customer", id: externalId }
  });
  journey.record({ operation: "received", name: "receive-customer", input: request.body });

  let customer: Customer;
  try {
    customer = journey.transform("parse-customer", request.body, () => parseCustomer(request.body));
  } catch (error) {
    journey.fail("reject-customer", error);
    return reply.code(422).send({ error: "invalid customer" });
  }

  const row = await journey.persist("save-customer", customer, () => saveCustomer(customer));

  // Experimental: the journey travels as SQS message attributes (two of the
  // ten SQS allows, at the default propagation level).
  const sent = await journey.publish(
    "enqueue-salesforce-sync",
    customer,
    () =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(customer),
          MessageAttributes: recorder.injectSqsAttributes({}, journey.context())
        })
      ),
    { metadata: { rowId: row.rowId } }
  );

  // A queue message id is not personal data, so a reader may see it in full.
  if (sent.MessageId !== undefined) {
    journey.identify({ sqsMessageId: sent.MessageId }, { displayableAliases: ["sqsMessageId"] });
  }
  return reply.code(202).send({ accepted: true });
});
```

`continueJourney` does the right thing either way: with a context from a
recording caller it joins that journey, and without one it starts a new one for
the entity. The entity's id does not travel in headers or attributes by default,
because it is often a real customer identifier and would land in the logs of
systems you do not control; each side supplies the id it already has.

Aliases are masked when read. `displayableAliases` shows the SQS message id in
full, because a queue's message id identifies nobody. Never list an email
address or a customer number there.

Stop the recorder when Fastify closes:

```typescript
app.addHook("onClose", async () => {
  await recorder.shutdown();
});
```

## The consumer

```typescript
async function handle(message: Message): Promise<void> {
  const customer = parseCustomer(JSON.parse(message.Body ?? "null"));
  // Experimental. The attributes carry the journey id and entity type; the
  // entity id comes from the body.
  const journey = recorder.continueJourney({
    context: recorder.extractSqsContext(message.MessageAttributes),
    entity: { type: "customer", id: customer.externalId }
  });

  // SQS counts receives; the first is the first attempt.
  const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
  if (attempt === 1) {
    journey.record({
      operation: "consumed",
      name: "consume-customer",
      metadata: { messageId: message.MessageId }
    });
  }
```

Retries happen by redelivery, in whatever process receives the message next, so
the SDK cannot count them. SQS can: `ApproximateReceiveCount` is the attempt
number, and passing it as `attempt` records every receive after the first as
`retried`.

```typescript
  const account = journey.transform("map-customer-to-account", customer, () => toAccount(customer));
  const result = await journey.deliver(
    "upsert-salesforce-account",
    account,
    () => upsertAccount(customer.externalId, account),
    { attempt, isFailure: (answer) => answer.status >= 400 }
  );

  if (result.status >= 400) {
    if (attempt >= maxReceives) {
      // The redrive policy moves it to the dead-letter queue next.
      journey.fail(
        "move-to-dead-letter",
        new Error(`Salesforce answered ${String(result.status)}`),
        {
          metadata: { attempts: attempt }
        }
      );
    }
    return; // not deleted: SQS delivers it again after the visibility timeout
  }
```

**Ask SQS for the attributes.** A receive returns no message attributes, and no
receive count, unless it names them:

```typescript
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      // Without these, SQS returns neither the journey nor the receive count.
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["ApproximateReceiveCount"]
    })
```

Without `MessageAttributeNames`, `extractSqsContext` finds nothing, and every
message starts a journey of its own: the API's steps and the consumer's steps
land on two journeys for the same customer.

## The calling service

If the service that calls the API records too, its journey goes out in headers,
and the API continues it:

```typescript
      fetch(`${process.env.CUSTOMERS_API_URL ?? ""}/customers`, {
        method: "POST",
        // Experimental: the journey goes out in headers, and the API continues it.
        headers: recorder.injectHttpHeaders(
          { "content-type": "application/json" },
          journey.context()
        ),
        body: JSON.stringify(customer)
      }),
    {
      isFailure: (response) => !response.ok,
      // A Response has nothing worth storing; its status does.
      captureOutput: (response) => ({ status: response.status })
    }
```

`captureOutput` is **experimental**. It records the status and still returns
the `Response` to your code.

## Redaction

The recorder redacts `email`, `phone` and `taxId` wherever they appear. The
Salesforce access token is in a request header the recorder never sees.
`onDiagnostic` sends refusals and drops to your logger:

```typescript
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === "rejected" || diagnostic.kind === "dropped") {
        console.warn("wayscribe", diagnostic.kind, diagnostic.code);
      }
    }
```

Match on `kind` and `code`, never on the `reason` text.
