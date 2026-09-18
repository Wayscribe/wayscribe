import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import {
  API_KEY_PREFIX_LENGTH,
  createKeyring,
  decryptValue,
  issueApiKey,
  parseEncryptedValue,
  searchTokens,
  verifyApiKeyWithKeyring,
  type Keyring
} from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/** The key id a stored value names, or null for a legacy value. */
const keyIdOf = (value: string): string | null => {
  const parsed = parseEncryptedValue(value);
  return parsed.kind === "envelope" ? parsed.keyId : null;
};

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

const ENTITY_ID = "0018Z00002ABC";
const ALIAS_VALUE = "SF-ALIAS-99001";

interface KeyRow {
  key_hash: string;
  key_hash_key_id: string | null;
}

interface AliasRow {
  alias_value_hash: string;
  encrypted_display_value: string;
}

/**
 * Spec scenarios 1 and 2 for key rotation, through the HTTP routes.
 *
 * Every step restarts the API the way an operator would: a new process with new
 * keys over the same database. Nothing is hand-inserted that ingestion would
 * write, so these read what the write path really produced.
 */
describe("key rotation grace period", () => {
  let container: TestDatabase;
  let db: Knex;
  let projectId: string;
  let environmentId: string;
  let app: FastifyInstance | undefined;

  const keyringA = createKeyring(KEY_A);
  const rotated = createKeyring(KEY_B, KEY_A);
  const keyringB = createKeyring(KEY_B);

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  /** Start the API as a fresh process would, with this keyring. */
  const boot = (keyring: Keyring): FastifyInstance => {
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    return app;
  };

  /** Store a key the way key:create does, under the given keyring. */
  const storeKey = async (
    keyring: Keyring,
    name: string,
    label: "labelled" | "unlabelled" = "labelled"
  ): Promise<string> => {
    const issued = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name,
      key_prefix: issued.keyPrefix,
      key_hash: issued.verifier,
      // A key issued before migration 012 has no id recorded.
      key_hash_key_id: label === "labelled" ? issued.keyHashKeyId : null
    });
    return issued.apiKey;
  };

  const keyRow = async (apiKey: string): Promise<KeyRow> =>
    await db("api_keys")
      .where({ key_prefix: apiKey.slice(0, API_KEY_PREFIX_LENGTH) })
      .first("key_hash", "key_hash_key_id");

  const verifiesOnlyUnder = (keyring: Keyring, apiKey: string, row: KeyRow): unknown =>
    verifyApiKeyWithKeyring(keyring, apiKey, {
      keyHash: row.key_hash,
      keyHashKeyId: row.key_hash_key_id
    });

  const ingest = (server: FastifyInstance, apiKey: string, id: string, journeyId: string) =>
    server.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        protocolVersion: "0.1",
        event: {
          id,
          journeyId,
          environment: "development",
          service: "customer-integration",
          entity: { type: "customer", id: ENTITY_ID },
          operation: "transformed",
          name: "transform-salesforce-account",
          timestamp: "2026-09-15T10:00:00.000Z",
          aliases: { salesforceAccountId: ALIAS_VALUE }
        }
      }
    });

  const get = (server: FastifyInstance, apiKey: string, url: string) =>
    server.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey}` } });

  const aliasRows = async (journeyId: string): Promise<AliasRow[]> =>
    await db("entity_aliases")
      .where({ project_id: projectId, journey_id: journeyId })
      .select("alias_value_hash", "encrypted_display_value");

  describe("scenario 1: data and keys written under A, read under current B and previous A", () => {
    let queryKey: string;
    let ingestKey: string;

    beforeAll(async () => {
      queryKey = await storeKey(keyringA, "query-key");
      ingestKey = await storeKey(keyringA, "ingest-key");

      const beforeRotation = boot(keyringA);
      expect((await ingest(beforeRotation, ingestKey, "evt_a1", "jrn_rot")).statusCode).toBe(202);
      await beforeRotation.close();
      app = undefined;
    });

    it("finds the journey by entity id", async () => {
      const server = boot(rotated);
      const response = await get(server, queryKey, `/v1/search?q=${ENTITY_ID}`);
      expect(response.statusCode).toBe(200);
      const [item] = response.json().data.items as { journeyId: string; entity: { id: string } }[];
      expect(item?.journeyId).toBe("jrn_rot");
      expect(item?.entity.id).toBe(ENTITY_ID);
    });

    it("finds the journey by alias value", async () => {
      const server = boot(rotated);
      const response = await get(server, queryKey, `/v1/search?q=${ALIAS_VALUE}`);
      expect(response.json().data.items.map((i: { journeyId: string }) => i.journeyId)).toEqual([
        "jrn_rot"
      ]);
    });

    it("decrypts the journey detail", async () => {
      const server = boot(rotated);
      const response = await get(server, queryKey, "/v1/journeys/jrn_rot");
      expect(response.statusCode).toBe(200);
      const data = response.json().data as {
        entity: { id: string };
        aliases: { type: string; displayValue: string; displayable: boolean }[];
      };
      expect(data.entity.id).toBe(ENTITY_ID);
      expect(data.aliases).toEqual([
        { type: "salesforceAccountId", displayValue: "SF-A…001", displayable: false }
      ]);
    });

    it("moves a key written under A onto B the first time it reads", async () => {
      // Reads authenticate through the query routes' principal resolution, a
      // separate code path from ingestion's. The key is this test's own, so the
      // result does not depend on which requests the tests above made.
      const readKey = await storeKey(keyringA, "read-key");
      expect(await keyRow(readKey)).toMatchObject({ key_hash_key_id: keyringA.current.id });

      const server = boot(rotated);
      expect((await get(server, readKey, `/v1/search?q=${ENTITY_ID}`)).statusCode).toBe(200);

      const row = await keyRow(readKey);
      expect(row.key_hash_key_id).toBe(keyringB.current.id);
      expect(verifiesOnlyUnder(keyringB, readKey, row)).toEqual({ ok: true, migrate: null });
    });

    it("authenticates an ingesting key written under A and moves it onto B", async () => {
      expect(await keyRow(ingestKey)).toMatchObject({ key_hash_key_id: keyringA.current.id });

      const server = boot(rotated);
      expect((await ingest(server, ingestKey, "evt_b0", "jrn_other")).statusCode).toBe(202);

      const row = await keyRow(ingestKey);
      expect(row.key_hash_key_id).toBe(keyringB.current.id);
      expect(verifiesOnlyUnder(keyringB, ingestKey, row)).toEqual({ ok: true, migrate: null });
    });

    it("still refuses a wrong key during the grace period", async () => {
      const server = boot(rotated);
      const forged = `${queryKey.slice(0, API_KEY_PREFIX_LENGTH)}not-the-real-remainder`;
      const response = await get(server, forged, `/v1/search?q=${ENTITY_ID}`);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("unauthorized");
    });

    describe("scenario 2: the same alias ingested again under B", () => {
      beforeAll(async () => {
        const server = boot(rotated);
        expect((await ingest(server, ingestKey, "evt_b1", "jrn_rot")).statusCode).toBe(202);
        await server.close();
        app = undefined;
      });

      it("keeps one alias row, now under B's token and B's key", async () => {
        const rows = await aliasRows("jrn_rot");
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.alias_value_hash).toBe(searchTokens(keyringB, ALIAS_VALUE)[0]);
        expect(keyIdOf(row?.encrypted_display_value ?? "")).toBe(keyringB.current.id);
        expect(decryptValue(keyringB, row?.encrypted_display_value ?? "")).toBe(ALIAS_VALUE);
      });

      it("shows the alias once in the journey detail", async () => {
        const server = boot(rotated);
        const response = await get(server, queryKey, "/v1/journeys/jrn_rot");
        expect(response.json().data.aliases).toEqual([
          { type: "salesforceAccountId", displayValue: "SF-A…001", displayable: false }
        ]);
      });

      it("writes new journeys under B alone", async () => {
        const journey = await db("journeys")
          .where({ project_id: projectId, id: "jrn_other" })
          .first("primary_entity_id_hash", "encrypted_primary_entity_id");
        expect(journey.primary_entity_id_hash).toBe(searchTokens(keyringB, ENTITY_ID)[0]);
        expect(keyIdOf(journey.encrypted_primary_entity_id)).toBe(keyringB.current.id);
        expect((await aliasRows("jrn_other")).map((row) => row.alias_value_hash)).toEqual([
          searchTokens(keyringB, ALIAS_VALUE)[0]
        ]);
      });
    });
  });

  describe("a key issued before key ids were recorded", () => {
    it("authenticates under the current key and gets that key's id recorded", async () => {
      const apiKey = await storeKey(keyringA, "pre-012-current", "unlabelled");
      const server = boot(keyringA);

      const response = await get(server, apiKey, `/v1/search?q=${ENTITY_ID}`);
      expect(response.statusCode).toBe(200);

      const row = await keyRow(apiKey);
      expect(row.key_hash_key_id).toBe(keyringA.current.id);
      expect(verifiesOnlyUnder(keyringA, apiKey, row)).toEqual({ ok: true, migrate: null });
    });

    it("authenticates under the previous key during a rotation and moves onto the current one", async () => {
      const apiKey = await storeKey(keyringA, "pre-012-previous", "unlabelled");
      const server = boot(rotated);

      expect((await ingest(server, apiKey, "evt_pre012", "jrn_pre012")).statusCode).toBe(202);

      const row = await keyRow(apiKey);
      expect(row.key_hash_key_id).toBe(keyringB.current.id);
      expect(verifiesOnlyUnder(keyringB, apiKey, row)).toEqual({ ok: true, migrate: null });
    });
  });
});
