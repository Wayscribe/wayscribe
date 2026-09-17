import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
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
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
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

  it("leaves the lock free after every sweep while the pool is under contention", async () => {
    // The lock used to be taken and released by separate pooled queries. With
    // other queries competing for connections, the release could land on a
    // different connection, fail, and leave the lock held by an idle pooled
    // backend: every later sweep on every replica then skipped until restart.
    for (const env of [shortEnv, longEnv]) {
      for (let i = 0; i < 6; i += 1) await journey(`jrn_p${env}${String(i)}`, env, 400);
    }

    let saturating = true;
    const saturate = async (): Promise<void> => {
      while (saturating) await db.raw("select pg_sleep(0.005)");
    };
    const saturators = Array.from({ length: 20 }, () => saturate());

    // One connection of its own, so a probe's lock and unlock share a session.
    const probe = knex({
      ...createKnexConfig(container.getConnectionUri()),
      pool: { min: 1, max: 1 }
    });
    const key = 4_919_072_026;
    try {
      for (let sweep = 0; sweep < 8; sweep += 1) {
        const result = await sweepExpiredJourneys(db, {
          batchSize: 1,
          maxBatchesPerEnvironment: 1
        });
        expect(result.ran).toBe(true);

        const holders: unknown = await probe.raw(
          `select count(*)::int as n from pg_locks
            where locktype = 'advisory' and classid = ? and objid = ? and objsubid = 1`,
          [Math.floor(key / 2 ** 32), key % 2 ** 32]
        );
        expect((holders as { rows: { n: number }[] }).rows[0]?.n).toBe(0);

        const taken: unknown = await probe.raw(`select pg_try_advisory_lock(${String(key)}) as ok`);
        expect((taken as { rows: { ok: boolean }[] }).rows[0]?.ok).toBe(true);
        await probe.raw(`select pg_advisory_unlock(${String(key)})`);
      }
    } finally {
      saturating = false;
      await Promise.all(saturators);
      await probe.destroy();
    }
  });

  it("stops early and says so when the connection holding its lock is terminated", async () => {
    for (let i = 0; i < 4; i += 1) await journey(`jrn_t${String(i)}`, shortEnv, 30);

    // Hold the first journey the sweep will delete, so its first batch waits,
    // and terminate the connection holding the sweep's lock meanwhile.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const rowLock = db.transaction(async (trx) => {
      await trx("journeys").where({ id: "jrn_t0" }).forUpdate().select("id");
      holding();
      await released;
    });
    await held;

    const sweeping = sweepExpiredJourneys(db, { batchSize: 1 });
    try {
      await waitFor(async () => {
        const result: unknown = await db.raw(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'"
        );
        return (result as { rows: { n: number }[] }).rows[0]?.n === 1;
      });
      const holders: unknown = await db.raw(
        "select pid from pg_locks where locktype = 'advisory' and granted"
      );
      const pid = (holders as { rows: { pid: number }[] }).rows[0]?.pid;
      if (pid === undefined) throw new Error("No backend holds the sweep's lock.");
      await db.raw("select pg_terminate_backend(?)", [pid]);
      await waitFor(async () => {
        const result: unknown = await db.raw(
          "select count(*)::int as n from pg_stat_activity where pid = ?",
          [pid]
        );
        return (result as { rows: { n: number }[] }).rows[0]?.n === 0;
      });
    } finally {
      release();
      await rowLock;
    }

    const result = await sweeping;
    // The batch that was running commits; nothing after it runs without the lock.
    expect(result).toMatchObject({ ran: true, stoppedEarly: true, journeysDeleted: 1 });
    expect(await db("journeys").whereLike("id", "jrn_t%").count({ n: "*" }).first()).toEqual({
      n: "3"
    });

    const next = await sweepExpiredJourneys(db);
    expect(next).toMatchObject({ ran: true, stoppedEarly: false, journeysDeleted: 3 });
  });
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The condition never held.");
}
