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

/**
 * The corrected transformation, reachable for replay only.
 *
 * A separate handler rather than a fix to `transformAccount`: the demo, the
 * end-to-end test, and the whole point of the replay comparison all depend on
 * the original staying broken. This is what `DEMO_SCENARIO.md` section 10 means
 * by "after correcting the transformation" — the correction lives beside the
 * defect so both can be observed at once.
 *
 * Not instrumented. A replay is not a journey; it is an experiment about one.
 */
app.post("/replay/customer", (request, reply) => {
  const account = request.body as SalesforceAccount;
  return reply.code(200).send({
    externalId: account.Id,
    name: account.Name,
    // The fix: `Phone`, which is the field that actually arrives.
    phone: account.Phone,
    status: account.Status__c.toLowerCase()
  });
});

await app.listen({ host: "0.0.0.0", port: 3200 });
