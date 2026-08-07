import { SQSClient } from "@aws-sdk/client-sqs";
import { optionalEnv, requiredEnv } from "./env.js";

/**
 * Queue URLs come from the environment rather than from `GetQueueUrl`.
 *
 * ElasticMQ builds the URLs it returns from its configured `node-address`, so
 * keeping one authority for the address — Compose — avoids a class of failure
 * where the broker hands back a hostname the caller cannot resolve.
 */
export function queueUrl(): string {
  return requiredEnv("QUEUE_URL");
}

export function deadLetterQueueUrl(): string {
  return requiredEnv("DLQ_URL");
}

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: optionalEnv("AWS_REGION", "us-east-1"),
    endpoint: requiredEnv("QUEUE_ENDPOINT"),
    // ElasticMQ ignores credentials, but the SDK refuses to sign without them.
    credentials: { accessKeyId: "local", secretAccessKey: "local" }
  });
}

export interface CustomerMessage {
  customer: { externalId: string; name: string; phone: string | null; status: string };
  internalCustomerId: number;
}
