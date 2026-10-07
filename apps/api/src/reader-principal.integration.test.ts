import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseApiKeys } from "./auth.js";
import { principalEnvironmentId, principalProjectId, resolvePrincipal } from "./principal.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const READ_TOKEN = "read-token-for-tests-000000000000";

describe("the reader principal", () => {
  let container: TestDatabase;
  let db: Knex;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const resolve = (token: string, options: { readToken?: string | undefined; project?: string } = {}) =>
    resolvePrincipal({
      db,
      apiKeys: databaseApiKeys(db, keyring, (error) => {
        throw error;
      }),
      adminToken: ADMIN_TOKEN,
      readToken: "readToken" in options ? options.readToken : READ_TOKEN,
      authorizationHeader: `Bearer ${token}`,
      requestedProjectId: options.project
    });

  it("resolves the read token to a reader of the only project, across its environments", async () => {
    const result = await resolve(READ_TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.kind).toBe("reader");
    expect(principalProjectId(result.principal)).toBe(projectA);
    expect(principalEnvironmentId(result.principal)).toBeUndefined();
  });

  it("is not a reader when no read token is configured", async () => {
    const result = await resolve(READ_TOKEN, { readToken: undefined });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("answers a reader naming no project, among several, as an admin is answered", async () => {
    projectB = await insertReturningId(db, "projects", { name: "B", slug: "b" });
    expect(await resolve(READ_TOKEN)).toMatchObject({ ok: false, status: 404 });
    const named = await resolve(READ_TOKEN, { project: projectB });
    expect(named.ok && named.principal).toMatchObject({ kind: "reader", projectId: projectB });
  });

  it("still resolves the admin token to an admin", async () => {
    const result = await resolve(ADMIN_TOKEN, { project: projectA });
    expect(result.ok && result.principal.kind).toBe("admin");
  });
});
