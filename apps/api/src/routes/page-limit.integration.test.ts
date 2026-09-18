import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

/** Every journey below carries it, so one search finds them all. */
const ALIAS = "page-limit@example.test";
const JOURNEYS = 5;
const SINCE = "2026-09-01T00:00:00.000Z";

const LIMIT_MESSAGE = "limit must be a whole number of at least 1; above 100 it is read as 100.";

/**
 * F-029, through the routes: `limit` was the one parameter exempt from the NUL
 * rule and the given-once rule, on every list endpoint. The rows below are the
 * finding's table, on each endpoint, plus the values that used to become the
 * default and the ones above the maximum, which are still read as it.
 */
describe("limit on the list endpoints", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "acme",
        environmentName: "development",
        name: "dev"
      })
    ).apiKey;

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });

    for (let index = 0; index < JOURNEYS; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            // One journey, jrn_limit_0, gets every event, so its timeline has
            // as many rows as there are journeys.
            id: `evt_limit_${String(index)}`,
            journeyId: index === 0 ? "jrn_limit_0" : `jrn_limit_${String(index)}`,
            environment: "development",
            service: "intake",
            entity: { type: "lead", id: `lead-${String(index)}` },
            operation: "received",
            name: "receive-form",
            timestamp: `2026-09-15T10:0${String(index)}:00.000Z`,
            aliases: { email: ALIAS }
          }
        } as object
      });
      expect(response.statusCode, response.body).toBe(202);
    }
    for (let index = 1; index < JOURNEYS; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            id: `evt_limit_0_${String(index)}`,
            journeyId: "jrn_limit_0",
            environment: "development",
            service: "intake",
            entity: { type: "lead", id: "lead-0" },
            operation: "transformed",
            name: "normalize",
            timestamp: `2026-09-15T11:0${String(index)}:00.000Z`
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

  const endpoints = [
    ["GET /v1/journeys", `/v1/journeys?since=${encodeURIComponent(SINCE)}`],
    ["GET /v1/search", `/v1/search?q=${encodeURIComponent(ALIAS)}`],
    ["GET /v1/journeys/:journeyId/events", "/v1/journeys/jrn_limit_0/events?"]
  ] as const;

  describe.each(endpoints)("%s", (_name, base) => {
    const join = base.endsWith("?") ? "" : "&";
    const request = (query: string) => get(`${base}${join}${query}`);

    it("pages by a limit given once", async () => {
      const response = await request("limit=2");
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.items).toHaveLength(2);
      expect(response.json().data.nextCursor).not.toBeNull();
    });

    it("uses the default when limit is omitted or empty", async () => {
      for (const query of ["", "limit="]) {
        const response = await request(query);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().data.items).toHaveLength(JOURNEYS);
      }
    });

    it.each(["limit=1&limit=99", "limit=99&limit=1"])(
      "refuses %s rather than reading one of them",
      async (query) => {
        const response = await request(query);
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error).toMatchObject({
          code: "invalid_query",
          message: "limit must be given once."
        });
      }
    );

    it("refuses a NUL in limit rather than reading the digits before it", async () => {
      const response = await request("limit=2%005");
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "invalid_query",
        message: "limit must not contain a null byte."
      });
    });

    it.each(["abc", "0", "-1", "2.5", "5abc"])(
      "refuses limit=%s rather than reading it as the default",
      async (value) => {
        const response = await request(`limit=${value}`);
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().error).toMatchObject({
          code: "invalid_query",
          message: LIMIT_MESSAGE
        });
      }
    );

    it.each(["101", "1000"])("reads limit=%s as the maximum, as it always has", async (value) => {
      const response = await request(`limit=${value}`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().data.items).toHaveLength(JOURNEYS);
      expect(response.json().data.nextCursor).toBeNull();
    });
  });

  describe("the timeline's other parameters", () => {
    // Search and the journey list refuse a key they do not read; the timeline
    // ignored one, so `?limt=5` returned the default page as if it had been
    // understood. It changes its error behaviour once, with limit.
    const timeline = "/v1/journeys/jrn_limit_0/events";

    it("refuses a key it does not read, naming the ones it does", async () => {
      const response = await get(`${timeline}?limt=5`);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "invalid_query",
        message: "limt is not a parameter of this timeline. Known parameters: limit, cursor."
      });
    });

    it("refuses a parameter name holding a null byte without echoing it", async () => {
      const response = await get(`${timeline}?limit%00=5`);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).not.toContain(String.fromCharCode(0));
      expect(response.json().error.message).toBe(
        "A parameter name must not contain a null byte. Known parameters: limit, cursor."
      );
    });

    it("still answers 404 for a journey that does not exist", async () => {
      const response = await get("/v1/journeys/jrn_missing/events");
      expect(response.statusCode, response.body).toBe(404);
    });
  });

  describe("the rest of F-029's table, which already held", () => {
    const NUL = "%00";

    it.each([
      [
        `/v1/journeys?since=${encodeURIComponent(SINCE)}&q=lead${NUL}x`,
        "q must not contain a null byte."
      ],
      [
        `/v1/journeys?since=${encodeURIComponent(SINCE)}${NUL}&limit=3`,
        "since must not contain a null byte."
      ],
      [`/v1/search?q=${encodeURIComponent(ALIAS)}&q=other`, "q may be given once."]
    ])("%s is refused with invalid_query", async (url, message) => {
      const response = await get(url);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toMatchObject({ code: "invalid_query", message });
    });

    it("refuses a repeated cursor as invalid_cursor", async () => {
      const response = await get(`/v1/search?q=${encodeURIComponent(ALIAS)}&cursor=x&cursor=y`);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toMatchObject({
        code: "invalid_cursor",
        message: "cursor may be given once."
      });
    });
  });
});
