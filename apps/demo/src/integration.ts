import { SendMessageCommand } from "@aws-sdk/client-sqs";
import Fastify from "fastify";
import type { SalesforceAccount } from "./account.js";
import { demoDatabase, upsertCustomer } from "./customers.js";
import { queueUrl, sqsClient, type CustomerMessage } from "./queue.js";
import { demoRecorder } from "./recorder.js";
import { transformAccount } from "./transform.js";

const recorder = demoRecorder("demo-integration");
const db = demoDatabase();
const sqs = sqsClient();

const app = Fastify({ logger: true });

app.get("/health", () => ({ status: "ok" }));

app.post("/webhooks/salesforce", async (request, reply) => {
  const account = request.body as SalesforceAccount;

  const journey = recorder.startJourney({ entity: { type: "customer", id: account.Id } });
  journey.record({
    operation: "received",
    name: "receive-salesforce-webhook",
    input: account
  });

  const customer = await journey.transform("transform-salesforce-account", account, () =>
    transformAccount(account)
  );

  const internalCustomerId = await journey.persist("persist-customer", customer, () =>
    upsertCustomer(db, customer)
  );

  // After the insert, not before: the internal ID does not exist until the row
  // does, and DEMO_SCENARIO.md section 9 requires searching by it.
  journey.identify({
    salesforceAccountId: account.Id,
    internalCustomerId: String(internalCustomerId)
  });

  const message: CustomerMessage = { customer, internalCustomerId };

  await journey.publish("publish-customer-updated", message, async () => {
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl(),
        MessageBody: JSON.stringify(message),
        MessageAttributes: recorder.toQueueAttributes(journey.context())
      })
    );
    return { messageId: sent.MessageId };
  });

  return reply.code(202).send({ journeyId: journey.context().journeyId });
});

await app.listen({ host: "0.0.0.0", port: 3200 });
