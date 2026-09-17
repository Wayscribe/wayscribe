import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  createKnexConfig,
  insertReturningId,
  reencryptValues,
  rotationStatus,
  type ReencryptResult,
  type RotationStatus
} from "@wayscribe/database";
import {
  API_KEY_PREFIX_LENGTH,
  createKeyring,
  decryptValue,
  issueApiKey,
  parseEncryptedValue,
  searchTokens,
  type Keyring
} from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
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

/**
 * Spec scenarios 3 and 4 for key rotation: re-encrypt, then remove the
 * previous key.
 *
 * Everything in the database was written by the API's own routes, under key A
 * and then during the grace period, so the command is run over what ingestion
 * really produces, including a journey created before the rotation that kept
 * receiving events after it.
 */
describe("key rotation completion", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;
  let app: FastifyInstance | undefined;

  const keyringA = createKeyring(KEY_A);
  const rotated = createKeyring(KEY_B, KEY_A);
  const keyringB = createKeyring(KEY_B);

  let queryKey: string;
  let ingestKey: string;
  let idleKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });

    queryKey = await storeKey(keyringA, "query-key");
    ingestKey = await storeKey(keyringA, "ingest-key");
    // Never presented during the grace period, so it never moves to B.
    idleKey = await storeKey(keyringA, "idle-key");

    const beforeRotation = boot(keyringA);
    expect((await ingest(beforeRotation, "evt_a1", "jrn_rot")).statusCode).toBe(202);
    await close();

    const grace = boot(rotated);
    // A later event on the journey created under A. Ingestion leaves an
    // existing journey row as it is, token and ciphertext included.
    expect((await ingest(grace, "evt_b1", "jrn_rot")).statusCode).toBe(202);
    expect((await ingest(grace, "evt_b2", "jrn_new")).statusCode).toBe(202);
    expect((await get(grace, queryKey, `/v1/search?q=${ENTITY_ID}`)).statusCode).toBe(200);
    await close();
  });

  afterEach(async () => {
    await close();
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  function boot(keyring: Keyring): FastifyInstance {
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    return app;
  }

  async function close(): Promise<void> {
    await app?.close();
    app = undefined;
  }

  async function storeKey(keyring: Keyring, name: string): Promise<string> {
    const issued = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name,
      key_prefix: issued.keyPrefix,
      key_hash: issued.verifier,
      key_hash_key_id: issued.keyHashKeyId
    });
    return issued.apiKey;
  }

  function ingest(server: FastifyInstance, id: string, journeyId: string) {
    return server.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${ingestKey}` },
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
  }

  function get(server: FastifyInstance, apiKey: string, url: string) {
    return server.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey}` } });
  }

  const journey = async (
    journeyId: string
  ): Promise<{ primary_entity_id_hash: string; encrypted_primary_entity_id: string }> =>
    await db("journeys")
      .where({ project_id: projectId, id: journeyId })
      .first("primary_entity_id_hash", "encrypted_primary_entity_id");

  const tokenB = (value: string): string | undefined => searchTokens(keyringB, value)[0];

  it("leaves a journey created under A on A's token while new events arrive", async () => {
    const row = await journey("jrn_rot");
    expect(keyIdOf(row.encrypted_primary_entity_id)).toBe(keyringA.current.id);
    expect(row.primary_entity_id_hash).toBe(searchTokens(keyringA, ENTITY_ID)[0]);
  });

  describe("scenario 3: rotate:reencrypt", () => {
    let statusBefore: RotationStatus;
    let first: ReencryptResult;
    let second: ReencryptResult;

    beforeAll(async () => {
      statusBefore = await rotationStatus(db, rotated);
      first = await reencryptValues(db, rotated);
      second = await reencryptValues(db, rotated);
    });

    it("found work before it ran, including the API key never used during the grace period", () => {
      expect(statusBefore.complete).toBe(false);
      expect(statusBefore.tables[0]).toMatchObject({ table: "journeys", previous: 1, current: 1 });
      expect(statusBefore.apiKeys.notCurrent.map((key) => key.name)).toEqual(["idle-key"]);
    });

    it("moves every row, the stale journey included, onto B's key and B's tokens", async () => {
      const rows: { primary_entity_id_hash: string; encrypted_primary_entity_id: string }[] =
        await db("journeys")
          .where({ project_id: projectId })
          .select("primary_entity_id_hash", "encrypted_primary_entity_id");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(keyIdOf(row.encrypted_primary_entity_id)).toBe(keyringB.current.id);
        expect(decryptValue(keyringB, row.encrypted_primary_entity_id)).toBe(ENTITY_ID);
        expect(row.primary_entity_id_hash).toBe(tokenB(ENTITY_ID));
      }

      const aliases: { alias_value_hash: string; encrypted_display_value: string }[] = await db(
        "entity_aliases"
      )
        .where({ project_id: projectId })
        .select("alias_value_hash", "encrypted_display_value");
      expect(aliases).toHaveLength(2);
      for (const alias of aliases) {
        expect(keyIdOf(alias.encrypted_display_value)).toBe(keyringB.current.id);
        expect(alias.alias_value_hash).toBe(tokenB(ALIAS_VALUE));
      }

      expect(first.ran && first.tables[0]).toMatchObject({ table: "journeys", rewritten: 1 });
    });

    it("rewrites nothing the second time", () => {
      if (!second.ran) throw new Error(second.reason);
      expect(second.tables.map((table) => table.rewritten)).toEqual([0, 0, 0]);
    });

    it("leaves only the idle API key for status to report", async () => {
      const status = await rotationStatus(db, rotated);
      expect(status.rowsRemaining).toBe(0);
      expect(status.apiKeys.notCurrent.map((key) => key.keyPrefix)).toEqual([
        idleKey.slice(0, API_KEY_PREFIX_LENGTH)
      ]);
      expect(status.complete).toBe(false);
    });

    describe("scenario 4: restarted with B and no previous key", () => {
      it("finds the journey by entity id and by alias value", async () => {
        const server = boot(keyringB);
        const byEntity = await get(server, queryKey, `/v1/search?q=${ENTITY_ID}`);
        expect(
          (byEntity.json().data.items as { journeyId: string }[]).map((item) => item.journeyId)
        ).toEqual(expect.arrayContaining(["jrn_rot", "jrn_new"]));

        const byAlias = await get(server, queryKey, `/v1/search?q=${ALIAS_VALUE}`);
        expect(byAlias.json().data.items).toHaveLength(2);
      });

      it("decrypts the detail of the journey created before the rotation", async () => {
        const server = boot(keyringB);
        const response = await get(server, queryKey, "/v1/journeys/jrn_rot");
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toMatchObject({
          entity: { id: ENTITY_ID },
          aliases: [{ type: "salesforceAccountId", displayValue: "SF-A…001", displayable: false }]
        });
      });

      it("accepts events from the key that migrated on use", async () => {
        const server = boot(keyringB);
        expect((await ingest(server, "evt_c1", "jrn_rot")).statusCode).toBe(202);
      });

      it("refuses the key never used during the grace period, which status had listed", async () => {
        const server = boot(keyringB);
        const response = await get(server, idleKey, `/v1/search?q=${ENTITY_ID}`);
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("unauthorized");
      });
    });
  });
});
