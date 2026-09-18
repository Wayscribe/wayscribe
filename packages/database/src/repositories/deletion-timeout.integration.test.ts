import { startPostgres, type TestDatabase } from "../testing/postgres.js";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnexConfig } from "../knex-config.js";
import { deleteJourney } from "./deletion.js";
import { sweepExpiredJourneys } from "./retention.js";

const MIGRATION = "016_replay_runs_event_index.js";
/** Small, so a cascade over an unindexed foreign key runs past it on any machine. */
const TIMEOUT_MS = 300;
const EVENTS = 1_500;
const REPLAY_RUNS = 20_000;

/**
 * Deleting a journey cascades to its events, and each deleted event cascades
 * to replay_runs through (project_id, journey_event_id). Without an index on
 * that pair, every deleted event scans the project's replay runs, so one
 * journey with many events outlasts DATABASE_STATEMENT_TIMEOUT_MS, and the
 * retention sweep failed on the same batch every hour, never reaching the
 * environments after it.
 */
describe("deletions under the API's statement timeout", () => {
  let container: TestDatabase;
  /** Fixtures and migrations, with no timeout. */
  let db: Knex;
  /** The API's pool, as server.ts builds it. */
  let timed: Knex;
  let projectId = "";

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    timed = knex(
      createKnexConfig(container.getConnectionUri(), { statementTimeoutMs: TIMEOUT_MS })
    );
    await db.migrate.latest();

    const project: unknown = await db.raw(
      "insert into projects (name, slug) values ('T', 't') returning id"
    );
    projectId = (project as { rows: { id: string }[] }).rows[0]?.id ?? "";
    await db.raw(
      `insert into environments (project_id, name, retention_days) values (?, 'development', 1)`,
      [projectId]
    );
    await db.raw(
      `insert into replay_destinations (project_id, name, base_url, environment_type)
       values (?, 'local', 'http://localhost:9', 'development')`,
      [projectId]
    );
    // A recent journey whose one event many replay runs point at. It is kept;
    // its runs are what an unindexed cascade has to scan.
    await journey("jrn_kept", 0, 1);
    await db.raw(
      `insert into replay_runs
         (project_id, journey_event_id, destination_id, method, request_path, status, initiated_by)
       select ?, 'jrn_kept-evt-1', (select id from replay_destinations limit 1),
              'POST', '/', 'completed', 'admin'
       from generate_series(1, ?)`,
      [projectId, REPLAY_RUNS]
    );
  });

  afterAll(async () => {
    await timed.destroy();
    await db.destroy();
    await container.stop();
  });

  /** A journey `daysAgo` old with `events` events, inserted in one statement each. */
  async function journey(id: string, daysAgo: number, events: number): Promise<void> {
    await db.raw(
      `insert into journeys (id, project_id, environment_id, entity_type, primary_entity_id_hash,
                             status, started_at, last_event_at, event_count)
       select ?, ?, e.id, 'order', ?, 'completed',
              now() - make_interval(days => ?), now() - make_interval(days => ?), ?
       from environments e where e.project_id = ?`,
      [id, projectId, `hash-${id}`, daysAgo, daysAgo, events, projectId]
    );
    await db.raw(
      `insert into journey_events (id, project_id, environment_id, journey_id, protocol_version,
                                   content_hash, operation, name, service, event_timestamp)
       select ? || '-evt-' || n, j.project_id, j.environment_id, j.id, '0.1',
              'hash', 'received', 'step', 'svc', j.last_event_at
       from journeys j, generate_series(1, ?) as n
       where j.project_id = ? and j.id = ?`,
      [id, events, projectId, id]
    );
  }

  const indexUsed = async (): Promise<string> => {
    const plan: unknown = await db.raw(
      `explain delete from replay_runs where project_id = ? and journey_event_id = 'x'`,
      [projectId]
    );
    return (plan as { rows: Record<string, string>[] }).rows
      .map((row) => Object.values(row).join(""))
      .join("\n");
  };

  it("without the index, a journey's cascade runs past the timeout", async () => {
    await db.migrate.down({ name: MIGRATION });
    await journey("jrn_heavy", 30, EVENTS);

    // The statement the sweep used to send, on its own, under the timeout.
    await expect(
      timed.transaction(async (trx) => {
        await trx.raw("delete from journeys where project_id = ? and id = 'jrn_heavy'", [
          projectId
        ]);
      })
    ).rejects.toMatchObject({ code: "57014" });
    expect(await db("journeys").where({ id: "jrn_heavy" }).first("id")).toBeDefined();
  });

  it("the sweep's batches run without the timeout, and finish", async () => {
    // Still no index: this proves the SET LOCAL alone, and that it stays local.
    const result = await sweepExpiredJourneys(timed);

    expect(result).toMatchObject({ ran: true, journeysDeleted: 1, stoppedEarly: false });
    expect(await db("journeys").pluck("id")).toEqual(["jrn_kept"]);
    await expect(timed.raw("select pg_sleep(1)")).rejects.toMatchObject({ code: "57014" });
  });

  it("an admin's journey deletion runs without the timeout, and finishes", async () => {
    await journey("jrn_admin", 0, EVENTS);

    const result = await deleteJourney(timed, {
      projectId,
      journeyId: "jrn_admin",
      actor: "admin"
    });

    expect(result).toMatchObject({ ok: true, eventCount: EVENTS });
    await expect(timed.raw("select pg_sleep(1)")).rejects.toMatchObject({ code: "57014" });
  });

  it("with the index, the same cascade fits inside the timeout on its own", async () => {
    await db.migrate.up({ name: MIGRATION });
    expect(await indexUsed()).toContain("replay_runs_journey_event_idx");
    await journey("jrn_heavy", 30, EVENTS);

    await timed.transaction(async (trx) => {
      await trx.raw("delete from journeys where project_id = ? and id = 'jrn_heavy'", [projectId]);
    });
    expect(await db("journeys").where({ id: "jrn_heavy" }).first("id")).toBeUndefined();
  });
});
