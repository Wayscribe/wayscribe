import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import {
  createKnexConfig,
  insertReturningId,
  issueKey,
  sweepExpiredJourneys
} from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The public demo backfills about 300 journeys spread over the past five days
 * (docs/superpowers/specs/2026-10-07-public-demo-design.md). That only works
 * if an event keeps the time it was sent with, a timeline is ordered by that
 * time rather than by arrival, and retention at the default 7 days leaves the
 * history alone until the next nightly reset, when it is at most six days old.
 */
describe("backfilled history", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await insertReturningId(db, "projects", { name: "Demo", slug: "demo" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "demo",
        environmentName: "development",
        name: "demo",
        retentionDays: 7
      })
    ).apiKey;
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const envelope = (
    journeyId: string,
    id: string,
    at: Date,
    operation: string,
    name: string
  ): unknown => ({
    protocolVersion: "0.1",
    event: {
      id,
      journeyId,
      environment: "development",
      service: "demo-integration",
      entity: { type: "customer", id: `cust-${journeyId}` },
      operation,
      name,
      timestamp: at.toISOString()
    }
  });

  const ingest = async (events: unknown[]): Promise<void> => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { events } as object
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const results = response.json<{ data: { results: { status: string }[] } }>().data.results;
    expect(results.map((result) => result.status)).not.toContain("rejected");
  };

  const asAdmin = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });

  /** A journey whose last event is `ageMs` old. */
  const journeyAged = async (journeyId: string, ageMs: number): Promise<void> => {
    const last = new Date(Date.now() - ageMs);
    await ingest([
      envelope(journeyId, `${journeyId}_1`, new Date(last.getTime() - 10_000), "received", "first"),
      envelope(journeyId, `${journeyId}_2`, last, "completed", "finish")
    ]);
  };

  it("stores past timestamps as sent and orders the timeline by them, not by arrival", async () => {
    const start = new Date(Date.now() - 5 * DAY_MS);
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    // Sent out of order on purpose: arrival order is third, first, second.
    await ingest([
      envelope("jrn_spike_order", "evt_spike_3", at(2), "failed", "third"),
      envelope("jrn_spike_order", "evt_spike_1", at(0), "received", "first"),
      envelope("jrn_spike_order", "evt_spike_2", at(1), "transformed", "second")
    ]);

    const events = await asAdmin("/v1/journeys/jrn_spike_order/events");
    expect(events.statusCode, events.body).toBe(200);
    const items = events.json<{ data: { items: { name: string; eventTimestamp: string }[] } }>()
      .data.items;
    expect(items.map((item) => item.name)).toEqual(["first", "second", "third"]);
    expect(items.map((item) => item.eventTimestamp)).toEqual([
      at(0).toISOString(),
      at(1).toISOString(),
      at(2).toISOString()
    ]);

    const journey = await asAdmin("/v1/journeys/jrn_spike_order");
    expect(journey.statusCode, journey.body).toBe(200);
    const data = journey.json<{ data: { startedAt: string; lastEventAt: string } }>().data;
    expect(data.startedAt).toBe(at(0).toISOString());
    expect(data.lastEventAt).toBe(at(2).toISOString());
  });

  it("keeps history up to six days old through a 7-day retention sweep, and removes older", async () => {
    // Backfilled at reset: up to 5 days old. Just before the next reset, 24 h
    // later: up to 6 days old. 6 days and two hours gives margin for a reset
    // that retries for 90 minutes.
    await journeyAged("jrn_spike_backfill_fresh", 5 * DAY_MS);
    await journeyAged("jrn_spike_backfill_before_reset", 6 * DAY_MS + 2 * HOUR_MS);
    // The control: the sweep does delete what is past retention, so the two
    // above surviving means something.
    await journeyAged("jrn_spike_expired", 8 * DAY_MS);

    const result = await sweepExpiredJourneys(db);
    expect(result.ran).toBe(true);

    expect((await asAdmin("/v1/journeys/jrn_spike_backfill_fresh")).statusCode).toBe(200);
    expect((await asAdmin("/v1/journeys/jrn_spike_backfill_before_reset")).statusCode).toBe(200);
    expect((await asAdmin("/v1/journeys/jrn_spike_expired")).statusCode).toBe(404);
  });
});
