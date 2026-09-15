import { z } from "zod";

/** The largest `durationMs` accepted: 2^31 - 1, the most a PostgreSQL `integer` holds (about 24.8 days). */
export const MAX_DURATION_MS = 2_147_483_647;

export const JOURNEY_OPERATIONS = [
  "received",
  "identified",
  "transformed",
  "validated",
  "persisted",
  "published",
  "consumed",
  "delivered",
  "failed",
  "retried",
  "completed"
] as const;

export const journeyOperationSchema = z.enum(JOURNEY_OPERATIONS);
export type JourneyOperation = z.infer<typeof journeyOperationSchema>;

export const entitySchema = z.object({
  type: z.string().min(1).max(128),
  id: z.string().min(1).max(512)
});

export const errorSchema = z.object({
  type: z.string().max(256).optional(),
  message: z.string().min(1).max(4096),
  code: z.string().max(256).optional(),
  stack: z.string().max(16_384).optional()
});

export const runtimeSchema = z.object({
  language: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  hostname: z.string().max(256).optional(),
  processId: z.number().int().nonnegative().optional()
});

export const deploymentSchema = z.object({
  gitCommit: z.string().max(128).optional(),
  version: z.string().max(128).optional(),
  image: z.string().max(512).optional()
});

/**
 * ISO 8601 with an explicit timezone. A timestamp without an offset is ambiguous
 * across services in different zones, which is exactly the correlation this
 * product depends on, so it is rejected rather than assumed to be UTC.
 */
const isoTimestampSchema = z.iso.datetime({ offset: true });

export const journeyEventSchema = z.object({
  id: z.string().min(1).max(128),
  journeyId: z.string().min(1).max(128),

  environment: z.string().min(1).max(64),
  service: z.string().min(1).max(128),

  entity: entitySchema,

  operation: journeyOperationSchema,
  name: z.string().min(1).max(256),
  timestamp: isoTimestampSchema,

  aliases: z.record(z.string().max(128), z.string().max(512)).optional(),

  // Stored in an int4 column. A larger value passed validation and failed the
  // insert, which a batch reported as a transient 500 the SDK resent.
  durationMs: z.number().int().nonnegative().max(MAX_DURATION_MS).optional(),
  parentEventId: z.string().max(128).optional(),

  traceId: z.string().max(128).optional(),
  spanId: z.string().max(128).optional(),
  messageId: z.string().max(256).optional(),
  correlationId: z.string().max(256).optional(),

  input: z.unknown().optional(),
  output: z.unknown().optional(),

  error: errorSchema.optional(),
  runtime: runtimeSchema.optional(),
  deployment: deploymentSchema.optional(),
  metadata: z.record(z.string().max(128), z.unknown()).optional()
});

export type JourneyEvent = z.infer<typeof journeyEventSchema>;
