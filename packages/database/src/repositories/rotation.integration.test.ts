import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createKeyring,
  decryptValue,
  encryptValue,
  issueApiKey,
  parseEncryptedValue,
  searchTokens,
  type Keyring
} from "@wayscribe/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { ALIAS_DISPLAY_VALUE_TRIGGER, upsertAliases } from "./aliases.js";
import {
  ROTATION_LOCK_KEY,
  findUnreadableData,
  reencryptValues,
  rotationStatus,
  type ReencryptResult,
  type TableReencryption
} from "./rotation.js";

/** The key id a stored value names, or null for a legacy value. */
const keyIdOf = (value: string): string | null => {
  const parsed = parseEncryptedValue(value);
  return parsed.kind === "envelope" ? parsed.keyId : null;
};

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
/** A key no keyring in these tests holds: data under it is "the key was removed". */
const KEY_C = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";

const keyringA = createKeyring(KEY_A);
const keyringB = createKeyring(KEY_B);
const keyringC = createKeyring(KEY_C);
const rotated = createKeyring(KEY_B, KEY_A);

/**
 * A value in the format written before values carried a key id.
 *
 * The envelope's payload is exactly the legacy layout, so stripping
 * `fr1.<id>.` yields a legacy value without reaching for the package's internal
 * single-key functions.
 */
const legacy = (keyring: Keyring, plaintext: string): string =>
  encryptValue(keyring, plaintext).slice("fr1.".length + 13);

const token = (keyring: Keyring, value: string): string => {
  const [current] = searchTokens(keyring, value);
  if (current === undefined) throw new Error("no token");
  return current;
};

/** Flip one base64 character inside the payload, keeping the envelope well formed. */
const tampered = (value: string): string => {
  const at = value.length - 6;
  const replacement = value[at] === "A" ? "B" : "A";
  return `${value.slice(0, at)}${replacement}${value.slice(at + 1)}`;
};

const table = (result: ReencryptResult, name: TableReencryption["table"]): TableReencryption => {
  if (!result.ran) throw new Error(`the run did not happen: ${result.reason}`);
  const found = result.tables.find((entry) => entry.table === name);
  if (found === undefined) throw new Error(`no result for ${name}`);
  return found;
};

