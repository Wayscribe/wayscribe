import type { ContextEnvelope } from "@flight-recorder/node";
import { Queue, type ConnectionOptions } from "bullmq";
import type { Lead } from "./lead.js";

export const connection: ConnectionOptions = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: 6379
};

// A BullMQ job has no headers, so the journey rides in an envelope around the
// job's data.
export type LeadJob = ContextEnvelope<Lead>;

export const leads = new Queue<LeadJob>("leads", { connection });
