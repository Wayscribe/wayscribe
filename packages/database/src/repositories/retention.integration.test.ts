import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKnexConfig } from "../knex-config.js";
import { insertReturningId } from "../insert.js";
import { sweepExpiredJourneys } from "./retention.js";

describe("retention sweep", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let shortEnv: string;
  let longEnv: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "R", slug: "r" });
    shortEnv = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development",
      retention_days: 7
    });
    longEnv = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production",
      retention_days: 90
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  beforeEach(async () => {
    await db("journeys").del();
  });

  async function journey(id: string, environmentId: string, daysAgo: number): Promise<void> {
    const at = db.raw("now() - make_interval(days => ?)", [daysAgo]);
    await db("journeys").insert({
      id,
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: `hash-${id}`,
      status: "completed",
      started_at: at,
      last_event_at: at,
      event_count: 1
    });
  }

  it("deletes journeys past the window and keeps the rest", async () => {
    await journey("jrn_old", shortEnv, 30);
    await journey("jrn_fresh", shortEnv, 1);

    const result = await sweepExpiredJourneys(db);
    expect(result.ran).toBe(true);
    expect(result.journeysDeleted).toBe(1);

    const remaining = (await db("journeys").pluck("id")) as string[];
    expect(remaining).toEqual(["jrn_fresh"]);
  });

  it("applies each environment's own window", async () => {
    // 30 days is past development's 7 and inside production's 90. A global
    // window would delete both or neither.
    await journey("jrn_dev", shortEnv, 30);
    await journey("jrn_prod", longEnv, 30);

    await sweepExpiredJourneys(db);

    const remaining = (await db("journeys").pluck("id")) as string[];
    expect(remaining).toEqual(["jrn_prod"]);
  });

  it("removes the journey's events and aliases with it", async () => {
    await journey("jrn_cascade", shortEnv, 30);
    await db("journey_events").insert({
      id: "evt_cascade",
      project_id: projectId,
      environment_id: shortEnv,
      journey_id: "jrn_cascade",
      service: "svc",
      operation: "received",
      name: "n",
      event_timestamp: db.fn.now(),
      protocol_version: "0.1",
      content_hash: "hash-cascade"
    });
    await db("entity_aliases").insert({
      project_id: projectId,
      journey_id: "jrn_cascade",
      alias_type: "internalCustomerId",
      alias_value_hash: "alias-hash"
    });

    await sweepExpiredJourneys(db);

    // The cascade is what makes this one statement rather than four in a
    // careful order; if it ever stops working, orphaned events accumulate
    // silently.
    expect(await db("journey_events").where({ journey_id: "jrn_cascade" }).first()).toBeUndefined();
    expect(await db("entity_aliases").where({ journey_id: "jrn_cascade" }).first()).toBeUndefined();
  });

  it("keeps a long-running journey whose last event is recent", async () => {
    // Selection is on last_event_at, not started_at: a journey still receiving
    // events is still interesting however long ago it began.
    const old = db.raw("now() - make_interval(days => ?)", [400]);
    await db("journeys").insert({
      id: "jrn_long",
      project_id: projectId,
      environment_id: shortEnv,
      entity_type: "customer",
      primary_entity_id_hash: "hash-long",
      status: "active",
      started_at: old,
      last_event_at: db.fn.now(),
      event_count: 2
    });

    await sweepExpiredJourneys(db);
    expect(await db("journeys").where({ id: "jrn_long" }).first()).toBeDefined();
  });

  it("deletes more than one batch when the batch size is small", async () => {
    for (let i = 0; i < 5; i += 1) await journey(`jrn_b${String(i)}`, shortEnv, 30);

    const result = await sweepExpiredJourneys(db, { batchSize: 2 });
    expect(result.journeysDeleted).toBe(5);
    expect(result.batches).toBeGreaterThan(1);
    expect(await db("journeys").count({ n: "*" }).first()).toEqual({ n: "0" });
  });

  it("stops at the batch ceiling rather than running unbounded", async () => {
    for (let i = 0; i < 5; i += 1) await journey(`jrn_c${String(i)}`, shortEnv, 30);

    const result = await sweepExpiredJourneys(db, { batchSize: 1, maxBatchesPerEnvironment: 2 });
    expect(result.journeysDeleted).toBe(2);
    // The remainder is left for the next sweep, which is the point: one pass
    // must not hold the process for an unbounded time on a large backlog.
    expect(await db("journeys").count({ n: "*" }).first()).toEqual({ n: "3" });
  });

  it("does nothing while another connection holds the lock", async () => {
    await journey("jrn_locked", shortEnv, 30);

    const other = knex(createKnexConfig(container.getConnectionUri()));
    try {
      await other.raw("select pg_advisory_lock(4919072026)");
      const result = await sweepExpiredJourneys(db);
      // Two API replicas must not sweep at once (ADR-026).
      expect(result.ran).toBe(false);
      expect(result.journeysDeleted).toBe(0);
      expect(await db("journeys").where({ id: "jrn_locked" }).first()).toBeDefined();
    } finally {
      await other.raw("select pg_advisory_unlock(4919072026)");
      await other.destroy();
    }
  });

  it("releases the lock so the next sweep can run", async () => {
    await journey("jrn_again", shortEnv, 30);
    await sweepExpiredJourneys(db);
    expect((await sweepExpiredJourneys(db)).ran).toBe(true);
  });
});
