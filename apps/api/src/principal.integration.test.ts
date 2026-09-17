import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, searchJourneys } from "@wayscribe/database";
import { createKeyring, issueApiKey, searchTokens } from "@wayscribe/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { databaseApiKeys } from "./auth.js";
import { principalEnvironmentId, principalProjectId, resolvePrincipal } from "./principal.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

describe("principal resolution", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectA: string;
  let projectB: string;
  let devEnv: string;
  let stagingEnv: string;
  let apiKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
    projectB = await insertReturningId(db, "projects", { name: "B", slug: "b" });
    devEnv = await insertReturningId(db, "environments", {
      project_id: projectA,
      name: "development"
    });
    stagingEnv = await insertReturningId(db, "environments", {
      project_id: projectA,
      name: "staging"
    });
    const envB = await insertReturningId(db, "environments", {
      project_id: projectB,
      name: "development"
    });

    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectA,
      environment_id: devEnv,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });

    const journey = async (id: string, projectId: string, environmentId: string) => {
      await db("journeys").insert({
        id,
        project_id: projectId,
        environment_id: environmentId,
        entity_type: "customer",
        primary_entity_id_hash: searchTokens(keyring, "SHARED-ID")[0],
        status: "active",
        started_at: "2026-08-06T10:00:00Z",
        last_event_at: "2026-08-06T10:00:00Z",
        event_count: 1
      });
    };

    await journey("jrn_dev", projectA, devEnv);
    await journey("jrn_staging", projectA, stagingEnv);
    await journey("jrn_other_project", projectB, envB);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const resolve = (header: string | undefined, requestedProjectId?: string) =>
    resolvePrincipal({
      db,
      apiKeys: databaseApiKeys(db, keyring, (error) => {
        throw error;
      }),
      adminToken: ADMIN_TOKEN,
      authorizationHeader: header,
      requestedProjectId
    });

  it("resolves a valid API key", async () => {
    const result = await resolve(`Bearer ${apiKey}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.kind).toBe("apiKey");
  });

  it("resolves the admin token", async () => {
    const result = await resolve(`Bearer ${ADMIN_TOKEN}`, projectA);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.kind).toBe("admin");
  });

  it("rejects an unknown token with the same message as a revoked one", async () => {
    const unknown = await resolve("Bearer wsk_totallyunknownkey");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(401);
  });

  it("rejects an admin token naming a project that does not exist", async () => {
    const result = await resolve(`Bearer ${ADMIN_TOKEN}`, "00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("project_not_found");
    }
  });

  it("requires a project when more than one exists and none is named", async () => {
    const result = await resolve(`Bearer ${ADMIN_TOKEN}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("scopes an API key to one environment", async () => {
    const result = await resolve(`Bearer ${apiKey}`);
    if (!result.ok) throw new Error("expected success");
    expect(principalEnvironmentId(result.principal)).toBe(devEnv);

    const page = await searchJourneys(
      db,
      { projectId: principalProjectId(result.principal), environmentId: devEnv },
      "SHARED-ID",
      searchTokens(keyring, "SHARED-ID"),
      25
    );
    expect(page.items.map((i) => i.journeyId)).toEqual(["jrn_dev"]);
  });

  it("lets an admin read across every environment of its project", async () => {
    const result = await resolve(`Bearer ${ADMIN_TOKEN}`, projectA);
    if (!result.ok) throw new Error("expected success");
    expect(principalEnvironmentId(result.principal)).toBeUndefined();

    const page = await searchJourneys(
      db,
      {
        projectId: principalProjectId(result.principal),
        environmentId: principalEnvironmentId(result.principal)
      },
      "SHARED-ID",
      searchTokens(keyring, "SHARED-ID"),
      25
    );
    expect(page.items.map((i) => i.journeyId).sort()).toEqual(["jrn_dev", "jrn_staging"]);
  });

  it("never lets an admin read across projects", async () => {
    // The dangerous widening: environment omitted must mean "all environments of
    // this project", never "all projects".
    const result = await resolve(`Bearer ${ADMIN_TOKEN}`, projectA);
    if (!result.ok) throw new Error("expected success");

    const page = await searchJourneys(
      db,
      {
        projectId: principalProjectId(result.principal),
        environmentId: principalEnvironmentId(result.principal)
      },
      "SHARED-ID",
      searchTokens(keyring, "SHARED-ID"),
      25
    );
    expect(page.items.map((i) => i.journeyId)).not.toContain("jrn_other_project");
  });
});
