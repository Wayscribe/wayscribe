import { startPostgres, type TestDatabase } from "../testing/postgres.js";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertReturningId } from "../insert.js";
import { createKnexConfig } from "../knex-config.js";
import { findApiKeyByPrefix, replaceApiKeyVerifier } from "./api-keys.js";

describe("API key verifiers", () => {
  let container: TestDatabase;
  let db: Knex;
  let projectId: string;
  let environmentId: string;

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
    await insertKey("wsk_labelled", { key_hash: "aa", key_hash_key_id: "0123456789ab" });
    expect((await findApiKeyByPrefix(db, "wsk_labelled"))?.keyHashKeyId).toBe("0123456789ab");
  });

  it("returns a null key id for a key issued before verifiers were labelled", async () => {
    await insertKey("wsk_unlabeld", { key_hash: "bb" });
    expect((await findApiKeyByPrefix(db, "wsk_unlabeld"))?.keyHashKeyId).toBeNull();
  });

  it("replaces a verifier that has not changed since it was read", async () => {
    const id = await insertKey("wsk_replace1", { key_hash: "cc" });
    expect(
      await replaceApiKeyVerifier(db, id, "cc", { keyHash: "dd", keyHashKeyId: "ba9876543210" })
    ).toBe(true);
    const context = await findApiKeyByPrefix(db, "wsk_replace1");
    expect(context?.keyHash).toBe("dd");
    expect(context?.keyHashKeyId).toBe("ba9876543210");
  });

  it("leaves a verifier alone when another writer changed it first", async () => {
    // Two requests presenting the same key during a rotation both try to move
    // it. The loser must not overwrite whatever the winner, or the demo seed,
    // wrote in between.
    const id = await insertKey("wsk_replace2", { key_hash: "ee", key_hash_key_id: "111111111111" });
    expect(
      await replaceApiKeyVerifier(db, id, "stale", { keyHash: "ff", keyHashKeyId: "222222222222" })
    ).toBe(false);
    const context = await findApiKeyByPrefix(db, "wsk_replace2");
    expect(context?.keyHash).toBe("ee");
    expect(context?.keyHashKeyId).toBe("111111111111");
  });
});
