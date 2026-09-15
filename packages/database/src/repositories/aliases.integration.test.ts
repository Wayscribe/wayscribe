import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { upsertAliases } from "./aliases.js";

interface StoredAlias {
  alias_type: string;
  alias_value_hash: string;
  encrypted_display_value: string | null;
}

describe("upsertAliases", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    await db("journeys").insert({
      id: "jrn_1",
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: "entity-hash",
      status: "active",
      started_at: db.fn.now(),
      last_event_at: db.fn.now(),
      event_count: 1
    });
  });

  beforeEach(async () => {
    await db("entity_aliases").delete();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const stored = async (): Promise<StoredAlias[]> =>
    await db("entity_aliases")
      .where({ project_id: projectId, journey_id: "jrn_1" })
      .orderBy(["alias_type", "alias_value_hash"])
      .select("alias_type", "alias_value_hash", "encrypted_display_value");

  const seed = async (aliasType: string, hash: string, display: string): Promise<void> => {
    await db("entity_aliases").insert({
      project_id: projectId,
      journey_id: "jrn_1",
      alias_type: aliasType,
      alias_value_hash: hash,
      encrypted_display_value: display
    });
  };

  it("ignores a repeat of the same alias", async () => {
    const alias = {
      journeyId: "jrn_1",
      aliasType: "sf",
      aliasValueHash: "new-hash",
      encryptedDisplayValue: "new-cipher",
      supersedesValueHash: null
    };
    await upsertAliases(db, projectId, [alias]);
    await upsertAliases(db, projectId, [{ ...alias, encryptedDisplayValue: "other-cipher" }]);
    expect(await stored()).toEqual([
      { alias_type: "sf", alias_value_hash: "new-hash", encrypted_display_value: "new-cipher" }
    ]);
  });

  it("moves a row written under the previous key's token instead of adding a second", async () => {
    // During a rotation the same alias value produces a different token, so a
    // plain insert-or-ignore would store it twice and the journey would show it
    // twice.
    await seed("sf", "old-hash", "old-cipher");
    await upsertAliases(db, projectId, [
      {
        journeyId: "jrn_1",
        aliasType: "sf",
        aliasValueHash: "new-hash",
        encryptedDisplayValue: "new-cipher",
        supersedesValueHash: "old-hash"
      }
    ]);
    expect(await stored()).toEqual([
      { alias_type: "sf", alias_value_hash: "new-hash", encrypted_display_value: "new-cipher" }
    ]);
  });

  it("leaves a row of another alias type with the same old token alone", async () => {
    // Tokens cover the value alone (ADR-028), so another type can carry the same
    // one. It is that type's row, and a later event for that type moves it.
    await seed("internal", "old-hash", "internal-cipher");
    await upsertAliases(db, projectId, [
      {
        journeyId: "jrn_1",
        aliasType: "sf",
        aliasValueHash: "new-hash",
        encryptedDisplayValue: "new-cipher",
        supersedesValueHash: "old-hash"
      }
    ]);
    expect(await stored()).toEqual([
      {
        alias_type: "internal",
        alias_value_hash: "old-hash",
        encrypted_display_value: "internal-cipher"
      },
      { alias_type: "sf", alias_value_hash: "new-hash", encrypted_display_value: "new-cipher" }
    ]);
  });

  it("does not fail when rows under both tokens already exist", async () => {
    // Reachable when the previous key was removed early, the alias was stored
    // again under the new token, and the previous key was then restored. Moving
    // the old row would violate the unique constraint and fail the event.
    await seed("sf", "old-hash", "old-cipher");
    await seed("sf", "new-hash", "new-cipher");
    await expect(
      upsertAliases(db, projectId, [
        {
          journeyId: "jrn_1",
          aliasType: "sf",
          aliasValueHash: "new-hash",
          encryptedDisplayValue: "newer-cipher",
          supersedesValueHash: "old-hash"
        }
      ])
    ).resolves.toBeUndefined();
    expect((await stored()).map((row) => row.alias_value_hash)).toEqual(["new-hash", "old-hash"]);
  });

  it("treats a concurrent move onto the new token as already done", async () => {
    // The NOT EXISTS guard reads a snapshot, so it cannot see a row under the
    // new token that another transaction has inserted but not committed. The
    // update then waits on that row's unique index entry and, when the other
    // transaction commits, fails with a unique violation. Without a savepoint
    // that violation also aborts the caller's transaction and rejects the event.
    await seed("sf", "old-hash", "old-cipher");

    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstInserted: () => void = () => undefined;
    const firstHasInserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });

    // Connection one: the new-token row, inserted and held uncommitted.
    const first = db.transaction(async (trx) => {
      await trx("entity_aliases").insert({
        project_id: projectId,
        journey_id: "jrn_1",
        alias_type: "sf",
        alias_value_hash: "new-hash",
        encrypted_display_value: "first-cipher"
      });
      firstInserted();
      await firstMayCommit;
    });
    await firstHasInserted;

    // Connection two: the ordinary ingestion path, inside its own transaction,
    // with more work after the aliases, as ingestEvent has.
    const second = db.transaction(async (trx) => {
      await upsertAliases(trx, projectId, [
        {
          journeyId: "jrn_1",
          aliasType: "sf",
          aliasValueHash: "new-hash",
          encryptedDisplayValue: "second-cipher",
          supersedesValueHash: "old-hash"
        }
      ]);
      await trx("entity_aliases").where({ project_id: projectId }).count({ n: "*" });
    });

    // Commit the first only once the second is provably blocked on it, so the
    // interleaving is the same on every run rather than a matter of timing.
    await waitForLockWait(db);
    releaseFirst();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect((await stored()).map((row) => row.alias_value_hash)).toEqual(["new-hash", "old-hash"]);
  });
});

/** Resolves once some backend is waiting on a lock, or fails after five seconds. */
async function waitForLockWait(db: Knex): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result: unknown = await db.raw(
      "select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock'"
    );
    const waiting = (result as { rows: { waiting: number }[] }).rows[0]?.waiting ?? 0;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The second transaction never waited on the first.");
}
