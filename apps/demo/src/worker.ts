import { DeleteMessageCommand, ReceiveMessageCommand, type Message } from "@aws-sdk/client-sqs";
import { optionalEnv } from "./env.js";
import { deadLetterQueueUrl, queueUrl, sqsClient, type CustomerMessage } from "./queue.js";
import { demoRecorder } from "./recorder.js";

const recorder = demoRecorder("demo-worker");
const sqs = sqsClient();
const targetUrl = optionalEnv("TARGET_URL", "http://demo-target:3300");

/**
 * Attempt counts, keyed by message ID.
 *
 * `ApproximateReceiveCount` is what a real worker should use, and it is read
 * first. ElasticMQ does not always return it, and this worker is a single
 * process that sees every redelivery, so an in-process tally is a sound
 * fallback here in a way it would not be in production.
 */
const attempts = new Map<string, number>();

interface DeliveryResult {
  status: number;
  body: unknown;
}

async function deliver(message: CustomerMessage): Promise<DeliveryResult> {
  const response = await fetch(`${targetUrl}/contacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message.customer)
  });
  return { status: response.status, body: await response.json() };
}

function attemptFor(message: Message): number {
  const messageId = message.MessageId ?? "unknown";
  const reported = Number(message.Attributes?.["ApproximateReceiveCount"]);
  if (Number.isInteger(reported) && reported > 0) return reported;

  const next = (attempts.get(messageId) ?? 0) + 1;
  attempts.set(messageId, next);
  return next;
}

async function handleMain(message: Message): Promise<void> {
  const body = JSON.parse(message.Body ?? "{}") as CustomerMessage;
  const journey = recorder.continueJourney({
    context: recorder.fromQueueAttributes(message.MessageAttributes),
    // The default propagation level omits the entity ID (SECURITY.md section
    // 10), so the consumer supplies the one it already has from the body.
    entity: { type: "customer", id: body.customer.externalId }
  });

  const attempt = attemptFor(message);

  if (attempt === 1) {
    journey.record({
      operation: "consumed",
      name: "consume-customer-updated",
      input: body,
      metadata: { messageId: message.MessageId }
    });
  }

  const result = await journey.deliver(
    attempt === 1 ? "deliver-customer-to-target" : "retry-customer-delivery",
    body.customer,
    () => deliver(body),
    {
      // A 422 is a failure the target reports rather than throws, which is
      // exactly what `isFailure` exists for (ADR-022).
      isFailure: (value) => value.status >= 400,
      attempt
    }
  );

  if (result.status < 400) {
    // Only a success deletes. A failure leaves the message to be redelivered
    // after the visibility timeout, which is what drives the retries and,
    // eventually, the redrive to the dead-letter queue.
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl(),
        ReceiptHandle: message.ReceiptHandle
      })
    );
    attempts.delete(message.MessageId ?? "unknown");
    journey.finish({ status: "completed" });
  }
}

async function handleDeadLetter(message: Message): Promise<void> {
  const body = JSON.parse(message.Body ?? "{}") as CustomerMessage;
  const journey = recorder.continueJourney({
    context: recorder.fromQueueAttributes(message.MessageAttributes),
    entity: { type: "customer", id: body.customer.externalId }
  });

  journey.fail(
    "move-message-to-dead-letter",
    new Error("Delivery failed on every attempt; the message moved to the dead-letter queue."),
    { metadata: { queue: "customer-updates-dlq", messageId: message.MessageId } }
  );

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl(),
      ReceiptHandle: message.ReceiptHandle
    })
  );
}

async function poll(url: string, handle: (message: Message) => Promise<void>): Promise<void> {
  for (;;) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageAttributeNames: ["All"],
          MessageSystemAttributeNames: ["ApproximateReceiveCount"]
        })
      );
      for (const message of response.Messages ?? []) {
        await handle(message);
      }
    } catch (error) {
      // The queue may not be up yet, or may be restarting. Keep polling: a
      // worker that exits on a transient broker error is a worse demo than one
      // that waits.
      console.warn(`[demo-worker] poll failed: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

console.log("[demo-worker] polling");
await Promise.all([poll(queueUrl(), handleMain), poll(deadLetterQueueUrl(), handleDeadLetter)]);
