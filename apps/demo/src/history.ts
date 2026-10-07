import { createHash } from "node:crypto";
import { normalizeSearchValue } from "@wayscribe/payload-security";
import { PROTOCOL_VERSION } from "@wayscribe/protocol";
import { TEST_ACCOUNT, type SalesforceAccount } from "./account.js";
import { transformAccount } from "./transform.js";

/**
 * Generated history for the public demo (deploy/demo, ADR-069).
 *
 * The live services stamp every event with the current time, so history cannot
 * come from them. These are the same journeys written straight to the ingestion
 * API with past timestamps: the same services, step names and payloads, and the
 * real, deliberately broken `transformAccount`, so the diff a visitor reads is
 * the one the live stack would record.
 */

export const PINNED_PHONE = "+1 555 0100";
export const PINNED_ACCOUNT_ID = "0018Z00005PIN01";
export const PINNED_JOURNEY_ID = "jrn_demo_pinned_5550100";
export const PINNED_TRANSFORM_EVENT_ID = "evt_demo_pinned_5550100_transform";

/**
 * Backfilled internal customer IDs start here. The live sequence starts at
 * 18492 (customers.ts) and grows by about 1,440 a day, so the two never meet,
 * and `18492` stays the search case DEMO_SCENARIO.md section 9 names.
 */
export const HISTORY_INTERNAL_ID_START = 500_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const FIRST_NAMES = [
  "Avery",
  "Blake",
  "Casey",
  "Devon",
  "Emerson",
  "Finley",
  "Harper",
  "Jordan",
  "Kendall",
  "Logan",
  "Morgan",
  "Parker",
  "Quinn",
  "Reese",
  "Rowan",
  "Sawyer",
  "Skyler",
  "Taylor",
  "Riley",
  "Hayden"
];
const LAST_NAMES = [
  "Alvarez",
  "Brooks",
  "Chen",
  "Delgado",
  "Ellis",
  "Fischer",
  "Garcia",
  "Hughes",
  "Ibarra",
  "Jensen",
  "Kowalski",
  "Lambert",
  "Moreno",
  "Nakamura",
  "Okafor",
  "Patel",
  "Quintero",
  "Russo",
  "Silva",
  "Turner"
];
const AREA_CODES = ["212", "312", "415", "512", "617", "919"];
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface HistoryCustomer {
  account: SalesforceAccount;
  internalCustomerId: string;
  fails: boolean;
  startedAt: Date;
}

export interface HistoryOptions {
  now: Date;
  count: number;
  days: number;
  failureRate: number;
  random: () => number;
  /** Gives up rather than loop forever on a generator that cannot produce new values. */
  maxAttempts?: number;
}

/** One envelope as `POST /v1/events/batch` takes it. */
export interface HistoryEnvelope {
  protocolVersion: string;
  event: HistoryEvent;
}

export interface HistoryEvent {
  id: string;
  journeyId: string;
  environment: string;
  service: string;
  entity: { type: "customer"; id: string };
  operation: string;
  name: string;
  timestamp: string;
  aliases?: Record<string, string>;
  displayableAliases?: string[];
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code?: string };
  metadata?: Record<string, unknown>;
}

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length)] as T;

export function customerName(random: () => number): string {
  return `${pick(FIRST_NAMES, random)} ${pick(LAST_NAMES, random)}`;
}

/** `+1 AAA 555 NNNN`: never the pinned `+1 555 0100`, which has no area code. */
export function phoneNumber(random: () => number): string {
  const line = String(Math.floor(random() * 10_000)).padStart(4, "0");
  return `+1 ${pick(AREA_CODES, random)} 555 ${line}`;
}

function salesforceId(random: () => number): string {
  let suffix = "";
  for (let i = 0; i < 10; i += 1)
    suffix += ID_ALPHABET.charAt(Math.floor(random() * ID_ALPHABET.length));
  return `0018Z${suffix}`;
}

/**
 * About `count` customers whose journeys start inside the past `days` days.
 *
 * Identifiers are deduplicated on `normalizeSearchValue`, the form the pipeline
 * searches and correlates on: two values that normalize alike would land in one
 * journey's search results, and the history would no longer be what it claims.
 * The pinned journey's values and the reference account are reserved.
 */
