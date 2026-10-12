import { normalizeKey, pairChanges } from "@wayscribe/payload-diff";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_JOURNEY_EVENTS_FOR_CAUSES,
  findLikelyCauses,
  type CauseEvent
} from "./likely-cause.js";

// Counts the calls `findLikelyCauses` makes; `pairChanges`' own calls to
// `normalizeKey` stay inside the package and are not counted.
vi.mock("@wayscribe/payload-diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wayscribe/payload-diff")>();
  return {
    ...actual,
    normalizeKey: vi.fn(actual.normalizeKey),
    pairChanges: vi.fn(actual.pairChanges)
  };
});

/**
 * A Salesforce sync step that rewrote every opportunity line: `lines` changes,
 * each `Opportunity_Lines__c[i].Quantity__c`, two keys per path.
 */
const syncStep = (index: number, lines: number): CauseEvent => ({
  id: `evt_sync_${String(index)}`,
  step: "sync-opportunity-lines",
  failed: false,
  fields: undefined,
  diff: {
    changes: Array.from({ length: lines }, (_, line) => ({
      path: `Opportunity_Lines__c[${String(line)}].Quantity__c`,
      kind: "changed",
      before: line,
      after: line + 1
    })),
    truncated: false
  }
});

/** Fields no step changed, so every candidate diff is searched to the start. */
const unmatchedFields = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `BillingAddress.Line_${String(index)}__c`);

/** `diffs` sync steps, one failure naming `fields`, then `inheriting` dead-letter retries. */
function journey(diffs: number, lines: number, fields: number, inheriting: number): CauseEvent[] {
  return [
    ...Array.from({ length: diffs }, (_, index) => syncStep(index, lines)),
    {
      id: "evt_deliver",
      step: "deliver-account-to-erp",
      failed: true,
      fields: unmatchedFields(fields),
      diff: null
    },
    ...Array.from({ length: inheriting }, (_, index) => ({
      id: `evt_retry_${String(index)}`,
      step: "retry-account-delivery",
      failed: true,
      fields: undefined,
      diff: null
    }))
  ];
}

describe("findLikelyCauses at scale", () => {
  beforeEach(() => {
    vi.mocked(normalizeKey).mockClear();
    vi.mocked(pairChanges).mockClear();
  });

  it("pairs and splits each diff once, and searches once per reporter", () => {
    const diffs = 40;
    const lines = 50;
    const fields = 5;
    const causes = findLikelyCauses(journey(diffs, lines, fields, 40));

    expect(causes.size).toBe(41);
    expect(causes.get("evt_retry_39")).toEqual([]);
    expect(vi.mocked(pairChanges)).toHaveBeenCalledTimes(diffs);
    // Two keys in every change's path, two in every field's: each normalized once.
    expect(vi.mocked(normalizeKey)).toHaveBeenCalledTimes(diffs * lines * 2 + fields * 2);
  });

  it("answers the largest journey it accepts within a request's budget", () => {
    const events = journey(500, 500, 20, 499);
    expect(events).toHaveLength(MAX_JOURNEY_EVENTS_FOR_CAUSES);

    const started = performance.now();
    const causes = findLikelyCauses(events);
    const elapsed = performance.now() - started;

    expect(causes.size).toBe(500);
    expect(causes.get("evt_retry_498")).toEqual([]);
    expect(vi.mocked(pairChanges)).toHaveBeenCalledTimes(500);
    expect(elapsed).toBeLessThan(2_000);
  });
});