describe("key rotation commands", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "production"
    });
  });

  beforeEach(async () => {
    // Journeys cascade to their aliases.
    await db("journeys").del();
    await db("replay_destinations").del();
    await db("api_keys").del();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const journey = async (id: string, encrypted: string | null, hash: string): Promise<void> => {
    await db("journeys").insert({
      id,
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: hash,
      encrypted_primary_entity_id: encrypted,
      status: "active",
      started_at: db.fn.now(),
      last_event_at: db.fn.now(),
      event_count: 1
    });
  };

  /** A journey whose entity id and token were written under this keyring. */
  const journeyUnder = async (keyring: Keyring, id: string, entityId: string): Promise<void> => {
    await journey(id, encryptValue(keyring, entityId), token(keyring, entityId));
  };

  const alias = async (
    journeyId: string,
    aliasType: string,
    hash: string,
    encrypted: string | null
  ): Promise<void> => {
    await db("entity_aliases").insert({
      project_id: projectId,
      journey_id: journeyId,
      alias_type: aliasType,
      alias_value_hash: hash,
      encrypted_display_value: encrypted
    });
  };

  const aliasUnder = async (
    keyring: Keyring,
    journeyId: string,
    aliasType: string,
    value: string
  ): Promise<void> => {
    await alias(journeyId, aliasType, token(keyring, value), encryptValue(keyring, value));
  };

  const destination = async (name: string, encrypted: string | null): Promise<void> => {
    await db("replay_destinations").insert({
      project_id: projectId,
      name,
      base_url: "http://localhost:3300",
      environment_type: "development",
      encrypted_headers: encrypted
    });
  };

  const apiKey = async (
    name: string,
    keyHashKeyId: string | null,
    options: { revoked?: boolean; lastUsedAt?: Date } = {}
  ): Promise<string> => {
    const issued = issueApiKey(keyringA);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name,
      key_prefix: issued.keyPrefix,
      key_hash: issued.verifier,
      key_hash_key_id: keyHashKeyId,
      revoked_at: options.revoked === true ? db.fn.now() : null,
      last_used_at: options.lastUsedAt ?? null
    });
    return issued.keyPrefix;
  };

  const journeyRows = async (): Promise<{ id: string; hash: string; encrypted: string | null }[]> =>
    await db("journeys")
      .where({ project_id: projectId })
      .orderBy("id")
      .select("id", "primary_entity_id_hash as hash", "encrypted_primary_entity_id as encrypted");

  const aliasRows = async (): Promise<
    { journeyId: string; aliasType: string; hash: string; encrypted: string | null }[]
  > =>
    await db("entity_aliases")
      .where({ project_id: projectId })
      .orderBy(["journey_id", "alias_type", "alias_value_hash"])
      .select(
        "journey_id as journeyId",
        "alias_type as aliasType",
        "alias_value_hash as hash",
        "encrypted_display_value as encrypted"
      );

  const destinationRows = async (): Promise<{ name: string; encrypted: string | null }[]> =>
    await db("replay_destinations")
      .where({ project_id: projectId })
      .orderBy("name")
      .select("name", "encrypted_headers as encrypted");

  describe("reencryptValues", () => {
    it("with no previous key, upgrades legacy values the current key opens and leaves tokens as they are", async () => {
      // An install that predates key ids and never rotates. Its values are
      // under the one key it has, so they only need the envelope; the same key
      // produces the same token.
      await journey("jrn_1", legacy(keyringB, "E-1"), token(keyringB, "E-1"));
      await journeyUnder(keyringB, "jrn_2", "E-2");
      // Neither of these is under the current key, and there is no other key
      // to read them with.
      await journey("jrn_3", legacy(keyringC, "E-3"), token(keyringC, "E-3"));
      await journeyUnder(keyringA, "jrn_4", "E-4");
      await alias(
        "jrn_1",
        "salesforceAccountId",
        token(keyringB, "SF-1"),
        legacy(keyringB, "SF-1")
      );
      await destination("legacy", legacy(keyringB, '{"x-api-key":"k"}'));
      const journeysBefore = await journeyRows();
      const aliasesBefore = await aliasRows();

      const first = await reencryptValues(db, keyringB);
      expect(first).toMatchObject({ ran: true, mode: "upgrade" });
      expect(table(first, "journeys")).toMatchObject({
        rewritten: 1,
        alreadyCurrent: 1,
        unrecoverable: 2
      });
      expect(table(first, "entity_aliases")).toMatchObject({ rewritten: 1 });
      expect(table(first, "replay_destinations")).toMatchObject({ rewritten: 1 });

      const journeysAfter = await journeyRows();
      expect(journeysAfter.map((row) => row.hash)).toEqual(journeysBefore.map((row) => row.hash));
      expect(keyIdOf(journeysAfter[0]?.encrypted ?? "")).toBe(keyringB.current.id);
      expect(decryptValue(keyringB, journeysAfter[0]?.encrypted ?? "")).toBe("E-1");
      expect(journeysAfter.slice(1)).toEqual(journeysBefore.slice(1));
      const [aliasAfter] = await aliasRows();
      expect(aliasAfter?.hash).toBe(aliasesBefore[0]?.hash);
      expect(decryptValue(keyringB, aliasAfter?.encrypted ?? "")).toBe("SF-1");
      const [destinationAfter] = await destinationRows();
      expect(keyIdOf(destinationAfter?.encrypted ?? "")).toBe(keyringB.current.id);

      const second = await reencryptValues(db, keyringB);
      expect(table(second, "journeys")).toMatchObject({ rewritten: 0, unrecoverable: 2 });
    });

    it("brings an upgraded install to a complete status in one run with no previous key", async () => {
      await journey("jrn_1", legacy(keyringB, "E-1"), token(keyringB, "E-1"));
      await alias(
        "jrn_1",
        "salesforceAccountId",
        token(keyringB, "SF-1"),
        legacy(keyringB, "SF-1")
      );
      await apiKey("current", keyringB.current.id);
      // Issued before key ids were recorded, and not used since.
      await apiKey("pre-012", null);

      expect((await rotationStatus(db, keyringB)).complete).toBe(false);
      await reencryptValues(db, keyringB);

      const status = await rotationStatus(db, keyringB);
      expect(status.rowsRemaining).toBe(0);
      expect(status.apiKeys.notCurrent).toEqual([]);
      expect(status.apiKeys.notRecorded.map((key) => key.name)).toEqual(["pre-012"]);
      expect(status.complete).toBe(true);
    });

    it("moves every value and token onto the current key in batches, and finds nothing the second time", async () => {
      // Spec scenario 3. A batch size of two makes every table span several
      // batches, so a cursor that skips or repeats rows would show here.
      for (const n of [1, 2, 3, 4, 5]) {
        await journeyUnder(keyringA, `jrn_${String(n)}`, `E-${String(n)}`);
        await aliasUnder(keyringA, `jrn_${String(n)}`, "salesforceAccountId", `SF-${String(n)}`);
        await aliasUnder(keyringA, `jrn_${String(n)}`, "email", `u${String(n)}@example.com`);
      }
      await journeyUnder(keyringB, "jrn_6", "E-6");
      for (const n of [1, 2, 3]) {
        await destination(
          `dest-${String(n)}`,
          encryptValue(keyringA, JSON.stringify({ authorization: `Bearer t${String(n)}` }))
        );
      }

      const first = await reencryptValues(db, rotated, { batchSize: 2 });
      expect(first).toMatchObject({ ran: true, mode: "rotate" });
      expect(table(first, "journeys")).toMatchObject({
        rewritten: 5,
        alreadyCurrent: 1,
        unrecoverable: 0,
        noValue: 0
      });
      expect(table(first, "journeys").batches).toBeGreaterThanOrEqual(3);
      expect(table(first, "entity_aliases")).toMatchObject({
        rewritten: 10,
        alreadyCurrent: 0,
        duplicatesRemoved: 0
      });
      expect(table(first, "replay_destinations")).toMatchObject({ rewritten: 3 });

      // Readable under B alone, with B's tokens: the previous key can go.
      for (const row of await journeyRows()) {
        const entityId = decryptValue(keyringB, row.encrypted ?? "");
        expect(keyIdOf(row.encrypted ?? "")).toBe(keyringB.current.id);
        expect(row.hash).toBe(token(keyringB, entityId));
      }
      const aliases = await aliasRows();
      expect(aliases).toHaveLength(10);
      for (const row of aliases) {
        const value = decryptValue(keyringB, row.encrypted ?? "");
        expect(keyIdOf(row.encrypted ?? "")).toBe(keyringB.current.id);
        expect(row.hash).toBe(token(keyringB, value));
      }
      for (const row of await destinationRows()) {
        expect(keyIdOf(row.encrypted ?? "")).toBe(keyringB.current.id);
        expect(JSON.parse(decryptValue(keyringB, row.encrypted ?? ""))).toHaveProperty(
          "authorization"
        );
      }

      const second = await reencryptValues(db, rotated, { batchSize: 2 });
      expect(table(second, "journeys")).toMatchObject({ rewritten: 0, alreadyCurrent: 6 });
      expect(table(second, "entity_aliases")).toMatchObject({ rewritten: 0, alreadyCurrent: 10 });
      expect(table(second, "replay_destinations")).toMatchObject({
        rewritten: 0,
        alreadyCurrent: 3
      });
    });

    it("rewrites legacy values written before values carried a key id", async () => {
      // Spec scenario 5: the old base64 layout, inserted directly.
      await journey(
        "jrn_legacy",
        legacy(keyringA, "0018Z00002ABC"),
        token(keyringA, "0018Z00002ABC")
      );
      await alias(
        "jrn_legacy",
        "salesforceAccountId",
        token(keyringA, "SF-9"),
        legacy(keyringA, "SF-9")
      );
      await destination("legacy", legacy(keyringA, JSON.stringify({ "x-api-key": "k" })));

      const result = await reencryptValues(db, rotated);
      expect(table(result, "journeys").rewritten).toBe(1);
      expect(table(result, "entity_aliases").rewritten).toBe(1);
      expect(table(result, "replay_destinations").rewritten).toBe(1);

      const [row] = await journeyRows();
      expect(decryptValue(keyringB, row?.encrypted ?? "")).toBe("0018Z00002ABC");
      expect(row?.hash).toBe(token(keyringB, "0018Z00002ABC"));
      const [aliasRow] = await aliasRows();
      expect(decryptValue(keyringB, aliasRow?.encrypted ?? "")).toBe("SF-9");
      expect(aliasRow?.hash).toBe(token(keyringB, "SF-9"));
      const [destinationRow] = await destinationRows();
      expect(decryptValue(keyringB, destinationRow?.encrypted ?? "")).toBe('{"x-api-key":"k"}');
    });

    it("counts rows with no stored value and leaves their tokens alone", async () => {
      // No plaintext means no token under the new key can be computed.
      await journey("jrn_empty", null, token(keyringA, "E-1"));
      await alias("jrn_empty", "salesforceAccountId", token(keyringA, "SF-1"), null);
      await destination("no-headers", null);
      const journeysBefore = await journeyRows();
      const aliasesBefore = await aliasRows();

      const result = await reencryptValues(db, rotated);
      expect(table(result, "journeys")).toMatchObject({ rewritten: 0, noValue: 1 });
      expect(table(result, "entity_aliases")).toMatchObject({ rewritten: 0, noValue: 1 });
      expect(table(result, "replay_destinations")).toMatchObject({ rewritten: 0, noValue: 1 });
      expect(await journeyRows()).toEqual(journeysBefore);
      expect(await aliasRows()).toEqual(aliasesBefore);
    });

    it("counts malformed, unknown-key and undecryptable values as unrecoverable and rewrites the rest", async () => {
      // Ordered by id, and two to a batch, so the bad rows share batches with
      // a good one and fill a whole batch on their own. A throw on any of them
      // would abort its batch, and every resume would stop on the same row.
      await journey("jrn_1", "fr1.not-a-key-id.payload", "h1");
      await journey("jrn_2", encryptValue(keyringC, "E-2"), token(keyringC, "E-2"));
      await journey("jrn_3", legacy(keyringC, "E-3"), token(keyringC, "E-3"));
      await journey("jrn_4", tampered(encryptValue(keyringA, "E-4")), token(keyringA, "E-4"));
      await journeyUnder(keyringA, "jrn_5", "E-5");
      const before = await journeyRows();

      const first = await reencryptValues(db, rotated, { batchSize: 2 });
      expect(first).toMatchObject({ ran: true, mode: "rotate" });
      expect(table(first, "journeys")).toMatchObject({ rewritten: 1, unrecoverable: 4 });

      const after = await journeyRows();
      expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
      expect(decryptValue(keyringB, after[4]?.encrypted ?? "")).toBe("E-5");

      const second = await reencryptValues(db, rotated, { batchSize: 2 });
      expect(table(second, "journeys")).toMatchObject({
        rewritten: 0,
        unrecoverable: 4,
        alreadyCurrent: 1
      });
    });

    it("deletes an old-token alias row when the same alias already has a row under the current token", async () => {
      // Reachable when the previous key was removed early, the alias stored
      // again under the new token, and the key then restored. Rewriting the old
      // row would violate the unique constraint; it is the stale copy.
      await journeyUnder(keyringB, "jrn_1", "E-1");
      await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
      await aliasUnder(keyringB, "jrn_1", "salesforceAccountId", "SF-1");
      // The same value under another alias type is that type's own row.
      await aliasUnder(keyringA, "jrn_1", "internalId", "SF-1");

      const result = await reencryptValues(db, rotated);
      expect(table(result, "entity_aliases")).toMatchObject({
        rewritten: 1,
        duplicatesRemoved: 1,
        alreadyCurrent: 1,
        unrecoverable: 0
      });

      const rows = await aliasRows();
      expect(rows.map((row) => [row.aliasType, row.hash])).toEqual([
        ["internalId", token(keyringB, "SF-1")],
        ["salesforceAccountId", token(keyringB, "SF-1")]
      ]);
      for (const row of rows) expect(keyIdOf(row.encrypted ?? "")).toBe(keyringB.current.id);
    });

    it("points an event that stated the stale alias row at the row that stays", async () => {
      // Migration 020: an event names the alias rows it stated by id. The stale
      // copy is deleted, so an event naming it would otherwise lose the alias
      // it stated; the survivor carries the same value and the folded flag.
      await journeyUnder(keyringB, "jrn_1", "E-1");
      await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
      await aliasUnder(keyringB, "jrn_1", "salesforceAccountId", "SF-1");
      await aliasUnder(keyringA, "jrn_1", "internalId", "SF-1");
      const idOf = async (aliasType: string, hash: string): Promise<string> => {
        const row: unknown = await db("entity_aliases")
          .where({ journey_id: "jrn_1", alias_type: aliasType, alias_value_hash: hash })
          .first("id");
        return (row as { id: string }).id;
      };
      const stale = await idOf("salesforceAccountId", token(keyringA, "SF-1"));
      const survivor = await idOf("salesforceAccountId", token(keyringB, "SF-1"));
      const internal = await idOf("internalId", token(keyringA, "SF-1"));
      const statedBy = async (eventId: string, ids: string[]): Promise<void> => {
        await db("journey_events").insert({
          id: eventId,
          project_id: projectId,
          environment_id: environmentId,
          journey_id: "jrn_1",
          protocol_version: "0.1",
          content_hash: "h",
          operation: "identified",
          name: "identify",
          service: "s",
          event_timestamp: db.fn.now(),
          stated_alias_ids: ids
        });
      };
      await statedBy("evt_stale", [internal, stale]);
      await statedBy("evt_current", [survivor]);
      await statedBy("evt_none", []);

      const result = await reencryptValues(db, rotated);
      expect(table(result, "entity_aliases")).toMatchObject({ duplicatesRemoved: 1 });

      const stated: unknown = await db("journey_events")
        .where({ journey_id: "jrn_1" })
        .orderBy("id")
        .select("id", "stated_alias_ids as ids");
      expect(stated).toEqual([
        { id: "evt_current", ids: [survivor] },
        { id: "evt_none", ids: [] },
        // The rewritten internalId row keeps its id, so that entry is untouched.
        { id: "evt_stale", ids: [internal, survivor] }
      ]);
    });

    it.each([
      [true, false],
      [false, true],
      [true, true]
    ])(
      "keeps an alias masked when the stale row it deletes said displayable %s and the current one %s",
      async (staleFlag, currentFlag) => {
        // Displayable only if every statement says so (ADR-053): the stale copy
        // is one of those statements, so its flag is folded in before it goes.
        await journeyUnder(keyringB, "jrn_1", "E-1");
        await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
        await aliasUnder(keyringB, "jrn_1", "salesforceAccountId", "SF-1");
        await db("entity_aliases")
          .where({ alias_value_hash: token(keyringA, "SF-1") })
          .update({ displayable: staleFlag });
        await db("entity_aliases")
          .where({ alias_value_hash: token(keyringB, "SF-1") })
          .update({ displayable: currentFlag });

        const result = await reencryptValues(db, rotated);
        expect(table(result, "entity_aliases")).toMatchObject({ duplicatesRemoved: 1 });
        const flags: unknown = await db("entity_aliases").pluck("displayable");
        expect(flags).toEqual([staleFlag && currentFlag]);
      }
    );

    it.each([
      [true, false],
      [false, true],
      [true, true]
    ])(
      "keeps the survivor's plain-text copy only while the folded flag stays true (stale %s, current %s)",
      async (staleFlag, currentFlag) => {
        await journeyUnder(keyringB, "jrn_1", "E-1");
        await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
        await aliasUnder(keyringB, "jrn_1", "salesforceAccountId", "SF-1");
        const copyOf = (flag: boolean): string | null => (flag ? "SF-1" : null);
        await db("entity_aliases")
          .where({ alias_value_hash: token(keyringA, "SF-1") })
          .update({ displayable: staleFlag, display_value: copyOf(staleFlag) });
        await db("entity_aliases")
          .where({ alias_value_hash: token(keyringB, "SF-1") })
          .update({ displayable: currentFlag, display_value: copyOf(currentFlag) });

        // Migration 018's constraint refuses the fold if it lowers the flag
        // and leaves the copy, so a passing run cannot have done that. 018's
        // trigger would clear the copy first and hide it, so it is off here.
        await db.raw(`alter table entity_aliases disable trigger ${ALIAS_DISPLAY_VALUE_TRIGGER}`);
        let result: ReencryptResult;
        try {
          result = await reencryptValues(db, rotated);
        } finally {
          await db.raw(`alter table entity_aliases enable trigger ${ALIAS_DISPLAY_VALUE_TRIGGER}`);
        }
        expect(table(result, "entity_aliases")).toMatchObject({ duplicatesRemoved: 1 });
        const rows: unknown = await db("entity_aliases").select("displayable", "display_value");
        expect(rows).toEqual([
          {
            displayable: staleFlag && currentFlag,
            display_value: copyOf(staleFlag && currentFlag)
          }
        ]);
      }
    );

    it("leaves a plain-text copy alone when it rewrites the ciphertext beside it", async () => {
      // The copy is not ciphertext, so a rotation has nothing to do to it.
      await journeyUnder(keyringB, "jrn_1", "E-1");
      await aliasUnder(keyringA, "jrn_1", "postingId", "POST-1");
      await db("entity_aliases").update({ displayable: true, display_value: "POST-1" });
      const result = await reencryptValues(db, rotated);
      expect(table(result, "entity_aliases")).toMatchObject({ rewritten: 1 });
      const rows: unknown = await db("entity_aliases").select("displayable", "display_value");
      expect(rows).toEqual([{ displayable: true, display_value: "POST-1" }]);
    });

    /** A promise and the function that settles it, for ordering two connections. */
    const signal = (): { promise: Promise<void>; fire: () => void } => {
      let fire: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        fire = resolve;
      });
      return { promise, fire };
    };

    it("leaves an alias row that ingestion moved while the run waited on it", async () => {
      // Ingestion's grace move holds the row when the run's update reaches it.
      // Once ingestion commits, PostgreSQL re-checks the update's condition
      // against the new row. Without the condition on the value read, the run
      // would overwrite what ingestion just wrote.
      await journeyUnder(keyringB, "jrn_1", "E-1");
      await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
      const ingested = encryptValue(keyringB, "SF-1");

      const holding = signal();
      const release = signal();
      const ingestion = db.transaction(async (trx) => {
        await trx("entity_aliases")
          .where({ project_id: projectId, journey_id: "jrn_1" })
          .forUpdate()
          .select("id");
        holding.fire();
        await release.promise;
        await upsertAliases(trx, projectId, [
          {
            journeyId: "jrn_1",
            aliasType: "salesforceAccountId",
            aliasValueHash: token(keyringB, "SF-1"),
            encryptedDisplayValue: ingested,
            value: "SF-1",
            displayable: false,
            supersedesValueHash: token(keyringA, "SF-1")
          }
        ]);
      });
      await holding.promise;

      const run = reencryptValues(db, rotated);
      await waitForLockWait(db);
      release.fire();
      await ingestion;

      expect(table(await run, "entity_aliases")).toMatchObject({
        rewritten: 0,
        changedDuringRun: 1,
        duplicatesRemoved: 0
      });
      expect(await aliasRows()).toEqual([
        {
          journeyId: "jrn_1",
          aliasType: "salesforceAccountId",
          hash: token(keyringB, "SF-1"),
          encrypted: ingested
        }
      ]);
    });

    for (const outcome of ["commits", "rolls back"] as const) {
      it(`settles an alias whose current-token row another transaction inserts during the run, which then ${outcome}`, async () => {
        // The run's existence check cannot see the uncommitted row, so its
        // update waits on that row's unique index entry. On commit the update
        // fails on the alias constraint, and the savepoint lets the run delete
        // the stale row instead of aborting the batch; on rollback the update
        // goes through.
        await journeyUnder(keyringB, "jrn_1", "E-1");
        await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
        const inserted = encryptValue(keyringB, "SF-1");

        const holding = signal();
        const release = signal();
        const rollback = new Error("roll back");
        const other = db.transaction(async (trx) => {
          await trx("entity_aliases").insert({
            project_id: projectId,
            journey_id: "jrn_1",
            alias_type: "salesforceAccountId",
            alias_value_hash: token(keyringB, "SF-1"),
            encrypted_display_value: inserted
          });
          holding.fire();
          await release.promise;
          if (outcome === "rolls back") throw rollback;
        });
        await holding.promise;

        const run = reencryptValues(db, rotated);
        await waitForLockWait(db);
        release.fire();
        if (outcome === "rolls back") await expect(other).rejects.toBe(rollback);
        else await other;

        const aliases = table(await run, "entity_aliases");
        const rows = await aliasRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.hash).toBe(token(keyringB, "SF-1"));
        if (outcome === "commits") {
          expect(aliases).toMatchObject({ rewritten: 0, duplicatesRemoved: 1 });
          expect(rows[0]?.encrypted).toBe(inserted);
        } else {
          expect(aliases).toMatchObject({ rewritten: 1, duplicatesRemoved: 0 });
          expect(rows[0]?.encrypted).not.toBe(inserted);
          expect(decryptValue(keyringB, rows[0]?.encrypted ?? "")).toBe("SF-1");
        }
      });
    }

    it("reports the lock as held to a second run that starts while the first is working", async () => {
      for (const n of [1, 2, 3, 4])
        await journeyUnder(keyringA, `jrn_${String(n)}`, `E-${String(n)}`);

      let second: ReencryptResult | undefined;
      const first = await reencryptValues(db, rotated, {
        batchSize: 2,
        onBatch: async () => {
          second ??= await reencryptValues(db, rotated);
        }
      });

      expect(second).toEqual({ ran: false, reason: "lock_held" });
      expect(table(first, "journeys").rewritten).toBe(4);
      // Released once the first finished.
      expect((await reencryptValues(db, rotated)).ran).toBe(true);
    });

    it("does not hold back vacuum while it holds the lock", async () => {
      // The lock's connection stays in a transaction for the whole run. If it
      // also kept a snapshot (a parameterised query leaves its portal open
      // until the transaction ends), its backend_xmin would stop VACUUM
      // anywhere in the database from removing rows that died during the run.
      for (const n of [1, 2, 3, 4])
        await journeyUnder(keyringA, `jrn_${String(n)}`, `E-${String(n)}`);

      const seen: unknown[] = [];
      await reencryptValues(db, rotated, {
        batchSize: 2,
        onBatch: async () => {
          const result: unknown = await db.raw(
            `select a.backend_xmin::text as xmin
               from pg_locks l join pg_stat_activity a on a.pid = l.pid
              where l.locktype = 'advisory' and l.granted`
          );
          seen.push(...(result as { rows: { xmin: string | null }[] }).rows);
        }
      });

      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toEqual(seen.map(() => ({ xmin: null })));
    });

    it("stops after the current batch and says so when the connection holding its lock is terminated", async () => {
      // For example by idle_in_transaction_session_timeout. Carrying on would
      // run without the lock, beside any second run that took it meanwhile.
      for (const n of [1, 2, 3, 4, 5, 6])
        await journeyUnder(keyringA, `jrn_${String(n)}`, `E-${String(n)}`);

      let terminated = false;
      const result = await reencryptValues(db, rotated, {
        batchSize: 2,
        onBatch: async () => {
          if (terminated) return;
          terminated = true;
          await terminateAdvisoryLockHolder(db);
        }
      });

      expect(result).toMatchObject({ ran: true, lockLost: true });
      expect(result.ran && result.tables.map((entry) => entry.table)).toEqual(["journeys"]);
      expect(table(result, "journeys")).toMatchObject({ rewritten: 2, batches: 1 });
      const keyIds = (await journeyRows()).map((row) => keyIdOf(row.encrypted ?? ""));
      expect(keyIds.filter((id) => id === keyringB.current.id)).toHaveLength(2);

      // Nothing it did needs undoing; the next run finishes the work.
      const again = await reencryptValues(db, rotated, { batchSize: 2 });
      expect(again).toMatchObject({ ran: true, lockLost: false });
      expect(table(again, "journeys")).toMatchObject({ rewritten: 4, alreadyCurrent: 2 });
    });

    it("releases the lock when a run fails", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      await expect(
        reencryptValues(db, rotated, {
          onBatch: () => {
            throw new Error("interrupted");
          }
        })
      ).rejects.toThrow("interrupted");
      expect((await reencryptValues(db, rotated)).ran).toBe(true);
    });
  });

  describe("rotationStatus", () => {
    it("counts each table's rows by key and lists API keys not under the current key", async () => {
      await journeyUnder(keyringB, "jrn_1", "E-1");
      await journeyUnder(keyringB, "jrn_2", "E-2");
      await journeyUnder(keyringA, "jrn_3", "E-3");
      await journey("jrn_4", legacy(keyringA, "E-4"), token(keyringA, "E-4"));
      await journeyUnder(keyringC, "jrn_5", "E-5");
      await journey("jrn_6", "fr1.zz.payload", "h6");
      await journey("jrn_7", null, "h7");
      await aliasUnder(keyringB, "jrn_1", "salesforceAccountId", "SF-1");
      await aliasUnder(keyringA, "jrn_3", "salesforceAccountId", "SF-3");
      await destination("no-headers", null);
      await destination("old", encryptValue(keyringA, "{}"));

      const usedAt = new Date("2026-09-14T10:00:00.000Z");
      await apiKey("current", keyringB.current.id);
      const previousPrefix = await apiKey("worker", keyringA.current.id, { lastUsedAt: usedAt });
      const unrecordedPrefix = await apiKey("pre-012", null);
      const unknownPrefix = await apiKey("orphan", keyringC.current.id);
      // A revoked key never authenticates again, so it could never migrate.
      await apiKey("revoked", keyringA.current.id, { revoked: true });

      const status = await rotationStatus(db, rotated);
      expect(status.currentKeyId).toBe(keyringB.current.id);
      expect(status.previousKeyId).toBe(keyringA.current.id);
      expect(status.tables).toEqual([
        {
          table: "journeys",
          current: 2,
          previous: 1,
          legacy: 1,
          unknownKey: 1,
          malformed: 1,
          noValue: 1,
          unknownKeyIds: [keyringC.current.id]
        },
        {
          table: "entity_aliases",
          current: 1,
          previous: 1,
          legacy: 0,
          unknownKey: 0,
          malformed: 0,
          noValue: 0,
          unknownKeyIds: []
        },
        {
          table: "replay_destinations",
          current: 0,
          previous: 1,
          legacy: 0,
          unknownKey: 0,
          malformed: 0,
          noValue: 1,
          unknownKeyIds: []
        }
      ]);
      expect(status.apiKeys.current).toBe(1);
      expect(status.apiKeys.notCurrent).toEqual(
        expect.arrayContaining([
          {
            keyPrefix: previousPrefix,
            name: "worker",
            projectSlug: "acme",
            environmentName: "production",
            keyHashKeyId: keyringA.current.id,
            lastUsedAt: usedAt
          },
          expect.objectContaining({ keyPrefix: unrecordedPrefix, keyHashKeyId: null })
        ])
      );
      expect(status.apiKeys.notCurrent).toHaveLength(2);
      // Under a key in neither slot: it cannot authenticate, so it will not move.
      expect(status.apiKeys.unknownKey).toEqual([
        expect.objectContaining({ keyPrefix: unknownPrefix, keyHashKeyId: keyringC.current.id })
      ]);
      // During a rotation a key with no recorded id may be under either key.
      expect(status.apiKeys.notRecorded).toEqual([]);
      expect(status.rowsRemaining).toBe(6);
      expect(status.complete).toBe(false);
    });

    it("counts rows under a removed previous key as unknown", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      const status = await rotationStatus(db, keyringB);
      expect(status.previousKeyId).toBeNull();
      expect(status.tables[0]).toMatchObject({
        previous: 0,
        unknownKey: 1,
        unknownKeyIds: [keyringA.current.id]
      });
    });

    it("reports complete once nothing remains under another key", async () => {
      await journeyUnder(keyringB, "jrn_1", "E-1");
      // Nothing to rewrite in a row with no value, so it does not hold status open.
      await journey("jrn_2", null, "h2");
      await destination("no-headers", null);
      await apiKey("current", keyringB.current.id);
      await apiKey("revoked", keyringA.current.id, { revoked: true });

      const status = await rotationStatus(db, rotated);
      expect(status.rowsRemaining).toBe(0);
      expect(status.apiKeys.notCurrent).toEqual([]);
      expect(status.apiKeys.unknownKey).toEqual([]);
      expect(status.complete).toBe(true);
    });
  });

  describe("findUnreadableData", () => {
    it("finds nothing on an install whose data every key in the keyring reads", async () => {
      await journeyUnder(keyringB, "jrn_1", "E-1");
      await journeyUnder(keyringA, "jrn_2", "E-2");
      await journey("jrn_3", legacy(keyringA, "E-3"), token(keyringA, "E-3"));
      await journey("jrn_4", null, "h4");
      await destination("old", legacy(keyringA, "{}"));
      await apiKey("previous", keyringA.current.id);
      // Unrecorded keys cannot be judged without the plaintext key.
      await apiKey("pre-012", null);

      expect(await findUnreadableData(db, rotated)).toEqual({
        tables: [
          { table: "journeys", unknownKey: 0, malformed: 0, legacyUnreadable: 0 },
          { table: "entity_aliases", unknownKey: 0, malformed: 0, legacyUnreadable: 0 },
          { table: "replay_destinations", unknownKey: 0, malformed: 0, legacyUnreadable: 0 }
        ],
        apiKeys: 0,
        total: 0
      });
    });

    it("counts values under keys the keyring lacks, malformed values, and unreadable legacy rows", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      await journeyUnder(keyringA, "jrn_2", "E-2");
      await journey("jrn_3", "fr1.zz.payload", "h3");
      await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");
      await destination("legacy-1", legacy(keyringA, "{}"));
      await destination("legacy-2", legacy(keyringA, "{}"));
      await apiKey("previous", keyringA.current.id);
      await apiKey("revoked", keyringA.current.id, { revoked: true });
      await apiKey("current", keyringB.current.id);

      // The previous key removed before re-encryption ran.
      expect(await findUnreadableData(db, keyringB)).toEqual({
        tables: [
          { table: "journeys", unknownKey: 2, malformed: 1, legacyUnreadable: 0 },
          { table: "entity_aliases", unknownKey: 1, malformed: 0, legacyUnreadable: 0 },
          { table: "replay_destinations", unknownKey: 0, malformed: 0, legacyUnreadable: 2 }
        ],
        apiKeys: 1,
        total: 7
      });
    });

    it("samples the last legacy row as well as the first", async () => {
      // Legacy rows name no key, so only a sample is decrypted. The oldest row
      // alone can miss a later stretch written under a key since removed.
      await journey("jrn_1", legacy(keyringB, "E-1"), token(keyringB, "E-1"));
      await journey("jrn_2", legacy(keyringB, "E-2"), token(keyringB, "E-2"));
      await journey("jrn_3", legacy(keyringC, "E-3"), token(keyringC, "E-3"));

      const found = await findUnreadableData(db, rotated);
      expect(found.tables[0]).toEqual({
        table: "journeys",
        unknownKey: 0,
        malformed: 0,
        legacyUnreadable: 3
      });
    });
  });

  describe("the CLI", () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const tsx = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

    interface Run {
      code: number;
      stdout: string;
      stderr: string;
    }

    const cli = (command: string, keys: Record<string, string>): Promise<Run> =>
      new Promise((resolve) => {
        execFile(
          tsx,
          ["src/cli.ts", command],
          {
            cwd: packageRoot,
            env: {
              PATH: process.env["PATH"] ?? "",
              // Workspace packages resolve to their TypeScript source, as they do
              // under the package scripts, so this runs from an unbuilt checkout.
              NODE_OPTIONS: "--conditions=development",
              DATABASE_URL: container.getConnectionUri(),
              ...keys
            }
          },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
            resolve({ code, stdout, stderr });
          }
        );
      });

    const rotating = { ENCRYPTION_KEY: KEY_B, ENCRYPTION_KEY_PREVIOUS: KEY_A };

    it("rotate:status exits 1 while rows remain under another key and 0 once rotate:reencrypt has run", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");

      const before = await cli("rotate:status", rotating);
      expect(before.code).toBe(1);
      expect(before.stdout).toMatch(/^journeys\s+0\s+1\s/m);

      const run = await cli("rotate:reencrypt", rotating);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(
        new RegExp(
          `^Re-encrypting under key ${keyringB.current.id}, reading values under ${keyringA.current.id} and legacy values\\.`
        )
      );
      expect(run.stdout).toMatch(/^journeys\s+1\s+0\s+0\s+0\s/m);
      expect(run.stdout).toMatch(/^entity_aliases\s+1\s+0\s+0\s+0\s+0/m);

      const after = await cli("rotate:status", rotating);
      expect(after.code).toBe(0);
      expect(after.stdout).toMatch(/^journeys\s+1\s+0\s/m);
    }, 60_000);

    it("rotate:status exits 1 while an API key has not moved to the current key", async () => {
      const prefix = await apiKey("worker", keyringA.current.id);
      const run = await cli("rotate:status", rotating);
      expect(run.code).toBe(1);
      expect(run.stdout).toContain(prefix);
      expect(run.stdout).toContain("worker");
    }, 60_000);

    it("rotate:reencrypt with no previous key upgrades legacy values, says so, and lets status reach 0", async () => {
      await journey("jrn_1", legacy(keyringB, "E-1"), token(keyringB, "E-1"));
      await apiKey("pre-012", null);
      const upgrading = { ENCRYPTION_KEY: KEY_B };

      expect((await cli("rotate:status", upgrading)).code).toBe(1);

      const run = await cli("rotate:reencrypt", upgrading);
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(
        new RegExp(`^Upgrading legacy values under key ${keyringB.current.id}\\.`)
      );
      expect(run.stdout).toMatch(/^journeys\s+1\s+0\s+0\s+0\s/m);

      const again = await cli("rotate:reencrypt", upgrading);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("Nothing to upgrade");

      const status = await cli("rotate:status", upgrading);
      expect(status.stdout).toContain(
        "API keys with key id not recorded yet; recorded on next use: 1"
      );
      expect(status.code).toBe(0);
    }, 60_000);

    it("rotate:reencrypt says the lock is held and exits 1 while another run holds it", async () => {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let acquired: () => void = () => undefined;
      const holding = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const holder = db.transaction(async (trx) => {
        await trx.raw("select pg_advisory_xact_lock(?)", [ROTATION_LOCK_KEY]);
        acquired();
        await released;
      });
      await holding;

      try {
        const run = await cli("rotate:reencrypt", rotating);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain("holds the rotation lock");
        // Nothing was re-encrypted, so nothing may say it is.
        expect(run.stdout).toBe("");
      } finally {
        release();
        await holder;
      }
    }, 60_000);

    it("rotate:reencrypt exits 1 and says to start again when it loses its lock mid-run", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      await aliasUnder(keyringA, "jrn_1", "salesforceAccountId", "SF-1");

      // Hold the journey row so the CLI's first batch waits on it, which is
      // the moment to terminate the connection holding its lock.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const rowLock = db.transaction(async (trx) => {
        await trx("journeys").where({ id: "jrn_1" }).forUpdate().select("id");
        holding();
        await released;
      });
      await held;

      const running = cli("rotate:reencrypt", rotating);
      try {
        await waitForLockWait(db);
        await terminateAdvisoryLockHolder(db);
      } finally {
        release();
        await rowLock;
      }

      const run = await running;
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("lost the rotation lock");
      expect(run.stderr).toContain("run rotate:reencrypt again");
    }, 60_000);

    it("refuses one key set as both current and previous with a message, not a stack trace", async () => {
      const run = await cli("rotate:status", {
        ENCRYPTION_KEY: KEY_A,
        ENCRYPTION_KEY_PREVIOUS: KEY_A
      });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("ENCRYPTION_KEY_PREVIOUS is the same key as ENCRYPTION_KEY");
      expect(run.stderr).not.toMatch(/\n\s+at /);
    }, 60_000);
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
  throw new Error("Nothing ever waited on a lock.");
}

/**
 * Terminate the backend holding a granted advisory lock, as a server timeout
 * would, and wait until it is gone.
 */
async function terminateAdvisoryLockHolder(db: Knex): Promise<void> {
  const holders: unknown = await db.raw(
    "select pid from pg_locks where locktype = 'advisory' and granted"
  );
  const pids = (holders as { rows: { pid: number }[] }).rows.map((row) => row.pid);
  expect(pids).toHaveLength(1);
  const [pid] = pids;
  if (pid === undefined) throw new Error("No backend holds an advisory lock.");
  await db.raw("select pg_terminate_backend(?)", [pid]);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive: unknown = await db.raw(
      "select count(*)::int as n from pg_stat_activity where pid = ?",
      [pid]
    );
    if ((alive as { rows: { n: number }[] }).rows[0]?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The lock holder was not terminated.");
}
