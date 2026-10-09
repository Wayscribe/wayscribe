import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message
} from "@aws-sdk/client-sqs";
import { deliveryFailure, nextAction, postCustomer, type DeliveryOutcome } from "./delivery.js";
import { optionalEnv } from "./env.js";
import {
  DEAD_LETTER_MESSAGES,
  DEAD_LETTER_QUEUE,
  DELIVERY_TIMEOUT_MS,
  type DeadLetterReason
} from "./failures.js";
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

/**
 * Why each in-flight customer's deliveries failed, keyed by external ID, so the
 * dead-letter step can say whether they were refused or timed out. The body
 * survives the redrive unchanged, and one process sees every delivery.
 */
const lastFailure = new Map<string, DeadLetterReason>();

/**
 * Received messages stay invisible long enough to outlast a timed-out
 * delivery; after each attempt the worker sets the delay before the next one.
 */
const MAIN_VISIBILITY_SECONDS = Math.ceil(DELIVERY_TIMEOUT_MS / 1000) + 4;

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
    context: recorder.extractSqsContext(message.MessageAttributes),
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

  let outcome: DeliveryOutcome;
  try {
    const result = await journey.deliver(
      attempt === 1 ? "deliver-customer-to-target" : "retry-customer-delivery",
      body.customer,
      () => postCustomer(targetUrl, body.customer),
      // A 422 is a failure the target reports rather than throws, which is
      // exactly what `isFailure` exists for (ADR-022).
      { isFailure: deliveryFailure, attempt }
    );
    outcome = { kind: "result", result };
  } catch (error) {
    // The SDK has already recorded the attempt with its error: a timeout, most
    // often, since the target is slow for some accounts.
    outcome = { kind: "threw", error };
  }

  const action = nextAction(outcome, attempt);
  if (action.kind === "delete") {
    // A success, or a rejection no retry can change. Anything else stays on
    // the queue to be redelivered once its visibility runs out, which is what
    // drives the retries and, eventually, the redrive to the dead-letter queue.
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl(),
        ReceiptHandle: message.ReceiptHandle
      })
    );
    attempts.delete(message.MessageId ?? "unknown");
    lastFailure.delete(body.customer.externalId);
    if (outcome.kind === "result" && outcome.result.status < 400) {
      journey.finish({ status: "completed" });
    }
    return;
  }

  lastFailure.set(body.customer.externalId, action.reason);
  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl(),
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: action.visibilitySeconds
    })
  );
}

async function handleDeadLetter(message: Message): Promise<void> {
  const body = JSON.parse(message.Body ?? "{}") as CustomerMessage;
  const journey = recorder.continueJourney({
    context: recorder.extractSqsContext(message.MessageAttributes),
    entity: { type: "customer", id: body.customer.externalId }
  });

  const reason = lastFailure.get(body.customer.externalId) ?? "rejected";
  lastFailure.delete(body.customer.externalId);
  journey.fail("move-message-to-dead-letter", new Error(DEAD_LETTER_MESSAGES[reason]), {
    metadata: { queue: DEAD_LETTER_QUEUE, messageId: message.MessageId }
  });

  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: deadLetterQueueUrl(),
      ReceiptHandle: message.ReceiptHandle
    })
  );
}

async function poll(
  url: string,
  handle: (message: Message) => Promise<void>,
  visibilityTimeout?: number
): Promise<void> {
  for (;;) {
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageAttributeNames: ["All"],
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          ...(visibilityTimeout === undefined ? {} : { VisibilityTimeout: visibilityTimeout })
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
await Promise.all([
  poll(queueUrl(), handleMain, MAIN_VISIBILITY_SECONDS),
  poll(deadLetterQueueUrl(), handleDeadLetter)
]);
