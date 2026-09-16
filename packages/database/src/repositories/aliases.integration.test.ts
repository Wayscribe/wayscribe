import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import {
  ALIAS_DISPLAY_VALUE_CONSTRAINT,
  ALIAS_DISPLAY_VALUE_TRIGGER,
  ALIAS_UNIQUE_CONSTRAINT,
  upsertAliases
} from "./aliases.js";

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
      value: "new-value",
      displayable: false,
      supersedesValueHash: null
    };
    await upsertAliases(db, projectId, [alias]);
    await upsertAliases(db, projectId, [{ ...alias, encryptedDisplayValue: "other-cipher" }]);
    expect(await stored()).toEqual([
      { alias_type: "sf", alias_value_hash: "new-hash", encrypted_display_value: "new-cipher" }
    ]);
  });

  describe("the display flag", () => {
    const alias = {
      journeyId: "jrn_1",
      aliasType: "postingId",
      aliasValueHash: "posting-hash",
      encryptedDisplayValue: "posting-cipher",
      value: "POST-1",
      supersedesValueHash: null
    };
    const flag = async (): Promise<boolean | undefined> => {
      const row: unknown = await db("entity_aliases")
        .where({ project_id: projectId, alias_type: "postingId" })
        .first("displayable");
      return (row as { displayable: boolean } | undefined)?.displayable;
    };
    /** The row's version: it changes whenever the row is written. */
    const version = async (): Promise<string> => {
      const row: unknown = await db("entity_aliases")
        .where({ project_id: projectId, alias_type: "postingId" })
        .first(db.raw("xmin::text as xmin"));
      return (row as { xmin: string }).xmin;
    };

    it("defaults to masked for a row written without it", async () => {
      await seed("postingId", "posting-hash", "posting-cipher");
      expect(await flag()).toBe(false);
    });

    it("stores the flag the first statement gives", async () => {
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      expect(await flag()).toBe(true);
    });

    it("masks an alias once any statement leaves it unmarked", async () => {
      // Displayable only if every statement says so (ADR-053).
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      expect(await flag()).toBe(false);
    });

    it("never unmasks an alias a statement left unmarked, whatever arrives later", async () => {
      // Order-independent: a retried old event cannot undo a newer one.
      await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      expect(await flag()).toBe(false);
    });

    it("does not write the row for a repeat that leaves the flag where it is", async () => {
      // An SDK that repeats identify on every event must not turn a no-op into
      // an update on every event.
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      const before = await version();
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      expect(await version()).toBe(before);

      await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      const lowered = await version();
      expect(lowered).not.toBe(before);
      await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      expect(await version()).toBe(lowered);
    });

    it("does not write a displayable row without a copy for a repeat that has none to give", async () => {
      // A value a text column cannot hold (a NUL) has no copy, and every
      // repeat of it would otherwise rewrite the row as if filling one.
      await upsertAliases(db, projectId, [{ ...alias, value: null, displayable: true }]);
      const before = await version();
      await upsertAliases(db, projectId, [{ ...alias, value: null, displayable: true }]);
      expect(await version()).toBe(before);
    });

    it("keeps the flag on a row moved to the current token, then applies the new statement", async () => {
      await seed("postingId", "old-hash", "old-cipher");
      await db("entity_aliases")
        .where({ alias_value_hash: "old-hash" })
        .update({ displayable: true });
      await upsertAliases(db, projectId, [
        { ...alias, displayable: true, supersedesValueHash: "old-hash" }
      ]);
      expect(await flag()).toBe(true);

      await db("entity_aliases").delete();
      await seed("postingId", "old-hash", "old-cipher");
      await upsertAliases(db, projectId, [
        { ...alias, displayable: true, supersedesValueHash: "old-hash" }
      ]);
      expect(await flag()).toBe(false);
    });
  });

  describe("the plain-text copy", () => {
    const alias = {
      journeyId: "jrn_1",
      aliasType: "postingId",
      aliasValueHash: "posting-hash",
      encryptedDisplayValue: "posting-cipher",
      value: "POST-1",
      supersedesValueHash: null
    };

    interface Copy {
      displayable: boolean;
      display_value: string | null;
      encrypted_display_value: string | null;
    }

    const copy = async (): Promise<Copy | undefined> => {
      const row: unknown = await db("entity_aliases")
        .where({ project_id: projectId, alias_type: "postingId" })
        .first("displayable", "display_value", "encrypted_display_value");
      return row as Copy | undefined;
    };

    /**
     * Migration 018's constraint refuses any row that is masked and still holds
     * a plain value, checked as each row is written. So a change that lowered
     * the flag in one statement and cleared the copy in the next would fail
     * these tests rather than pass them. Asserted present, so the proof cannot
     * lapse silently if the constraint is ever dropped.
     *
     * 018's trigger would clear such a copy before the check saw it, which
     * would hide the mistake, so it is disabled while the work runs: these
     * tests prove the statement clears the copy itself.
     */
    const runAfterAssertingConstraint = async (work: () => Promise<void>): Promise<void> => {
      const found: unknown = await db.raw(
        "select convalidated from pg_constraint where conrelid = 'entity_aliases'::regclass and conname = ?",
        [ALIAS_DISPLAY_VALUE_CONSTRAINT]
      );
      expect((found as { rows: unknown[] }).rows).toEqual([{ convalidated: true }]);
      await db.raw(`alter table entity_aliases disable trigger ${ALIAS_DISPLAY_VALUE_TRIGGER}`);
      try {
        await work();
      } finally {
        await db.raw(`alter table entity_aliases enable trigger ${ALIAS_DISPLAY_VALUE_TRIGGER}`);
      }
    };

    it("is stored with a displayable alias", async () => {
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      expect(await copy()).toMatchObject({ displayable: true, display_value: "POST-1" });
    });

    it("is never stored for a masked alias", async () => {
      await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      expect(await copy()).toMatchObject({ displayable: false, display_value: null });
      // A later displayable statement cannot unmask it, so it gets no copy either.
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      expect(await copy()).toMatchObject({ displayable: false, display_value: null });
    });

    it("is cleared in the same statement that lowers the flag", async () => {
      await runAfterAssertingConstraint(async () => {
        await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
        await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      });
      expect(await copy()).toMatchObject({ displayable: false, display_value: null });
    });

    it("keeps the spelling the ciphertext holds when a repeat spells the value differently", async () => {
      // Tokens are taken over the normalized value, so " POST-1 " is the same
      // row. The repeat is ignored, ciphertext and copy alike.
      await upsertAliases(db, projectId, [{ ...alias, displayable: true }]);
      await upsertAliases(db, projectId, [
        {
          ...alias,
          value: " POST-1 ",
          encryptedDisplayValue: "spaced-cipher",
          displayable: true
        }
      ]);
      expect(await copy()).toEqual({
        displayable: true,
        display_value: "POST-1",
        encrypted_display_value: "posting-cipher"
      });
    });

    it("is filled for a displayable row stored before copies existed, when it is stated again", async () => {
      // Migration 018 has no backfill. The restatement brings its own
      // ciphertext with the copy, so the two hold the same spelling.
      await seed("postingId", "posting-hash", "old-cipher");
      await db("entity_aliases").where({ alias_type: "postingId" }).update({ displayable: true });
      await upsertAliases(db, projectId, [
        { ...alias, value: " POST-1 ", encryptedDisplayValue: "spaced-cipher", displayable: true }
      ]);
      expect(await copy()).toEqual({
        displayable: true,
        display_value: " POST-1 ",
        encrypted_display_value: "spaced-cipher"
      });
    });

    it("is not filled for such a row by a statement that masks it", async () => {
      await seed("postingId", "posting-hash", "old-cipher");
      await db("entity_aliases").where({ alias_type: "postingId" }).update({ displayable: true });
      await upsertAliases(db, projectId, [{ ...alias, displayable: false }]);
      expect(await copy()).toEqual({
        displayable: false,
        display_value: null,
        encrypted_display_value: "old-cipher"
      });
    });

    it("follows the ciphertext when a row moves to the current token", async () => {
      await seed("postingId", "old-hash", "old-cipher");
      await db("entity_aliases")
        .where({ alias_value_hash: "old-hash" })
        .update({ displayable: true, display_value: "old spelling" });
      await upsertAliases(db, projectId, [
        { ...alias, displayable: true, supersedesValueHash: "old-hash" }
      ]);
      expect(await copy()).toEqual({
        displayable: true,
        display_value: "POST-1",
        encrypted_display_value: "posting-cipher"
      });
    });

    it("is cleared when a masking statement moves a displayable row", async () => {
      await seed("postingId", "old-hash", "old-cipher");
      await db("entity_aliases")
        .where({ alias_value_hash: "old-hash" })
        .update({ displayable: true, display_value: "POST-1" });
      await runAfterAssertingConstraint(async () => {
        await upsertAliases(db, projectId, [
          { ...alias, displayable: false, supersedesValueHash: "old-hash" }
        ]);
      });
      expect(await copy()).toEqual({
        displayable: false,
        display_value: null,
        encrypted_display_value: "posting-cipher"
      });
    });

    it("is never gained by a masked row that moves", async () => {
      await seed("postingId", "old-hash", "old-cipher");
      await upsertAliases(db, projectId, [
        { ...alias, displayable: true, supersedesValueHash: "old-hash" }
      ]);
      expect(await copy()).toMatchObject({ displayable: false, display_value: null });
    });

    it("stays present exactly while the alias is displayable under concurrent statements", async () => {
      // Many rounds of concurrent statements of the same aliases, displayable
      // and not, each in its own transaction as ingestion runs them. The row
      // lock the conflict update takes is what keeps flag and copy together.
      const types = ["a", "b", "c", "d"];
      await runAfterAssertingConstraint(async () => {
        for (let round = 0; round < 25; round += 1) {
          await db("entity_aliases").delete();
          await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
              db.transaction(async (trx) => {
                await upsertAliases(
                  trx,
                  projectId,
                  types.map((aliasType, t) => ({
                    journeyId: "jrn_1",
                    aliasType,
                    aliasValueHash: `hash-${aliasType}`,
                    encryptedDisplayValue: `cipher-${aliasType}`,
                    value: `value-${aliasType}`,
                    // Type "a" is always displayable, the rest mixed per statement.
                    displayable: t === 0 || (i + round + t) % (t + 2) !== 0,
                    supersedesValueHash: null
                  }))
                );
              })
            )
          );
          const selected: unknown = await db("entity_aliases")
            .orderBy("alias_type")
            .select("alias_type", "displayable", "display_value");
          const rows = selected as {
            alias_type: string;
            displayable: boolean;
            display_value: string | null;
          }[];
          expect(rows.map((row) => row.alias_type)).toEqual(types);
          for (const row of rows) {
            expect(row.display_value, `round ${String(round)}`).toBe(
              row.displayable ? `value-${row.alias_type}` : null
            );
          }
          // Every statement of "a" was displayable; any other type had at least
          // one that was not in every round.
          expect(rows.map((row) => row.displayable)).toEqual([true, false, false, false]);
        }
      });
    });
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
        value: "new-value",
        displayable: false,
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
        value: "new-value",
        displayable: false,
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
          value: "newer-value",
          displayable: false,
          supersedesValueHash: "old-hash"
        }
      ])
    ).resolves.toBeUndefined();
    expect((await stored()).map((row) => row.alias_value_hash)).toEqual(["new-hash", "old-hash"]);
  });

  it("names the alias uniqueness constraint as the database does", async () => {
    // The move tolerates a violation of this constraint alone, matched by name.
    // A name that drifted from the schema would make every tolerated race fail.
    const result: unknown = await db.raw(
      "select conname from pg_constraint where conrelid = 'entity_aliases'::regclass and contype = 'u'"
    );
    expect((result as { rows: { conname: string }[] }).rows).toEqual([
      { conname: ALIAS_UNIQUE_CONSTRAINT }
    ]);
  });

  it("rethrows a unique violation on any other constraint", async () => {
    // Only a violation of the alias constraint means another event already
    // moved the row. No other unique index covers the columns a move writes
    // today, so one is added for the length of this test. It includes
    // created_at, which a move keeps and an insert sets afresh, so the move
    // violates it and the insert that follows does not: the rejection can only
    // come from the move's own error handling.
    await db.raw(
      "create unique index entity_aliases_move_probe_idx on entity_aliases (project_id, encrypted_display_value, created_at)"
    );
    try {
      const createdAt = new Date("2026-09-01T00:00:00.000Z");
      await db("entity_aliases").insert([
        {
          project_id: projectId,
          journey_id: "jrn_1",
          alias_type: "internal",
          alias_value_hash: "other-hash",
          encrypted_display_value: "shared-cipher",
          created_at: createdAt
        },
        {
          project_id: projectId,
          journey_id: "jrn_1",
          alias_type: "sf",
          alias_value_hash: "old-hash",
          encrypted_display_value: "old-cipher",
          created_at: createdAt
        }
      ]);
      await expect(
        upsertAliases(db, projectId, [
          {
            journeyId: "jrn_1",
            aliasType: "sf",
            aliasValueHash: "new-hash",
            encryptedDisplayValue: "shared-cipher",
            value: "shared-value",
            displayable: false,
            supersedesValueHash: "old-hash"
          }
        ])
      ).rejects.toMatchObject({ code: "23505", constraint: "entity_aliases_move_probe_idx" });
    } finally {
      await db.raw("drop index entity_aliases_move_probe_idx");
    }
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
          value: "second-value",
          displayable: false,
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
