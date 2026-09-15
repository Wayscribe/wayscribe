import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { findApiKeyByPrefix, replaceApiKeyVerifier } from "./api-keys.js";

describe("API key verifiers", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const insertKey = (prefix: string, row: Record<string, unknown>): Promise<string> =>
    insertReturningId(db, "api_keys", {
      project_id: projectId,
      environment_id: environmentId,
      name: prefix,
      key_prefix: prefix,
      ...row
    });

  it("returns the verifier's key id with the lookup", async () => {
    await insertKey("fr_labelled1", { key_hash: "aa", key_hash_key_id: "0123456789ab" });
    expect((await findApiKeyByPrefix(db, "fr_labelled1"))?.keyHashKeyId).toBe("0123456789ab");
  });

  it("returns a null key id for a key issued before verifiers were labelled", async () => {
    await insertKey("fr_unlabeled", { key_hash: "bb" });
    expect((await findApiKeyByPrefix(db, "fr_unlabeled"))?.keyHashKeyId).toBeNull();
  });

  it("replaces a verifier that has not changed since it was read", async () => {
    const id = await insertKey("fr_replace01", { key_hash: "cc" });
    expect(
      await replaceApiKeyVerifier(db, id, "cc", { keyHash: "dd", keyHashKeyId: "ba9876543210" })
    ).toBe(true);
    const context = await findApiKeyByPrefix(db, "fr_replace01");
    expect(context?.keyHash).toBe("dd");
    expect(context?.keyHashKeyId).toBe("ba9876543210");
  });

  it("leaves a verifier alone when another writer changed it first", async () => {
    // Two requests presenting the same key during a rotation both try to move
    // it. The loser must not overwrite whatever the winner, or the demo seed,
    // wrote in between.
    const id = await insertKey("fr_replace02", { key_hash: "ee", key_hash_key_id: "111111111111" });
    expect(
      await replaceApiKeyVerifier(db, id, "stale", { keyHash: "ff", keyHashKeyId: "222222222222" })
    ).toBe(false);
    const context = await findApiKeyByPrefix(db, "fr_replace02");
    expect(context?.keyHash).toBe("ee");
    expect(context?.keyHashKeyId).toBe("111111111111");
  });
});
