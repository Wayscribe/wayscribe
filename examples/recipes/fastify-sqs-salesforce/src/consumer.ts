import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient
} from "@aws-sdk/client-sqs";
import { parseCustomer } from "./customer.js";
import { createAppRecorder } from "./recorder.js";
import { accountIdOf, toAccount, upsertAccount } from "./salesforce.js";

const recorder = createAppRecorder("salesforce-sync");
const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const queueUrl = process.env.CUSTOMER_QUEUE_URL ?? "";
const maxReceives = 5; // the queue's redrive policy

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

  const accountId = accountIdOf(result);
  if (accountId !== undefined) journey.identify({ salesforceAccountId: accountId });
  journey.finish();
  await sqs.send(
    new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle ?? "" })
  );
}

const stop = new AbortController();
process.once("SIGTERM", () => {
  stop.abort();
});

while (!stop.signal.aborted) {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      // Without these, SQS returns neither the journey nor the receive count.
      MessageAttributeNames: ["All"],
      MessageSystemAttributeNames: ["ApproximateReceiveCount"]
    })
  );
  for (const message of Messages) await handle(message);
}

console.log("flight recorder", await recorder.shutdown());
