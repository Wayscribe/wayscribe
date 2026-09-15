import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createKeyring,
  decryptValue,
  encryptValue,
  issueApiKey,
  keyIdOf,
  searchTokens,
  type Keyring
} from "@flight-recorder/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import {
  ROTATION_LOCK_KEY,
  findUnreadableData,
  reencryptValues,
  rotationStatus,
  type ReencryptResult,
  type TableReencryption
} from "./rotation.js";

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
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
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
    it("refuses to run without a previous key and writes nothing", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      const before = await journeyRows();

      expect(await reencryptValues(db, keyringA)).toEqual({
        ran: false,
        reason: "no_previous_key"
      });
      expect(await journeyRows()).toEqual(before);
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
          expect.objectContaining({ keyPrefix: unrecordedPrefix, keyHashKeyId: null }),
          expect.objectContaining({ keyPrefix: unknownPrefix, keyHashKeyId: keyringC.current.id })
        ])
      );
      expect(status.apiKeys.notCurrent).toHaveLength(3);
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

    it("rotate:reencrypt refuses without a previous key and says what to set", async () => {
      const run = await cli("rotate:reencrypt", { ENCRYPTION_KEY: KEY_B });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("ENCRYPTION_KEY_PREVIOUS");
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
        expect(run.stderr).toMatch(/lock/i);
      } finally {
        release();
        await holder;
      }
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
