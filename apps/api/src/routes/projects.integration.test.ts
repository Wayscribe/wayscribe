import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId } from "@flight-recorder/database";
import { deriveSubkeys, generateApiKey } from "@flight-recorder/payload-security";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

describe("GET /v1/projects", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const projectA = await insertReturningId(db, "projects", { name: "Zebra", slug: "zebra" });
    await insertReturningId(db, "projects", { name: "Alpha", slug: "alpha" });
    const environment = await insertReturningId(db, "environments", {
      project_id: projectA,
      name: "development"
    });

    const generated = generateApiKey(subkeys.apiKey);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectA,
      environment_id: environment,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier
    });

    app = buildApp({ db, subkeys, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("lists every project for an admin, without needing one to be named", async () => {
    // The point of this route: it answers the question a caller has *before* it
    // can name a project, so it must work with more than one project present.
    const response = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.items.map((p: { slug: string }) => p.slug)).toEqual(["alpha", "zebra"]);
  });

  it("rejects a valid API key", async () => {
    // An API key is scoped to one project by construction, so it has nothing to
    // choose between; enumerating an installation is an operator action.
    const response = await app.inject({
      method: "GET",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/projects" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/projects",
          headers: { authorization: "Bearer not-the-admin-token-000000000" }
        })
      ).statusCode
    ).toBe(401);
  });
});

describe("reads with two projects present", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let projectA: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectA = await insertReturningId(db, "projects", { name: "A", slug: "a" });
    await insertReturningId(db, "projects", { name: "B", slug: "b" });
    app = buildApp({ db, subkeys, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("refuses to guess when no project is named", async () => {
    // This is the failure the web interface used to render as "Nothing matched".
    const response = await app.inject({
      method: "GET",
      url: "/v1/search?q=anything",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("project_not_found");
  });

  it("succeeds once the project is named", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/search?q=anything",
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-flight-project-id": projectA
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([]);
  });
});
