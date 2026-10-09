import type { SalesforceAccount } from "./account.js";

/**
 * How a demo journey fails: one definition for the live stack (source, worker,
 * target) and the generated history, so the two cannot drift apart.
 *
 * - `dead-letter`: the demo's defect (DEMO_SCENARIO.md section 4). The
 *   transform drops the phone, the target answers 422 `phone_required`, the
 *   worker retries it, and the queue redrives the message to the dead-letter
 *   queue. The reference and pinned journeys' shape.
 * - `schema-rejected`: a Salesforce picklist value the target's `status` enum
 *   does not know. The target answers 422 `invalid_property_value`, which the
 *   worker knows cannot change between attempts, so it gives up at once.
 * - `timeout`: the target never answers in time. Every attempt times out, the
 *   backoff doubles, and the queue dead-letters the message.
 * - `transform-failed`: the webhook arrives without `Status__c` (field-level
 *   security hides it), and `transformAccount` throws on it.
 * - `persist-failed`: the webhook arrives without `Name`, and the insert breaks
 *   the customer table's `name not null` constraint.
 */
export const FAILURE_SHAPES = [
  "dead-letter",
  "schema-rejected",
  "timeout",
  "transform-failed",
  "persist-failed"
] as const;
export type FailureShape = (typeof FAILURE_SHAPES)[number];

/** Cumulative odds of each shape among failed journeys; the defect stays the commonest. */
const FAILURE_WEIGHTS: readonly (readonly [FailureShape, number])[] = [
  ["dead-letter", 0.4],
  ["schema-rejected", 0.6],
  ["timeout", 0.75],
  ["transform-failed", 0.9],
  ["persist-failed", 1]
];

/** One draw from `random`, so a seeded generator gives the same shapes every run. */
export function failureShape(random: () => number): FailureShape {
  const draw = random();
  return FAILURE_WEIGHTS.find(([, upTo]) => draw < upTo)?.[0] ?? "dead-letter";
}

export function isFailureShape(value: unknown): value is FailureShape {
  return typeof value === "string" && (FAILURE_SHAPES as readonly string[]).includes(value);
}

/** The picklist value the target's `status` enum refuses (`schema-rejected`). */
export const UNMAPPED_STATUS = "Former Customer";

/** The `status` values the target accepts. */
export const TARGET_STATUSES: readonly string[] = ["active", "prospect"];

/**
 * Salesforce IDs the target is slow for (`timeout`). The target keys its
 * slowness on the account, never on a coin toss, so a journey's shape follows
 * from what the source sent.
 */
export const SLOW_ACCOUNT_PREFIX = "001TO";

export function isSlowAccount(externalId: unknown): boolean {
  return typeof externalId === "string" && externalId.startsWith(SLOW_ACCOUNT_PREFIX);
}

/**
 * The account the webhook carries for a journey of this shape, built from one
 * that may or may not carry `Phone__c`. Only `dead-letter` lacks `Phone__c`,
 * the field the broken transform reads; every other failure is something else
 * going wrong with a phone that would have arrived. A field the webhook did
 * not carry is left out rather than set to null, as JSON would deliver it.
 * `undefined` is the journey that completes.
 */
export function accountFor(account: SalesforceAccount, failure?: FailureShape): SalesforceAccount {
  const { Phone__c: _ignored, ...base } = account;
  const withPhone = { ...base, Phone__c: base.Phone };
  switch (failure) {
    case undefined:
      return withPhone;
    case "dead-letter":
      return base;
    case "schema-rejected":
      return { ...withPhone, Status__c: UNMAPPED_STATUS };
    case "timeout":
      return {
        ...withPhone,
        Id: `${SLOW_ACCOUNT_PREFIX}${base.Id.slice(SLOW_ACCOUNT_PREFIX.length)}`
      };
    case "transform-failed": {
      const { Status__c: _hidden, ...rest } = withPhone;
      return rest as SalesforceAccount;
    }
    case "persist-failed": {
      const { Name: _missing, ...rest } = withPhone;
      return rest as SalesforceAccount;
    }
  }
}

/** The target's error bodies. */
export const PHONE_REQUIRED = {
  code: "phone_required",
  message: "A phone number is required."
} as const;

export function invalidStatus(status: string): { code: string; message: string } {
  return {
    code: "invalid_property_value",
    message: `Property "status" has the value "${status}", which is not one of: ${TARGET_STATUSES.join(", ")}.`
  };
}

/**
 * Target error codes the worker treats as permanent: the same payload gets the
 * same answer however often it is sent, so it is not retried. `phone_required`
 * is deliberately not here. Retrying it is the second half of the demo's
 * defect: three attempts at a payload that could never succeed.
 */
export const PERMANENT_TARGET_ERRORS: readonly string[] = ["invalid_property_value"];

/**
 * Queue timing. `RETRY_DELAY_SECONDS` and `MAX_DELIVERIES` are ElasticMQ's
 * `defaultVisibilityTimeout` and `maxReceiveCount` (infrastructure/elasticmq.conf),
 * which a test holds them to.
 */
export const RETRY_DELAY_SECONDS = 3;
export const MAX_DELIVERIES = 3;

/** How long the worker waits for the target before giving up on an attempt. */
export const DELIVERY_TIMEOUT_MS = 6_000;

/** How long the target takes to answer a slow account: well past the worker's timeout. */
export const TARGET_SLOW_RESPONSE_MS = 2 * DELIVERY_TIMEOUT_MS;

/** Seconds to wait after a timed-out attempt: 4, 8, 16. */
export function timeoutBackoffSeconds(attempt: number): number {
  return 4 * 2 ** (Math.max(1, attempt) - 1);
}

/** What `fetch` throws when `AbortSignal.timeout` fires, as the SDK records it. */
export const TIMEOUT_ERROR = {
  message: "The operation was aborted due to timeout",
  type: "TimeoutError"
} as const;

export const DEAD_LETTER_QUEUE = "customer-updates-dlq";

/** The dead-letter step's error, by why the deliveries failed. */
export const DEAD_LETTER_MESSAGES = {
  rejected: "Delivery failed on every attempt; the message moved to the dead-letter queue.",
  timeout: "Delivery timed out on every attempt; the message moved to the dead-letter queue."
} as const;
export type DeadLetterReason = keyof typeof DEAD_LETTER_MESSAGES;

/**
 * What the integration records when the insert breaks `name not null`
 * (`persist-failed`): pg's error, named `error`, with the statement knex
 * prefixes to the message.
 */
export const PERSIST_FAILURE = {
  message:
    'insert into "customers" ("external_id", "name", "phone", "status") values ($1, DEFAULT, $2, $3) on conflict ("external_id") do update set "name" = excluded."name", "phone" = excluded."phone", "status" = excluded."status" returning "id" - null value in column "name" of relation "customers" violates not-null constraint',
  type: "error",
  code: "23502"
} as const;
