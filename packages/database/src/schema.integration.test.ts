import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "./insert.js";
import { createKnexConfig } from "./knex-config.js";

describe("schema constraints", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let otherProjectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "Primary", slug: "primary" });
    otherProjectId = await insertReturningId(db, "projects", { name: "Other", slug: "other" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("applies all migrations", async () => {
    for (const table of [
      "projects",
      "environments",
      "api_keys",
      "journeys",
      "entity_aliases",
      "journey_events",
      "replay_destinations",
      "replay_runs",
      "audit_events"
    ]) {
      expect(await db.schema.hasTable(table)).toBe(true);
    }
  });

  it("rejects an API key whose environment belongs to another project", async () => {
    // The point of the composite foreign key: this must fail in the database,
    // not in an application check a future query could forget.
    await expect(
      db("api_keys").insert({
        project_id: otherProjectId,
        environment_id: environmentId,
        name: "cross-project",
        key_prefix: "fr_crossproj",
        key_hash: "deadbeef"
      })
    ).rejects.toThrow();
  });

  it("accepts an API key within its own project", async () => {
    await expect(
      db("api_keys").insert({
        project_id: projectId,
        environment_id: environmentId,
        name: "valid",
        key_prefix: "fr_validkey1",
        key_hash: "deadbeef"
      })
    ).resolves.toBeDefined();
  });

  it("rejects an invalid capture mode", async () => {
    await expect(
      db("environments").insert({
        project_id: projectId,
        name: "bad-capture",
        capture_mode: "everything"
      })
    ).rejects.toThrow();
  });

  it("rejects a non-positive retention period", async () => {
    await expect(
      db("environments").insert({
        project_id: projectId,
        name: "bad-retention",
        retention_days: 0
      })
    ).rejects.toThrow();
  });

  it("rejects a production replay destination", async () => {
    await expect(
      db("replay_destinations").insert({
        project_id: projectId,
        name: "prod",
        base_url: "https://api.example.com",
        environment_type: "production"
      })
    ).rejects.toThrow();
  });

  it("enforces event idempotency on (project_id, id)", async () => {
    await db("journeys").insert({
      id: "jrn_dup",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "hash",
      started_at: new Date(),
      last_event_at: new Date()
    });

    const event = {
      id: "evt_dup",
      project_id: projectId,
      environment_id: environmentId,
      journey_id: "jrn_dup",
      protocol_version: "0.1",
      content_hash: "abc",
      operation: "received",
      name: "receive",
      service: "svc",
      event_timestamp: new Date()
    };

    await db("journey_events").insert(event);
    await expect(db("journey_events").insert(event)).rejects.toThrow();
  });

  it("allows the same event id in a different project", async () => {
    const otherEnvId = await insertReturningId(db, "environments", {
      project_id: otherProjectId,
      name: "development"
    });

    await db("journeys").insert({
      id: "jrn_dup",
      project_id: otherProjectId,
      environment_id: otherEnvId,
      entity_type: "customer",
      primary_entity_id_hash: "hash",
      started_at: new Date(),
      last_event_at: new Date()
    });

    await expect(
      db("journey_events").insert({
        id: "evt_dup",
        project_id: otherProjectId,
        environment_id: otherEnvId,
        journey_id: "jrn_dup",
        protocol_version: "0.1",
        content_hash: "abc",
        operation: "received",
        name: "receive",
        service: "svc",
        event_timestamp: new Date()
      })
    ).resolves.toBeDefined();
  });

  it("rejects a negative event count", async () => {
    await expect(
      db("journeys").where({ project_id: projectId, id: "jrn_dup" }).update({ event_count: -1 })
    ).rejects.toThrow();
  });

  it("adds the API key verifier's key id, nullable, and removes it on the way down", async () => {
    // Nullable because keys issued before key rotation have no id to record;
    // authentication fills it in the first time each one is presented.
    const columns = await db("api_keys").columnInfo();
    expect(columns["key_hash_key_id"]).toMatchObject({ type: "text", nullable: true });

    // By name: a bare down() reverts whichever migration is newest, which
    // stopped being this one when 013 was added.
    await db.migrate.down({ name: "012_key_rotation.js" });
    expect(await db.schema.hasColumn("api_keys", "key_hash_key_id")).toBe(false);
    await db.migrate.up({ name: "012_key_rotation.js" });
    expect(await db.schema.hasColumn("api_keys", "key_hash_key_id")).toBe(true);
  });

  describe("recent-journeys indexes (013)", () => {
    const MIGRATION = "013_journeys_status_recent_index.js";

    /** Name and validity of each 013 index that exists, sorted by name. */
    const indexes = async (): Promise<{ name: string; valid: boolean }[]> => {
      const result: unknown = await db.raw(
        `select c.relname as name, i.indisvalid as valid
         from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname in ('journeys_status_recent_idx', 'journey_events_service_idx')
         order by c.relname`
      );
      return (result as { rows: { name: string; valid: boolean }[] }).rows;
    };

    const BOTH_VALID = [
      { name: "journey_events_service_idx", valid: true },
      { name: "journeys_status_recent_idx", valid: true }
    ];

    it("adds both indexes and removes them on the way down", async () => {
      expect(await indexes()).toEqual(BOTH_VALID);
      await db.migrate.down({ name: MIGRATION });
      expect(await indexes()).toEqual([]);
      await db.migrate.up({ name: MIGRATION });
      expect(await indexes()).toEqual(BOTH_VALID);
    });

    it("rebuilds an index a cancelled concurrent build left invalid", async () => {
      // What a cancelled `create index concurrently` leaves behind: an index of
      // the right name that PostgreSQL will not use. `if not exists` alone
      // would accept it, and the migrate Job's retry would record 013 as done.
      await db.migrate.down({ name: MIGRATION });
      await db.raw(
        "create index journeys_status_recent_idx on journeys (project_id, status, last_event_at, id)"
      );
      await db.raw(
        "update pg_index set indisvalid = false where indexrelid = 'journeys_status_recent_idx'::regclass"
      );
      expect(await indexes()).toEqual([{ name: "journeys_status_recent_idx", valid: false }]);

      await db.migrate.up({ name: MIGRATION });
      expect(await indexes()).toEqual(BOTH_VALID);
    });
  });

  describe("search index (014)", () => {
    const MIGRATION = "014_search_indexes.js";

    /** Validity and definition of the span id index, if it exists. */
    const spanIndex = async (): Promise<{ valid: boolean; definition: string }[]> => {
      const result: unknown = await db.raw(
        `select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
         from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'journey_events_span_idx'`
      );
      return (result as { rows: { valid: boolean; definition: string }[] }).rows;
    };

    const VALID = [
      {
        valid: true,
        definition:
          "CREATE INDEX journey_events_span_idx ON public.journey_events USING btree (project_id, span_id) WHERE (span_id IS NOT NULL)"
      }
    ];

    it("adds the span id index and removes it on the way down", async () => {
      expect(await spanIndex()).toEqual(VALID);
      await db.migrate.down({ name: MIGRATION });
      expect(await spanIndex()).toEqual([]);
      await db.migrate.up({ name: MIGRATION });
      expect(await spanIndex()).toEqual(VALID);
    });

    it("rebuilds the index a cancelled concurrent build left invalid", async () => {
      // As for 013: `if not exists` alone would accept the invalid index and
      // the retried migration would record 014 as applied, leaving search by
      // span id a sequential scan of journey_events.
      await db.migrate.down({ name: MIGRATION });
      await db.raw(
        "create index journey_events_span_idx on journey_events (project_id, span_id) where span_id is not null"
      );
      await db.raw(
        "update pg_index set indisvalid = false where indexrelid = 'journey_events_span_idx'::regclass"
      );
      expect(await spanIndex()).toEqual([{ ...VALID[0], valid: false }]);

      await db.migrate.up({ name: MIGRATION });
      expect(await spanIndex()).toEqual(VALID);
    });
  });

  describe("replay runs' event foreign key index (016)", () => {
    const MIGRATION = "016_replay_runs_event_index.js";

    const indexes = async (): Promise<{ name: string; valid: boolean; definition: string }[]> => {
      const result: unknown = await db.raw(
        `select c.relname as name, i.indisvalid as valid, pg_get_indexdef(c.oid) as definition
         from pg_index i join pg_class c on c.oid = i.indexrelid
         where c.relname = 'replay_runs_journey_event_idx'`
      );
      return (result as { rows: { name: string; valid: boolean; definition: string }[] }).rows;
    };

    it("indexes the foreign key a cascaded event delete looks up, and removes it on the way down", async () => {
      const [index] = await indexes();
      expect(index?.valid).toBe(true);
      expect(index?.definition).toContain("(project_id, journey_event_id)");

      await db.migrate.down({ name: MIGRATION });
      expect(await indexes()).toEqual([]);
      await db.migrate.up({ name: MIGRATION });
      expect((await indexes()).map((found) => found.valid)).toEqual([true]);
    });

    it("rebuilds the index a cancelled concurrent build left invalid", async () => {
      await db.migrate.down({ name: MIGRATION });
      await db.raw(
        "create index replay_runs_journey_event_idx on replay_runs (project_id, journey_event_id)"
      );
      await db.raw(
        "update pg_index set indisvalid = false where indexrelid = 'replay_runs_journey_event_idx'::regclass"
      );
      expect((await indexes()).map((found) => found.valid)).toEqual([false]);

      await db.migrate.up({ name: MIGRATION });
      expect((await indexes()).map((found) => found.valid)).toEqual([true]);
    });
  });
});