export function generateHistory(options: HistoryOptions): HistoryCustomer[] {
  const taken = new Set(
    [PINNED_PHONE, PINNED_ACCOUNT_ID, TEST_ACCOUNT.Id, TEST_ACCOUNT.Phone].map(normalizeSearchValue)
  );
  const maxAttempts = options.maxAttempts ?? options.count * 50;
  const span = options.days * DAY_MS;
  const customers: HistoryCustomer[] = [];

  for (let attempts = 0; customers.length < options.count; attempts += 1) {
    if (attempts >= maxAttempts) {
      throw new Error(
        `Generated only ${String(customers.length)} of ${String(options.count)} distinct customers.`
      );
    }
    const id = salesforceId(options.random);
    const phone = phoneNumber(options.random);
    const internalCustomerId = String(HISTORY_INTERNAL_ID_START + customers.length);
    const keys = [id, phone, internalCustomerId].map(normalizeSearchValue);
    if (keys.some((key) => taken.has(key))) continue;
    for (const key of keys) taken.add(key);

    const fails = options.random() < options.failureRate;
    const name = customerName(options.random);
    const status = options.random() < 0.85 ? "Active" : "Prospect";
    // Inside the window, and finished at least an hour before now so the
    // newest history never looks like the live loop's traffic.
    const startedAt = new Date(
      options.now.getTime() - span + Math.floor(options.random() * (span - HOUR_MS))
    );
    const base = { Id: id, Name: name, Phone: phone, Status__c: status };
    customers.push({
      account: fails ? base : { ...base, Phone__c: phone },
      internalCustomerId,
      fails,
      startedAt
    });
  }

  return customers.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

/** One loop run's account: a new id each millisecond, failing at `failureRate`. */
export function loopAccount(now: Date, random: () => number, failureRate = 0.2): SalesforceAccount {
  const phone = phoneNumber(random);
  const base = {
    Id: `001LP${now.getTime().toString(36).toUpperCase()}`,
    Name: customerName(random),
    Phone: phone,
    Status__c: "Active"
  };
  return random() < failureRate ? base : { ...base, Phone__c: phone };
}

const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);

interface Step {
  offsetMs: number;
  service: "demo-integration" | "demo-worker";
  operation: string;
  name: string;
  fields?: Partial<HistoryEvent>;
}

