import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import {
  createKeyring,
  encryptValue,
  issueApiKey,
  searchTokens,
  type Keyring
} from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { buildApp } from "./app.js";
import { checkKeysAtBoot } from "./key-warnings.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210";
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

const keyringA = createKeyring(KEY_A);
const keyringB = createKeyring(KEY_B);
const rotated = createKeyring(KEY_B, KEY_A);

interface LogLine {
  level: number;
  msg: string;
  [field: string]: unknown;
}

const WARN = 40;

describe("key warnings", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
  });

  beforeEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await db("journeys").del();
    await db("replay_destinations").del();
    await db("api_keys").del();
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await db.destroy();
    await container.stop();
  });

  /** An API over this database, with every log line it writes captured. */
  const boot = (
    keyring: Keyring,
    database: Knex = db
  ): { app: FastifyInstance; lines: LogLine[] } => {
    const lines: LogLine[] = [];
    const app = buildApp({
      db: database,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "info",
      logStream: { write: (line: string) => lines.push(JSON.parse(line) as LogLine) }
    });
    apps.push(app);
    return { app, lines };
  };

  const warnings = (lines: LogLine[]): LogLine[] => lines.filter((line) => line.level === WARN);

  const journeyUnder = async (keyring: Keyring, id: string, entityId: string): Promise<void> => {
    await db("journeys").insert({
      id,
      project_id: projectId,
      environment_id: environmentId,
      entity_type: "customer",
      primary_entity_id_hash: searchTokens(keyring, entityId)[0],
      encrypted_primary_entity_id: encryptValue(keyring, entityId),
      status: "active",
      started_at: db.fn.now(),
      last_event_at: db.fn.now(),
      event_count: 1
    });
  };

  const storeKey = async (keyring: Keyring, name: string): Promise<string> => {
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
  };

  describe("checkKeysAtBoot", () => {
    it("stays silent on a clean install", async () => {
      const { app, lines } = boot(keyringB);
      await checkKeysAtBoot(app.db, keyringB, app.log);
      expect(warnings(lines)).toEqual([]);
    });

    it("stays silent during a rotation, when the previous key reads what the current one cannot", async () => {
      await journeyUnder(keyringA, "jrn_a", "E-A");
      await journeyUnder(keyringB, "jrn_b", "E-B");
      await storeKey(keyringA, "not-yet-migrated");

      const { app, lines } = boot(rotated);
      await checkKeysAtBoot(app.db, rotated, app.log);
      expect(warnings(lines)).toEqual([]);
    });

    it("logs one warning with per-table counts when rows and keys are under a key it lacks", async () => {
      // The previous key removed before rotate:reencrypt ran.
      await journeyUnder(keyringA, "jrn_1", "E-1");
      await journeyUnder(keyringA, "jrn_2", "E-2");
      await journeyUnder(keyringB, "jrn_3", "E-3");
      await db("replay_destinations").insert({
        project_id: projectId,
        name: "old",
        base_url: "http://localhost:3300",
        environment_type: "development",
        encrypted_headers: encryptValue(keyringA, "{}")
      });
      await storeKey(keyringA, "worker");

      const { app, lines } = boot(keyringB);
      await checkKeysAtBoot(app.db, keyringB, app.log);

      const [warning, ...rest] = warnings(lines);
      expect(rest).toEqual([]);
      expect(warning).toMatchObject({
        unreadable: { journeys: 2, entity_aliases: 0, replay_destinations: 1, api_keys: 1 }
      });
      expect(warning?.msg).toContain("rotate:status");
      // Recreate, not restart: a restarted container keeps its old environment.
      expect(warning?.msg).toContain(
        "restore it and recreate the API containers (docs/OPERATIONS.md §6)."
      );
      expect(warning?.msg).not.toMatch(/\brestart\b/);
    });

    it("does not run the check against a database with migrations pending", async () => {
      // The API starts before migrations in some deployments, and the columns
      // the check reads may not exist yet. Health reports the pending
      // migrations; the check waits for the next boot.
      await db.raw("create database unmigrated");
      const unmigrated = knex(
        createKnexConfig(container.getConnectionUri().replace(/\/[^/]+$/, "/unmigrated"))
      );
      try {
        const { app, lines } = boot(keyringB, unmigrated);
        await expect(checkKeysAtBoot(unmigrated, keyringB, app.log)).resolves.toBeUndefined();
        expect(warnings(lines)).toEqual([]);
      } finally {
        await unmigrated.destroy();
      }
    });
  });

  describe("reads under a key the keyring lacks", () => {
    it("log one warning per key id, naming only the id", async () => {
      await journeyUnder(keyringA, "jrn_1", "E-1");
      await journeyUnder(keyringA, "jrn_2", "E-2");
      const apiKey = await storeKey(keyringB, "reader");

      const { app, lines } = boot(keyringB);
      const read = (url: string) =>
        app.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey}` } });

      expect((await read("/v1/journeys/jrn_1")).json().data.entity.id).toBeNull();
      expect((await read("/v1/journeys/jrn_2")).statusCode).toBe(200);
      expect((await read("/v1/journeys/jrn_1")).statusCode).toBe(200);

      const unknownKeyWarnings = warnings(lines).filter((line) => "keyId" in line);
      expect(unknownKeyWarnings).toHaveLength(1);
      expect(unknownKeyWarnings[0]).toMatchObject({ keyId: keyringA.current.id });
      expect(JSON.stringify(unknownKeyWarnings[0])).not.toContain("E-1");
    });
  });
});
