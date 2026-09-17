import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import fastify from "fastify";
import { type Customer, externalIdOf, parseCustomer, saveCustomer } from "./customer.js";
import { createAppRecorder } from "./recorder.js";

const recorder = createAppRecorder("customers-api");
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const queueUrl = process.env.CUSTOMER_QUEUE_URL ?? "";
const app = fastify({ logger: true });

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

app.get("/internal/recorder", () => recorder.counters());

app.addHook("onClose", async () => {
  await recorder.shutdown();
});

await app.listen({ port: 3000, host: "0.0.0.0" });
process.once("SIGTERM", () => void app.close());
