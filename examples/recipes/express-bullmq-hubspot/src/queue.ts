import type { PayloadEnvelope } from "@wayscribe/node";
import { Queue, type ConnectionOptions } from "bullmq";
import type { Lead } from "./lead.js";

export const connection: ConnectionOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: 6379
};

// A BullMQ job has no headers, so the journey rides in an envelope around the
// job's data. `PayloadEnvelope` is the envelope with the journey or the one
// without: a recorder that had no context to inject still enqueues the lead,
// and `extractPayload` reads that as data with no context.
export type LeadJob = PayloadEnvelope<Lead>;

export const leads = new Queue<LeadJob>("leads", { connection });
