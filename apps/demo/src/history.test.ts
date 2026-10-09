import { createHash } from "node:crypto";
import { normalizeSearchValue } from "@wayscribe/payload-security";
import { parseEnvelope } from "@wayscribe/protocol";
import { describe, expect, it } from "vitest";
import {
  FAILURE_SHAPES,
  generateHistory,
  historyEnvelopes,
  loopAccount,
  PINNED_ACCOUNT_ID,
  PINNED_JOURNEY_ID,
  PINNED_PHONE,
  PINNED_TRANSFORM_EVENT_ID,
  pinnedEnvelopes,
  type FailureShape,
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

  it("fails about a fifth of journeys; only the dead-letter ones lack Phone__c", () => {
    const history = generateHistory(options);
    const failed = history.filter((customer) => customer.fails);
    expect(failed.length / history.length).toBeGreaterThan(0.12);
    expect(failed.length / history.length).toBeLessThan(0.28);
    for (const customer of history) {
      expect(customer.failure !== undefined).toBe(customer.fails);
      expect(customer.account.Phone__c === undefined).toBe(customer.failure === "dead-letter");
    }
  });

  it("fails in several shapes, with different lengths, spans and last steps", () => {
    const failed = generateHistory(options).filter((customer) => customer.fails);
    const shapes = new Map<string, { count: number; spanMs: number; last: string }>();
    for (const customer of failed) {
      const events = eventsOf(historyEnvelopes(customer, "development"));
      const times = events.map((event) => Date.parse(event.timestamp));
      const shape = {
        count: events.length,
        spanMs: Math.max(...times) - Math.min(...times),
        last: events.at(-1)?.name ?? ""
      };
      // Every journey of one shape looks the same, so one sample stands for it.
      const seen = shapes.get(customer.failure ?? "");
      if (seen !== undefined) expect(shape).toEqual(seen);
      shapes.set(customer.failure ?? "", shape);
      // Every failed journey ends on a step that carries an error.
      expect(events.at(-1)?.error?.message).toBeTruthy();
    }

    expect([...shapes.keys()].sort()).toEqual([...FAILURE_SHAPES].sort());
    const all = [...shapes.values()];
    expect(new Set(all.map((shape) => shape.last)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((shape) => shape.count)).size).toBeGreaterThanOrEqual(2);
    expect(shapes.get("dead-letter")).toEqual({
      count: 10,
      spanMs: 9_400,
      last: "move-message-to-dead-letter"
    });
    expect(shapes.get("schema-rejected")).toMatchObject({
      count: 7,
      last: "deliver-customer-to-target"
    });
    expect(shapes.get("timeout")?.spanMs).toBeGreaterThanOrEqual(30_000);
    expect(shapes.get("timeout")?.spanMs).toBeLessThanOrEqual(90_000);
    expect(shapes.get("transform-failed")).toMatchObject({
      count: 2,
      last: "transform-salesforce-account"
    });
    expect(shapes.get("persist-failed")).toMatchObject({ count: 3, last: "persist-customer" });
  });

  it("keeps the defect the commonest failure, and draws the same shapes for the same seed", () => {
    const failures = (seed: number): (FailureShape | undefined)[] =>
      generateHistory({ ...options, random: seeded(seed) }).map((customer) => customer.failure);
    expect(failures(7)).toEqual(failures(7));
    const counts = new Map<string, number>();
    for (const failure of failures(7)) {
      if (failure !== undefined) counts.set(failure, (counts.get(failure) ?? 0) + 1);
    }
    const commonest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    expect(commonest).toBe("dead-letter");
  });

  it("produces only envelopes the ingestion API accepts", () => {
    const history = generateHistory(options);
    const envelopes = [
      ...pinnedEnvelopes(NOW, "development"),
      ...history.flatMap((customer) => historyEnvelopes(customer, "development"))
    ];
    for (const envelope of envelopes) {
      const parsed = parseEnvelope(envelope);
      expect(parsed.ok ? "ok" : JSON.stringify(parsed.details), envelope.event.id).toBe("ok");
    }
  });
});

describe("historyEnvelopes", () => {
  it("records the live services' steps in time order, ending failed or completed", () => {
    const failing = generateHistory({ ...options, failureRate: 1 }).find(
      (customer) => customer.failure === "dead-letter"
    );
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

  it("is byte for byte the journey the docs, the site and the smoke check describe", () => {
    // Recorded before failure shapes were added. A change here changes what
    // the banner, DEMO_SCENARIO.md and the smoke check point at: update them
    // together, then this digest.
    const digest = createHash("sha256")
      .update(JSON.stringify(pinnedEnvelopes(NOW, "development")))
      .digest("hex");
    expect(digest).toBe("2a782328ec371be628fec8f6dc003140a10ba7760aa633edcb7a054b8f5562a0");
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
