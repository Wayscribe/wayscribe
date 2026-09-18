import { z } from "zod";
import { MAX_JOURNEY_LABEL_LENGTH } from "./limits.js";

export { MAX_JOURNEY_LABEL_LENGTH };

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

/** The longest entity type accepted. The list's `entityType` filter refuses a longer one. */
export const MAX_ENTITY_TYPE_LENGTH = 128;

export const entitySchema = z.object({
  type: z.string().min(1).max(MAX_ENTITY_TYPE_LENGTH),
  id: z.string().min(1).max(512)
});

export const errorSchema = z.object({
  type: z.string().max(256).optional(),
  message: z.string().min(1).max(4096),
  code: z.string().max(256).optional(),
  stack: z.string().max(16_384).optional()
});

/**
 * The SDK that recorded an event (F-046, ADR-063). `name` and `version` are
 * required inside it because an `sdk` without them says nothing; an SDK writes
 * them from constants, never from host input. The limits are the protocol's
 * existing ones for the same kind of value: `runtime.version`'s 64 for a
 * version, `deployment.gitCommit`'s 128 for a commit, and 128 for a name.
 */
export const runtimeSdkSchema = z.object({
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  commit: z.string().min(1).max(128).optional()
});

export const runtimeSchema = z.object({
  language: z.string().max(64).optional(),
  version: z.string().max(64).optional(),
  hostname: z.string().max(256).optional(),
  processId: z.number().int().nonnegative().optional(),
  /**
   * Optional and added in 0.1, so the version does not change: a server from
   * before it strips the key as unknown and stores the rest of `runtime`.
   */
  sdk: runtimeSdkSchema.optional()
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

/**
 * The key and value schemas of `aliases` and `metadata`, named rather than
 * inlined.
 *
 * `parseEnvelope` has to validate one key itself, `__proto__`, which `z.record`
 * neither validates nor keeps (see `proto-key.ts`), and a second copy of these
 * rules written there would be the drift that hides the next defect.
 */
export const recordKeySchema = z.string().max(128);

/** As many as an object may have keys, so every alias of one event can be listed. */
export const MAX_DISPLAYABLE_ALIASES = 1_000;
export const aliasValueSchema = z.string().max(512);
export const metadataValueSchema = z.unknown();

export const journeyEventSchema = z.object({
  id: z.string().min(1).max(128),
  journeyId: z.string().min(1).max(128),

  environment: z.string().min(1).max(64),
  service: z.string().min(1).max(128),

  entity: entitySchema,

  operation: journeyOperationSchema,
  name: z.string().min(1).max(256),
  timestamp: isoTimestampSchema,

  aliases: z.record(recordKeySchema, aliasValueSchema).optional(),
  /**
   * Alias types this event marks as displayable in full (ADR-053). A type not
   * in this event's `aliases` is ignored. An alias is shown in full only while
   * every event that stated it marked it.
   */
  displayableAliases: z
    .array(recordKeySchema)
    .max(MAX_DISPLAYABLE_ALIASES)
    .describe(
      "Alias types from this event's aliases that a reader may see in full. Every other alias is masked when read. An alias is shown in full only while every event that stated it listed it here; a type this event's aliases do not name is ignored."
    )
    .optional(),

  /**
   * Public display text for the journey, written by the instrumenting code.
   * Empty is refused rather than read as "clear the label", which the protocol
   * does not offer, so a label cannot be removed by accident.
   */
  journeyLabel: z
    .string()
    .min(1)
    .max(MAX_JOURNEY_LABEL_LENGTH)
    .describe(
      "Public display text for this event's journey, 1 to 200 characters. It is shown and searchable in full, so it must not hold personal data. An event without it leaves the journey's label unchanged."
    )
    .optional(),

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
  metadata: z.record(recordKeySchema, metadataValueSchema).optional()
});

export type JourneyEvent = z.infer<typeof journeyEventSchema>;
