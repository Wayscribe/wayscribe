import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

const BUILD_1 = { version: "1.4.2", gitCommit: "0123456789abcdef", image: "intake:1.4.2" };
const BUILD_2 = { version: "1.4.3", gitCommit: "fedcba9876543210" };

/**
 * F-043: the deployment was on `GET /v1/events/:id` and nowhere else, so
 * "did every event of this journey come from one build?" cost one full event
 * read per event, each carrying its whole input and output payloads to
 * deliver one short object. A timeline row now carries the event's
 * deployment, as it carries its service.
 */
describe("the deployment on a timeline row", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "acme",
        environmentName: "development",
        name: "d"
      })
    ).apiKey;
    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });

    const events = [
      { id: "evt_1", deployment: BUILD_1 },
      { id: "evt_2", deployment: BUILD_1 },
      { id: "evt_3", deployment: BUILD_2 },
      { id: "evt_4" }
    ];
    for (const [index, extra] of events.entries()) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            journeyId: "jrn_builds",
            environment: "development",
            service: "intake",
            entity: { type: "lead", id: "lead-1" },
            operation: "transformed",
            name: `step-${String(index)}`,
            timestamp: `2026-09-18T10:0${String(index)}:00.000Z`,
            input: { big: "x".repeat(2_000) },
            ...extra
          }
        } as object
      });
      expect(response.statusCode, response.body).toBe(202);
    }
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { authorization: `Bearer ${apiKey}` } });

  it("carries each event's deployment, and null where the event sent none", async () => {
    const response = await get("/v1/journeys/jrn_builds/events");
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json().data.items as { id: string; deploymentMetadata?: unknown }[];
    expect(rows.map((row) => [row.id, row.deploymentMetadata])).toEqual([
      ["evt_1", BUILD_1],
      ["evt_2", BUILD_1],
      ["evt_3", BUILD_2],
      ["evt_4", null]
    ]);
  });

  it("is the value the event read returns", async () => {
    const rows = (await get("/v1/journeys/jrn_builds/events")).json().data.items as {
      id: string;
      deploymentMetadata: unknown;
    }[];
    for (const row of rows) {
      const detail = (await get(`/v1/events/${row.id}`)).json().data as {
        deploymentMetadata: unknown;
      };
      expect(row.deploymentMetadata, row.id).toEqual(detail.deploymentMetadata);
    }
  });

  it("still carries no payload", async () => {
    const response = await get("/v1/journeys/jrn_builds/events");
    expect(response.body).not.toContain("x".repeat(100));
  });
});
