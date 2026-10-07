import { MAX_BATCH_EVENTS } from "@wayscribe/protocol";
import { backfillWindowProblem, inBatches } from "./batches.js";
import { optionalEnv, requiredEnv } from "./env.js";
import { generateHistory, historyEnvelopes, pinnedEnvelopes } from "./history.js";

/**
 * Writes the public demo's history once, after bootstrap: the pinned journey
 * first, so the smoke check can pass as early as possible, then about 300
 * journeys over the past five days. Exits non-zero on any refusal, so a reset
 * that produced a half-empty demo fails loudly (deploy/demo/host/reset.sh).
 * Not idempotent: rerun only after a reset (down -v). A rerun with different
 * random content conflicts and exits non-zero.
 */
const endpoint = optionalEnv("WAYSCRIBE_ENDPOINT", "http://api:8080");
const apiKey = requiredEnv("WAYSCRIBE_API_KEY");
const environment = optionalEnv("WAYSCRIBE_ENVIRONMENT", "development");
const count = positive("DEMO_HISTORY_JOURNEYS", "300");
const days = positive("DEMO_HISTORY_DAYS", "5");
const retentionDays = positive("DEFAULT_RETENTION_DAYS", "7");

function positive(name: string, fallback: string): number {
  const value = Number.parseInt(optionalEnv(name, fallback), 10);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

const problem = backfillWindowProblem(days, retentionDays);
if (problem !== null) throw new Error(problem);

const now = new Date();
const envelopes = [
  ...pinnedEnvelopes(now, environment),
  ...generateHistory({ now, count, days, failureRate: 0.2, random: Math.random }).flatMap(
    (customer) => historyEnvelopes(customer, environment)
  )
];

let stored = 0;
for (const batch of inBatches(envelopes, MAX_BATCH_EVENTS)) {
  const response = await fetch(`${endpoint}/v1/events/batch`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ events: batch })
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: {
      results?: {
        status: string;
        error?: { code?: string; message?: string };
      }[];
    };
  };
  const results = body.data?.results ?? [];
  const rejected = results.filter((result) => result.status === "rejected");
  if (!response.ok || rejected.length > 0 || results.length !== batch.length) {
    throw new Error(
      `The API refused backfill: HTTP ${String(response.status)}, ${String(rejected.length)} rejected (${rejected
        .map((result) => result.error?.code ?? "unknown")
        .join(", ")}), ${String(results.length)} results for ${String(batch.length)} events sent.`
    );
  }
  stored += batch.length;
}
console.log(
  `[backfill] ${String(stored)} events accepted: the pinned journey and ${String(count)} over ${String(days)} days`
);