/** The steps the live integration and worker record, with their usual spacing. */
function stepsFor(customer: HistoryCustomer, extraAliases: Record<string, string>): Step[] {
  const { account } = customer;
  const transformed = transformAccount(account);
  const messageId = `msg-${hash(account.Id)}`;
  const message = {
    customer: transformed,
    internalCustomerId: Number(customer.internalCustomerId)
  };
  const rejected = {
    status: 422,
    body: { error: { code: "phone_required", message: "A phone number is required." } }
  };
  const steps: Step[] = [
    {
      offsetMs: 0,
      service: "demo-integration",
      operation: "received",
      name: "receive-salesforce-webhook",
      fields: { input: account }
    },
    {
      offsetMs: 12,
      service: "demo-integration",
      operation: "transformed",
      name: "transform-salesforce-account",
      fields: { input: account, output: transformed, durationMs: 1 }
    },
    {
      offsetMs: 35,
      service: "demo-integration",
      operation: "persisted",
      name: "persist-customer",
      fields: { input: transformed, output: Number(customer.internalCustomerId), durationMs: 18 }
    },
    {
      offsetMs: 40,
      service: "demo-integration",
      operation: "identified",
      name: "identify",
      fields: {
        aliases: {
          salesforceAccountId: account.Id,
          internalCustomerId: customer.internalCustomerId,
          ...extraAliases
        },
        ...(Object.keys(extraAliases).length === 0
          ? {}
          : { displayableAliases: Object.keys(extraAliases) })
      }
    },
    {
      offsetMs: 55,
      service: "demo-integration",
      operation: "published",
      name: "publish-customer-updated",
      fields: { input: message, output: { messageId }, durationMs: 9 }
    },
    {
      offsetMs: 260,
      service: "demo-worker",
      operation: "consumed",
      name: "consume-customer-updated",
      fields: { input: message, metadata: { messageId } }
    }
  ];

  if (!customer.fails) {
    steps.push(
      {
        offsetMs: 290,
        service: "demo-worker",
        operation: "delivered",
        name: "deliver-customer-to-target",
        fields: {
          input: transformed,
          output: { status: 201, body: { id: account.Id } },
          durationMs: 21
        }
      },
      { offsetMs: 300, service: "demo-worker", operation: "completed", name: "finish" }
    );
    return steps;
  }

  steps.push(
    {
      offsetMs: 290,
      service: "demo-worker",
      operation: "delivered",
      name: "deliver-customer-to-target",
      fields: {
        input: transformed,
        output: rejected,
        durationMs: 19,
        error: {
          message: "deliver-customer-to-target reported a failed result.",
          code: "result_failed"
        }
      }
    },
    {
      offsetMs: 3_310,
      service: "demo-worker",
      operation: "retried",
      name: "retry-customer-delivery",
      fields: {
        input: transformed,
        output: rejected,
        durationMs: 17,
        metadata: { attempt: 2 },
        error: {
          message: "retry-customer-delivery reported a failed result.",
          code: "result_failed"
        }
      }
    },
    {
      offsetMs: 6_330,
      service: "demo-worker",
      operation: "retried",
      name: "retry-customer-delivery",
      fields: {
        input: transformed,
        output: rejected,
        durationMs: 18,
        metadata: { attempt: 3 },
        error: {
          message: "retry-customer-delivery reported a failed result.",
          code: "result_failed"
        }
      }
    },
    {
      offsetMs: 9_400,
      service: "demo-worker",
      operation: "failed",
      name: "move-message-to-dead-letter",
      fields: {
        error: {
          message: "Delivery failed on every attempt; the message moved to the dead-letter queue."
        },
        metadata: { queue: "customer-updates-dlq", messageId }
      }
    }
  );
  return steps;
}

function envelopesFor(
  customer: HistoryCustomer,
  environment: string,
  ids: { journeyId: string; eventId: (index: number, step: Step) => string },
  extraAliases: Record<string, string> = {}
): HistoryEnvelope[] {
  return stepsFor(customer, extraAliases).map((step, index) => ({
    protocolVersion: PROTOCOL_VERSION,
    event: {
      id: ids.eventId(index, step),
      journeyId: ids.journeyId,
      environment,
      service: step.service,
      entity: { type: "customer", id: customer.account.Id },
      operation: step.operation,
      name: step.name,
      timestamp: new Date(customer.startedAt.getTime() + step.offsetMs).toISOString(),
      ...step.fields
    }
  }));
}

/** One backfilled journey's events. Ids are derived, so a rerun is idempotent. */
export function historyEnvelopes(
  customer: HistoryCustomer,
  environment: string
): HistoryEnvelope[] {
  const key = hash(`history:${customer.account.Id}`);
  return envelopesFor(customer, environment, {
    journeyId: `jrn_hist_${key}`,
    eventId: (index) => `evt_hist_${key}_${String(index)}`
  });
}

/**
 * The journey the banner points at: `+1 555 0100`, failed, half an hour old.
 * The phone is an alias, so the search finds it, and is marked displayable so
 * the alias list shows it in full. Recreated with the same ids on every reset,
 * which the smoke check relies on.
 */
export function pinnedEnvelopes(now: Date, environment: string): HistoryEnvelope[] {
  const customer: HistoryCustomer = {
    account: {
      Id: PINNED_ACCOUNT_ID,
      Name: "Dana Whitfield",
      Phone: PINNED_PHONE,
      Status__c: "Active"
    },
    internalCustomerId: String(HISTORY_INTERNAL_ID_START - 1),
    fails: true,
    startedAt: new Date(now.getTime() - 30 * 60 * 1000)
  };
  return envelopesFor(
    customer,
    environment,
    {
      journeyId: PINNED_JOURNEY_ID,
      eventId: (index, step) =>
        step.operation === "transformed"
          ? PINNED_TRANSFORM_EVENT_ID
          : `evt_demo_pinned_5550100_${String(index)}`
    },
    { phone: PINNED_PHONE }
  );
}
