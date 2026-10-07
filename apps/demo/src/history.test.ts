import { normalizeSearchValue } from "@wayscribe/payload-security";
import { describe, expect, it } from "vitest";
import {
  generateHistory,
  historyEnvelopes,
  loopAccount,
  PINNED_ACCOUNT_ID,
  PINNED_JOURNEY_ID,
  PINNED_PHONE,
  PINNED_TRANSFORM_EVENT_ID,
  pinnedEnvelopes,
  type HistoryEnvelope,
  type HistoryEvent
} from "./history.js";

/** mulberry32: a seeded generator, so a failure here is reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const NOW = new Date("2026-10-07T04:05:00.000Z");
const DAY_MS = 86_400_000;
const options = { now: NOW, count: 300, days: 5, failureRate: 0.2, random: seeded(7) };

const eventsOf = (envelopes: HistoryEnvelope[]): HistoryEvent[] =>
  envelopes.map((envelope) => envelope.event);

describe("generateHistory", () => {
  it("makes the requested number of journeys, all inside the window and before now", () => {
    const history = generateHistory(options);
    expect(history).toHaveLength(300);
    for (const customer of history) {
      const events = eventsOf(historyEnvelopes(customer, "development"));
      for (const event of events) {
        const at = Date.parse(event.timestamp);
        expect(at).toBeGreaterThanOrEqual(NOW.getTime() - 5 * DAY_MS);
        expect(at).toBeLessThan(NOW.getTime());
      }
    }
  });

  it("refuses to emit a duplicate rather than let two journeys share an identifier", () => {
    // A generator stuck on one value makes every candidate collide with the first.
    expect(() =>
      generateHistory({ ...options, count: 2, random: () => 0, maxAttempts: 50 })
    ).toThrow(/Generated only 1 of 2/);
  });

  it("never repeats an identifier on the normalized form the pipeline searches, nor the pinned ones", () => {
    const history = generateHistory(options);
    const seen = new Set([PINNED_PHONE, PINNED_ACCOUNT_ID].map(normalizeSearchValue));
    for (const customer of history) {
      for (const value of [
        customer.account.Id,
        customer.internalCustomerId,
        customer.account.Phone
      ]) {
        const key = normalizeSearchValue(value);
        expect(seen.has(key), value).toBe(false);
        seen.add(key);
      }
    }
  });

  it("fails about a fifth of journeys, the ones whose account lacks Phone__c", () => {
    const history = generateHistory(options);
    const failed = history.filter((customer) => customer.fails);
    expect(failed.length / history.length).toBeGreaterThan(0.12);
    expect(failed.length / history.length).toBeLessThan(0.28);
    for (const customer of history) {
      expect(customer.account.Phone__c === undefined).toBe(customer.fails);
    }
  });
});

describe("historyEnvelopes", () => {
  it("records the live services' steps in time order, ending failed or completed", () => {
    const [failing] = generateHistory({ ...options, failureRate: 1 });
    const [passing] = generateHistory({ ...options, failureRate: 0 });
    for (const [customer, last] of [
      [failing, "failed"],
      [passing, "completed"]
    ] as const) {
      if (customer === undefined) throw new Error("no customer generated");
      const events = eventsOf(historyEnvelopes(customer, "development"));
      const times = events.map((event) => Date.parse(event.timestamp));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(events[0]?.name).toBe("receive-salesforce-webhook");
      expect(events.at(-1)?.operation).toBe(last);
      const transform = events.find((event) => event.operation === "transformed");
      expect(transform?.input).toEqual(customer.account);
      expect((transform?.output as { phone: unknown }).phone).toBe(
        customer.fails ? null : customer.account.Phone__c
      );
    }
  });
});

describe("pinnedEnvelopes", () => {
  it("is the failed journey for +1 555 0100, searchable by the phone, with the phone diff", () => {
    const events = eventsOf(pinnedEnvelopes(NOW, "development"));
    expect(new Set(events.map((event) => event.journeyId))).toEqual(new Set([PINNED_JOURNEY_ID]));
    const identify = events.find((event) => event.operation === "identified");
    expect(identify?.aliases?.["phone"]).toBe(PINNED_PHONE);
    const transform = events.find((event) => event.id === PINNED_TRANSFORM_EVENT_ID);
    expect((transform?.input as { Phone: string }).Phone).toBe(PINNED_PHONE);
    expect((transform?.output as { phone: unknown }).phone).toBeNull();
    expect(events.at(-1)?.operation).toBe("failed");
    expect(Date.parse(events.at(-1)?.timestamp ?? "")).toBeLessThan(NOW.getTime());
  });

  it("is deterministic for a given now", () => {
    expect(pinnedEnvelopes(NOW, "development")).toEqual(pinnedEnvelopes(NOW, "development"));
  });
});

describe("loopAccount", () => {
  it("fails about a fifth of runs and gives each run its own account id", () => {
    const random = seeded(11);
    const accounts = Array.from({ length: 1000 }, (_, i) =>
      loopAccount(new Date(NOW.getTime() + i), random, 0.2)
    );
    const failing = accounts.filter((account) => account.Phone__c === undefined).length;
    expect(failing / accounts.length).toBeGreaterThan(0.15);
    expect(failing / accounts.length).toBeLessThan(0.25);
    expect(new Set(accounts.map((account) => normalizeSearchValue(account.Id))).size).toBe(1000);
    expect(accounts.map((account) => account.Phone)).not.toContain(PINNED_PHONE);
  });
});
