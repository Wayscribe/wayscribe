import { createKeyring, searchTokens, type Keyring } from "@flight-recorder/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import {
  deleteJourney,
  deleteRange,
  deleteReplayDestination,
  eraseIdentifier,
  findJourneysByIdentifier,
  findJourneysInRange,
  type JourneyMatches
} from "./deletion.js";
import { createDestination, startRun } from "./replay.js";
import { RETENTION_LOCK_KEY, sweepExpiredJourneys } from "./retention.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const keyringA = createKeyring(KEY_A);
/** Mid-rotation: B is current, A is the previous key rows may still be under. */
const rotated = createKeyring(KEY_B, KEY_A);

const token = (keyring: Keyring, value: string): string => {
  const [current] = searchTokens(keyring, value);
  if (current === undefined) throw new Error("no token");
  return current;
};

const ids = (matches: JourneyMatches): string[] => {
  if (!matches.ok) throw new Error(`no matches: ${matches.reason}`);
  return matches.journeys.map((journey) => journey.id).sort();
};

interface AuditRow {
  id: string;
  project_id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
}

describe("deletion", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectA: string;
  let projectB: string;
  let productionA: string;
  let developmentA: string;
  let productionB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
    projectB = await insertReturningId(db, "projects", { name: "B", slug: "b" });
    productionA = await insertReturningId(db, "environments", {
      project_id: projectA,
      name: "production"
    });
    developmentA = await insertReturningId(db, "environments", {
      project_id: projectA,
      name: "development"
    });
    productionB = await insertReturningId(db, "environments", {
      project_id: projectB,
      name: "production"
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  beforeEach(async () => {
    await db("replay_runs").del();
    await db("replay_destinations").del();
    // Journeys cascade to their events and aliases.
    await db("journeys").del();
    await db("audit_events").del();
  });

  const journey = async (options: {
    project: string;
    environment: string;
    id: string;
    hash?: string;
    lastEventAt?: Date;
    eventCount?: number;
  }): Promise<void> => {
    const at = options.lastEventAt ?? new Date("2026-09-01T00:00:00Z");
    await db("journeys").insert({
      id: options.id,
      project_id: options.project,
      environment_id: options.environment,
      entity_type: "customer",
      primary_entity_id_hash: options.hash ?? `hash-${options.id}`,
      status: "active",
      started_at: at,
      last_event_at: at,
      event_count: options.eventCount ?? 1
    });
  };

  const event = async (
    project: string,
    environment: string,
    journeyId: string,
    id: string
  ): Promise<void> => {
    await db("journey_events").insert({
      id,
      project_id: project,
      environment_id: environment,
      journey_id: journeyId,
      service: "svc",
      operation: "received",
      name: "n",
      event_timestamp: db.fn.now(),
      protocol_version: "0.1",
      content_hash: `content-${id}`
    });
  };

  const alias = async (project: string, journeyId: string, hash: string): Promise<void> => {
    await db("entity_aliases").insert({
      project_id: project,
      journey_id: journeyId,
      alias_type: "email",
      alias_value_hash: hash
    });
  };

  const destination = async (project: string, name: string): Promise<string> =>
    (
      await createDestination(db, keyringA, {
        projectId: project,
        name,
        baseUrl: "http://build-box.internal.example:3300",
        environmentType: "development",
        headers: { authorization: "Bearer destination-secret-credential" }
      })
    ).id;

  const run = async (project: string, eventId: string, destinationId: string): Promise<string> =>
    startRun(db, {
      projectId: project,
      journeyEventId: eventId,
      destinationId,
      method: "POST",
      requestPath: "/hooks",
      requestPayload: { replayed: true },
      requestHeaders: {},
      initiatedBy: "admin"
    });

  const count = async (table: string, where: Record<string, unknown>): Promise<number> => {
    const counted: unknown = await db(table).where(where).count({ n: "*" });
    return Number((counted as { n: string | number }[])[0]?.n ?? 0);
  };

  const journeyIds = async (project: string): Promise<string[]> =>
    ((await db("journeys").where({ project_id: project }).pluck("id")) as string[]).sort();

  const auditRows = async (): Promise<AuditRow[]> =>
    (await db("audit_events").orderBy("created_at").select("*")) as AuditRow[];

  /** Makes every audit write of one kind fail, as a full disk or a revoked grant would. */
  const withFailingAudit = async (
    operation: "insert" | "update",
    work: () => Promise<void>
  ): Promise<void> => {
    await db.raw(`
      create or replace function fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'audit write refused'; end $$
    `);
    await db.raw(
      `create trigger fail_audit before ${operation} on audit_events for each row execute function fail_audit()`
    );
    try {
      await work();
    } finally {
      await db.raw("drop trigger fail_audit on audit_events");
    }
  };

  const advisoryLocksHeld = async (): Promise<number> => {
    const result: unknown = await db.raw(
      "select count(*)::int as n from pg_locks where locktype = 'advisory'"
    );
    return (result as { rows: { n: number }[] }).rows[0]?.n ?? -1;
  };

  describe("deleteJourney", () => {
    it("deletes the journey with its events, aliases, and replay runs, and nothing in another journey or project", async () => {
      const target = "jrn_shared_id";
      await journey({ project: projectA, environment: productionA, id: target, eventCount: 2 });
      await event(projectA, productionA, target, "evt_a1");
      await event(projectA, productionA, target, "evt_a2");
      await alias(projectA, target, "alias-target");
      await journey({ project: projectA, environment: productionA, id: "jrn_neighbour" });
      await event(projectA, productionA, "jrn_neighbour", "evt_n1");
      await alias(projectA, "jrn_neighbour", "alias-neighbour");
      // The same journey id in another project: the composite key allows it,
      // and only the project scope keeps it out of this deletion.
      await journey({ project: projectB, environment: productionB, id: target });
      await event(projectB, productionB, target, "evt_a1");
      await alias(projectB, target, "alias-target");

      const destinationId = await destination(projectA, "local");
      await run(projectA, "evt_a1", destinationId);
      const neighbourRun = await run(projectA, "evt_n1", destinationId);

      const result = await deleteJourney(db, {
        projectId: projectA,
        journeyId: target,
        actor: "admin"
      });
      expect(result).toEqual({
        ok: true,
        journeyId: target,
        environment: "production",
        eventCount: 2
      });

      expect(await journeyIds(projectA)).toEqual(["jrn_neighbour"]);
      expect(await count("journey_events", { project_id: projectA, journey_id: target })).toBe(0);
      expect(await count("entity_aliases", { project_id: projectA, journey_id: target })).toBe(0);
      expect(await count("replay_runs", { project_id: projectA })).toBe(1);
      expect(await count("replay_runs", { id: neighbourRun })).toBe(1);
      expect(await count("journey_events", { journey_id: "jrn_neighbour" })).toBe(1);
      expect(await count("entity_aliases", { journey_id: "jrn_neighbour" })).toBe(1);
      expect(await count("replay_destinations", { id: destinationId })).toBe(1);

      expect(await journeyIds(projectB)).toEqual([target]);
      expect(await count("journey_events", { project_id: projectB })).toBe(1);
      expect(await count("entity_aliases", { project_id: projectB })).toBe(1);

      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        project_id: projectA,
        actor: "admin",
        action: "journey.deleted",
        resource_type: "journey",
        resource_id: target,
        metadata: { environment: "production", eventCount: 2 }
      });
    });

    it("reports a journey outside the project as not found, touches nothing, and records nothing", async () => {
      await journey({ project: projectB, environment: productionB, id: "jrn_b_only" });

      const result = await deleteJourney(db, {
        projectId: projectA,
        journeyId: "jrn_b_only",
        actor: "admin"
      });
      expect(result).toEqual({ ok: false, reason: "journey_not_found" });
      expect(await journeyIds(projectB)).toEqual(["jrn_b_only"]);
      expect(await auditRows()).toHaveLength(0);
    });

    it("does not commit the deletion when its audit row cannot be written", async () => {
      await journey({ project: projectA, environment: productionA, id: "jrn_unrecorded" });

      await withFailingAudit("insert", async () => {
        await expect(
          deleteJourney(db, { projectId: projectA, journeyId: "jrn_unrecorded", actor: "admin" })
        ).rejects.toThrow(/audit write refused/);
      });
      expect(await journeyIds(projectA)).toEqual(["jrn_unrecorded"]);
    });
  });

  describe("erasure", () => {
    // Mixed case on purpose: normalization does not lowercase it, so the audit
    // row must contain neither this spelling nor any other.
    const VALUE = "Customer-42@Example.com";

    it("matches by entity id and by alias value, within the project", async () => {
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_entity",
        hash: token(keyringA, VALUE),
        eventCount: 3
      });
      await journey({
        project: projectA,
        environment: developmentA,
        id: "jrn_alias",
        eventCount: 4
      });
      await alias(projectA, "jrn_alias", token(keyringA, VALUE));
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_other",
        hash: token(keyringA, "someone-else")
      });
      await alias(projectA, "jrn_other", token(keyringA, "someone-else"));
      // The same value under the same key in another project.
      await journey({
        project: projectB,
        environment: productionB,
        id: "jrn_b",
        hash: token(keyringA, VALUE)
      });

      const found = await findJourneysByIdentifier(db, keyringA, {
        projectId: projectA,
        value: VALUE
      });
      expect(found).toMatchObject({ ok: true, total: 2 });
      expect(ids(found)).toEqual(["jrn_alias", "jrn_entity"]);

      const result = await eraseIdentifier(db, keyringA, {
        projectId: projectA,
        value: VALUE,
        actor: "admin"
      });
      expect(result).toMatchObject({ ok: true, deletedJourneys: 2, deletedEvents: 7, batches: 1 });
      expect(await journeyIds(projectA)).toEqual(["jrn_other"]);
      expect(await count("entity_aliases", { journey_id: "jrn_other" })).toBe(1);
      expect(await journeyIds(projectB)).toEqual(["jrn_b"]);
    });

    it("limits the match to one environment when one is named", async () => {
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_prod",
        hash: token(keyringA, VALUE)
      });
      await journey({
        project: projectA,
        environment: developmentA,
        id: "jrn_dev",
        hash: token(keyringA, VALUE)
      });

      const selection = { projectId: projectA, value: VALUE, environment: "development" };
      expect(ids(await findJourneysByIdentifier(db, keyringA, selection))).toEqual(["jrn_dev"]);
      const result = await eraseIdentifier(db, keyringA, { ...selection, actor: "admin" });
      expect(result).toMatchObject({ ok: true, deletedJourneys: 1 });
      expect(await journeyIds(projectA)).toEqual(["jrn_prod"]);

      const [audit] = await auditRows();
      expect(audit?.metadata).toMatchObject({ environment: "development" });
    });

    it("reports an unknown environment rather than matching nothing", async () => {
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_kept",
        hash: token(keyringA, VALUE)
      });

      const selection = { projectId: projectA, value: VALUE, environment: "prodution" };
      expect(await findJourneysByIdentifier(db, keyringA, selection)).toEqual({
        ok: false,
        reason: "environment_not_found"
      });
      expect(await eraseIdentifier(db, keyringA, { ...selection, actor: "admin" })).toEqual({
        ok: false,
        reason: "environment_not_found"
      });
      expect(await journeyIds(projectA)).toEqual(["jrn_kept"]);
      expect(await auditRows()).toHaveLength(0);
    });

    it("finds and erases journeys still under the previous key's token during a rotation", async () => {
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_old_entity",
        hash: token(keyringA, VALUE)
      });
      await journey({ project: projectA, environment: productionA, id: "jrn_old_alias" });
      await alias(projectA, "jrn_old_alias", token(keyringA, VALUE));
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_new_entity",
        hash: token(rotated, VALUE)
      });
      await journey({ project: projectA, environment: productionA, id: "jrn_unrelated" });

      const selection = { projectId: projectA, value: VALUE };
      expect(ids(await findJourneysByIdentifier(db, rotated, selection))).toEqual([
        "jrn_new_entity",
        "jrn_old_alias",
        "jrn_old_entity"
      ]);

      const result = await eraseIdentifier(db, rotated, { ...selection, actor: "admin" });
      expect(result).toMatchObject({ ok: true, deletedJourneys: 3 });
      expect(await journeyIds(projectA)).toEqual(["jrn_unrelated"]);

      // The current key's token, so a later erasure of the value under this
      // keyring can be matched to the row.
      const [audit] = await auditRows();
      expect(audit?.metadata?.["token"]).toBe(token(rotated, VALUE));
      expect(audit?.metadata?.["token"]).not.toBe(token(keyringA, VALUE));
    });

    it("dry run deletes nothing and reports exactly the set a real run deletes", async () => {
      for (let i = 0; i < 4; i += 1) {
        await journey({
          project: projectA,
          environment: i % 2 === 0 ? productionA : developmentA,
          id: `jrn_entity_${String(i)}`,
          hash: token(i === 3 ? keyringA : rotated, VALUE)
        });
      }
      for (let i = 0; i < 3; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_alias_${String(i)}`
        });
        await alias(projectA, `jrn_alias_${String(i)}`, token(i === 0 ? keyringA : rotated, VALUE));
      }
      for (let i = 0; i < 3; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_decoy_${String(i)}`
        });
      }
      await journey({
        project: projectB,
        environment: productionB,
        id: "jrn_b",
        hash: token(rotated, VALUE)
      });

      const selection = { projectId: projectA, value: VALUE };
      const dryRun = await findJourneysByIdentifier(db, rotated, selection);
      expect(dryRun).toMatchObject({ ok: true, total: 7 });
      const limited = await findJourneysByIdentifier(db, rotated, selection, { limit: 2 });
      expect(limited).toMatchObject({ ok: true, total: 7 });
      expect(ids(limited)).toHaveLength(2);

      const before = await journeyIds(projectA);
      expect(before).toHaveLength(10);
      expect(await auditRows()).toHaveLength(0);

      await eraseIdentifier(db, rotated, { ...selection, actor: "admin" }, { batchSize: 2 });
      const after = new Set(await journeyIds(projectA));
      const deleted = before.filter((id) => !after.has(id)).sort();
      expect(deleted).toEqual(ids(dryRun));
      expect(await journeyIds(projectB)).toEqual(["jrn_b"]);
    });

    it("writes one audit row for a multi-batch erasure, with totals and the token but never the value", async () => {
      for (let i = 0; i < 5; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_${String(i)}`,
          hash: token(keyringA, VALUE),
          eventCount: 3
        });
      }

      const result = await eraseIdentifier(
        db,
        keyringA,
        { projectId: projectA, value: VALUE, actor: "admin" },
        { batchSize: 2 }
      );
      expect(result).toMatchObject({ ok: true, deletedJourneys: 5, deletedEvents: 15, batches: 3 });

      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      const [row] = audit;
      if (!result.ok) throw new Error("the erasure did not run");
      expect(row).toMatchObject({
        id: result.auditId,
        project_id: projectA,
        action: "erasure.completed",
        resource_type: "identifier",
        resource_id: null,
        metadata: {
          token: token(keyringA, VALUE),
          environment: null,
          deletedJourneys: 5,
          deletedEvents: 15
        }
      });

      const serialized = JSON.stringify(row);
      for (const spelling of [VALUE, VALUE.toLowerCase(), "Customer-42", "Example.com"]) {
        expect(serialized).not.toContain(spelling);
      }
    });

    it("writes an audit row even when nothing matches", async () => {
      await journey({ project: projectA, environment: productionA, id: "jrn_kept" });

      const result = await eraseIdentifier(db, keyringA, {
        projectId: projectA,
        value: VALUE,
        actor: "admin"
      });
      expect(result).toMatchObject({ ok: true, deletedJourneys: 0, deletedEvents: 0, batches: 0 });
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ deletedJourneys: 0, deletedEvents: 0 });
      expect(await journeyIds(projectA)).toEqual(["jrn_kept"]);
    });

    it("leaves an audit row matching what committed when an erasure stops part way", async () => {
      for (let i = 0; i < 5; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_${String(i)}`,
          hash: token(keyringA, VALUE),
          eventCount: 2
        });
      }
      const input = { projectId: projectA, value: VALUE, actor: "admin" };

      // The process dying after the first batch committed.
      await expect(
        eraseIdentifier(db, keyringA, input, {
          batchSize: 2,
          onBatch: () => {
            throw new Error("process died");
          }
        })
      ).rejects.toThrow("process died");

      expect(await journeyIds(projectA)).toHaveLength(3);
      const interrupted = await auditRows();
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]?.metadata).toMatchObject({ deletedJourneys: 2, deletedEvents: 4 });

      const resumed = await eraseIdentifier(db, keyringA, input, { batchSize: 2 });
      expect(resumed).toMatchObject({ ok: true, deletedJourneys: 3 });
      expect(await journeyIds(projectA)).toEqual([]);
      expect((await auditRows()).map((row) => row.metadata?.["deletedJourneys"])).toEqual([2, 3]);
    });

    it("does not commit a later batch whose audit update fails", async () => {
      for (let i = 0; i < 4; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_${String(i)}`,
          hash: token(keyringA, VALUE)
        });
      }

      await withFailingAudit("update", async () => {
        await expect(
          eraseIdentifier(
            db,
            keyringA,
            { projectId: projectA, value: VALUE, actor: "admin" },
            { batchSize: 2 }
          )
        ).rejects.toThrow(/audit write refused/);
      });

      // The first batch committed with the row's insert; the second rolled back
      // with its failed update, so the row still says exactly what is gone.
      expect(await journeyIds(projectA)).toHaveLength(2);
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ deletedJourneys: 2 });
    });
  });

  describe("range deletion", () => {
    const AFTER = new Date("2026-01-01T00:00:00.000Z");
    const BEFORE = new Date("2026-02-01T00:00:00.000Z");
    const offset = (from: Date, ms: number): Date => new Date(from.getTime() + ms);
    const DAY = 86_400_000;

    const seedWindow = async (): Promise<void> => {
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_at_after",
        lastEventAt: AFTER
      });
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_inside",
        lastEventAt: offset(AFTER, DAY),
        eventCount: 5
      });
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_just_before_before",
        lastEventAt: offset(BEFORE, -1)
      });
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_at_before",
        lastEventAt: BEFORE
      });
      await journey({
        project: projectA,
        environment: productionA,
        id: "jrn_just_before_after",
        lastEventAt: offset(AFTER, -1)
      });
      await journey({
        project: projectA,
        environment: developmentA,
        id: "jrn_other_environment",
        lastEventAt: offset(AFTER, DAY)
      });
      await journey({
        project: projectB,
        environment: productionB,
        id: "jrn_other_project",
        lastEventAt: offset(AFTER, DAY)
      });
    };

    it("deletes by last_event_at in [after, before) in one environment of one project", async () => {
      await seedWindow();
      await event(projectA, productionA, "jrn_inside", "evt_inside");
      await alias(projectA, "jrn_inside", "alias-inside");

      const result = await deleteRange(db, {
        projectId: projectA,
        environment: "production",
        after: AFTER,
        before: BEFORE,
        actor: "cli"
      });
      expect(result).toMatchObject({
        ok: true,
        environmentId: productionA,
        deletedJourneys: 3,
        deletedEvents: 7,
        lockLost: false
      });

      expect(await journeyIds(projectA)).toEqual([
        "jrn_at_before",
        "jrn_just_before_after",
        "jrn_other_environment"
      ]);
      expect(await journeyIds(projectB)).toEqual(["jrn_other_project"]);
      expect(await count("journey_events", { journey_id: "jrn_inside" })).toBe(0);
      expect(await count("entity_aliases", { journey_id: "jrn_inside" })).toBe(0);

      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        project_id: projectA,
        actor: "cli",
        action: "range.deleted",
        resource_type: "environment",
        resource_id: productionA,
        metadata: {
          after: "2026-01-01T00:00:00.000Z",
          before: "2026-02-01T00:00:00.000Z",
          deletedJourneys: 3
        }
      });
    });

    it("deletes everything before `before` when no `after` is given", async () => {
      await seedWindow();

      const result = await deleteRange(db, {
        projectId: projectA,
        environment: "production",
        before: BEFORE,
        actor: "cli"
      });
      expect(result).toMatchObject({ ok: true, deletedJourneys: 4 });
      expect(await journeyIds(projectA)).toEqual(["jrn_at_before", "jrn_other_environment"]);
      expect((await auditRows())[0]?.metadata).toMatchObject({ after: null, deletedJourneys: 4 });
    });

    it("dry run deletes nothing and reports exactly the set a real run deletes", async () => {
      await seedWindow();
      for (let i = 0; i < 5; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_bulk_${String(i)}`,
          lastEventAt: offset(AFTER, i * DAY)
        });
      }
      const selection = {
        projectId: projectA,
        environment: "production",
        after: AFTER,
        before: BEFORE
      };

      const dryRun = await findJourneysInRange(db, selection);
      expect(dryRun).toMatchObject({ ok: true, total: 8 });
      expect(await findJourneysInRange(db, selection, { limit: 3 })).toMatchObject({ total: 8 });
      const before = await journeyIds(projectA);
      expect(await auditRows()).toHaveLength(0);

      const result = await deleteRange(db, { ...selection, actor: "cli" }, { batchSize: 3 });
      expect(result).toMatchObject({ ok: true, deletedJourneys: 8, batches: 3 });
      const after = new Set(await journeyIds(projectA));
      expect(before.filter((id) => !after.has(id)).sort()).toEqual(ids(dryRun));
      expect(await auditRows()).toHaveLength(1);
    });

    it("reports an unknown environment, including one only another project has", async () => {
      await journey({
        project: projectB,
        environment: productionB,
        id: "jrn_b",
        lastEventAt: AFTER
      });
      await db("environments").insert({ project_id: projectB, name: "staging" });
      try {
        const selection = { projectId: projectA, environment: "staging", before: BEFORE };
        expect(await findJourneysInRange(db, selection)).toEqual({
          ok: false,
          reason: "environment_not_found"
        });
        expect(await deleteRange(db, { ...selection, actor: "cli" })).toEqual({
          ok: false,
          reason: "environment_not_found"
        });
        expect(await auditRows()).toHaveLength(0);
      } finally {
        await db("environments").where({ project_id: projectB, name: "staging" }).del();
      }
    });

    it("reports the lock held, and deletes nothing, while a retention sweep holds it", async () => {
      await seedWindow();
      const other = knex(createKnexConfig(container.getConnectionUri()));
      try {
        // The sweep's own key, not an import of the constant alone: if the two
        // ever diverged, this is the test that should say so.
        expect(RETENTION_LOCK_KEY).toBe(4_919_072_026);
        await other.raw("select pg_advisory_lock(4919072026)");

        const result = await deleteRange(db, {
          projectId: projectA,
          environment: "production",
          before: BEFORE,
          actor: "cli"
        });
        expect(result).toEqual({ ok: false, reason: "lock_held" });
        expect(await journeyIds(projectA)).toHaveLength(6);
        expect(await auditRows()).toHaveLength(0);
      } finally {
        await other.raw("select pg_advisory_unlock(4919072026)");
        await other.destroy();
      }
    });

    it("keeps a retention sweep from running while it holds the lock, and leaves no lock behind", async () => {
      await seedWindow();
      const sweeps: boolean[] = [];

      const result = await deleteRange(
        db,
        { projectId: projectA, environment: "production", before: BEFORE, actor: "cli" },
        {
          batchSize: 2,
          onBatch: async () => {
            sweeps.push((await sweepExpiredJourneys(db)).ran);
          }
        }
      );
      expect(result).toMatchObject({ ok: true, deletedJourneys: 4 });
      expect(sweeps).toEqual([false, false]);

      // Transaction-scoped, released on commit: nothing left on a pooled connection.
      expect(await advisoryLocksHeld()).toBe(0);
      expect((await sweepExpiredJourneys(db)).ran).toBe(true);
    });

    it("stops after the batch in progress and says so when the lock's connection is terminated", async () => {
      for (let i = 0; i < 4; i += 1) {
        await journey({
          project: projectA,
          environment: productionA,
          id: `jrn_t${String(i)}`,
          lastEventAt: offset(AFTER, i)
        });
      }

      const result = await deleteRange(
        db,
        { projectId: projectA, environment: "production", before: BEFORE, actor: "cli" },
        {
          batchSize: 1,
          onBatch: async ({ batch }) => {
            if (batch !== 1) return;
            const holders: unknown = await db.raw(
              "select pid from pg_locks where locktype = 'advisory' and granted"
            );
            const pid = (holders as { rows: { pid: number }[] }).rows[0]?.pid;
            if (pid === undefined) throw new Error("No backend holds the range deletion's lock.");
            await db.raw("select pg_terminate_backend(?)", [pid]);
            await waitFor(async () => {
              const gone: unknown = await db.raw(
                "select count(*)::int as n from pg_stat_activity where pid = ?",
                [pid]
              );
              return (gone as { rows: { n: number }[] }).rows[0]?.n === 0;
            });
          }
        }
      );

      expect(result).toMatchObject({ ok: true, deletedJourneys: 1, batches: 1, lockLost: true });
      expect(await journeyIds(projectA)).toHaveLength(3);
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ deletedJourneys: 1 });

      const next = await deleteRange(db, {
        projectId: projectA,
        environment: "production",
        before: BEFORE,
        actor: "cli"
      });
      expect(next).toMatchObject({ ok: true, deletedJourneys: 3, lockLost: false });
    });

    it("rejects an invalid date instead of querying with it", async () => {
      await expect(
        findJourneysInRange(db, {
          projectId: projectA,
          environment: "production",
          before: new Date("not a date")
        })
      ).rejects.toThrow(RangeError);
    });
  });

  describe("deleteReplayDestination", () => {
    it("deletes the destination and its runs in one transaction, and nothing else", async () => {
      await journey({ project: projectA, environment: productionA, id: "jrn_replayed" });
      await event(projectA, productionA, "jrn_replayed", "evt_1");
      await event(projectA, productionA, "jrn_replayed", "evt_2");
      const target = await destination(projectA, "doomed");
      const kept = await destination(projectA, "kept");
      await run(projectA, "evt_1", target);
      await run(projectA, "evt_2", target);
      const keptRun = await run(projectA, "evt_1", kept);

      await journey({ project: projectB, environment: productionB, id: "jrn_replayed" });
      await event(projectB, productionB, "jrn_replayed", "evt_1");
      const otherProject = await destination(projectB, "doomed");
      await run(projectB, "evt_1", otherProject);

      const result = await deleteReplayDestination(db, {
        projectId: projectA,
        destinationId: target,
        actor: "admin"
      });
      expect(result).toEqual({ ok: true, destinationId: target, name: "doomed", deletedRuns: 2 });

      expect(await count("replay_destinations", { id: target })).toBe(0);
      expect(await count("replay_runs", { destination_id: target })).toBe(0);
      expect(await count("replay_destinations", { id: kept })).toBe(1);
      expect(await count("replay_runs", { id: keptRun })).toBe(1);
      expect(await count("replay_destinations", { id: otherProject })).toBe(1);
      expect(await count("replay_runs", { destination_id: otherProject })).toBe(1);
      expect(await count("journey_events", { journey_id: "jrn_replayed" })).toBe(3);

      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        project_id: projectA,
        action: "replay_destination.deleted",
        resource_type: "replay_destination",
        resource_id: target,
        metadata: { name: "doomed", deletedRuns: 2 }
      });
      const serialized = JSON.stringify(audit[0]);
      expect(serialized).not.toContain("build-box.internal.example");
      expect(serialized).not.toContain("destination-secret-credential");
    });

    it("reports another project's destination and a malformed id as not found", async () => {
      const otherProject = await destination(projectB, "theirs");

      expect(
        await deleteReplayDestination(db, {
          projectId: projectA,
          destinationId: otherProject,
          actor: "admin"
        })
      ).toEqual({ ok: false, reason: "destination_not_found" });
      expect(
        await deleteReplayDestination(db, {
          projectId: projectA,
          destinationId: "not-a-uuid",
          actor: "admin"
        })
      ).toEqual({ ok: false, reason: "destination_not_found" });

      expect(await count("replay_destinations", { id: otherProject })).toBe(1);
      expect(await auditRows()).toHaveLength(0);
    });

    it("does not commit the deletion when its audit row cannot be written", async () => {
      await journey({ project: projectA, environment: productionA, id: "jrn_replayed" });
      await event(projectA, productionA, "jrn_replayed", "evt_1");
      const target = await destination(projectA, "unrecorded");
      await run(projectA, "evt_1", target);

      await withFailingAudit("insert", async () => {
        await expect(
          deleteReplayDestination(db, {
            projectId: projectA,
            destinationId: target,
            actor: "admin"
          })
        ).rejects.toThrow(/audit write refused/);
      });
      expect(await count("replay_destinations", { id: target })).toBe(1);
      expect(await count("replay_runs", { destination_id: target })).toBe(1);
    });
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
