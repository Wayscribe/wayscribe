import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

/** The value every journey below shares, as a reused fake identity does. */
const ALIAS = "shared@example.test";

/**
 * `GET /v1/search` had no window and no environment filter, so an identifier
 * that repeats across runs returned every journey that ever carried it: F-028
 * saw 5 to 8 hits where the run expected 1, because the scenario tool draws
 * from a fixed pool of fake people and only a lead id is fresh each run.
 *
 * `since`, `until` and `environment` are optional. Without them the search
 * still spans the project's whole history, so no caller breaks.
 */
describe("narrowing a search", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let projectId: string;
  let devKey: string;
  let prodKey: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    devKey = (
      await issueKey(db, keyring, {
        projectSlug: "acme",
        environmentName: "development",
        name: "dev"
      })
    ).apiKey;
    prodKey = (
      await issueKey(db, keyring, {
        projectSlug: "acme",
        environmentName: "production",
        name: "prod"
      })
    ).apiKey;

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });

    // Through the real write path, so the rows are what ingestion produces.
    const ingest = (key: string, environment: string, journeyId: string, at: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${key}` },
        payload: {
          protocolVersion: "0.1",
          event: {
            id: `evt_${journeyId}`,
            journeyId,
            environment,
            service: "intake",
            entity: { type: "lead", id: `${journeyId}-entity` },
            operation: "received",
            name: "receive-form",
            timestamp: at,
            aliases: { email: ALIAS }
          }
        } as object
      });

    await ingest(devKey, "development", "jrn_old", "2026-08-01T10:00:00.000Z");
    await ingest(devKey, "development", "jrn_new", "2026-09-15T10:00:00.000Z");
    await ingest(prodKey, "production", "jrn_prod", "2026-09-15T11:00:00.000Z");
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const search = (query: string, key = devKey) =>
    app.inject({
      method: "GET",
      url: `/v1/search?${query}`,
      headers: { authorization: `Bearer ${key}` }
    });

  const admin = (query: string) =>
    app.inject({
      method: "GET",
      url: `/v1/search?${query}`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-wayscribe-project-id": projectId
      }
    });

  const found = (response: Awaited<ReturnType<typeof search>>): string[] => {
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().data.items as { journeyId: string }[])
      .map((item) => item.journeyId)
      .sort();
  };

  const q = `q=${encodeURIComponent(ALIAS)}`;

  it("spans the project's whole history when nothing narrows it", async () => {
    // Unchanged behaviour, and the reason F-028 was surprising.
    expect(found(await search(q))).toEqual(["jrn_new", "jrn_old"]);
    expect(found(await admin(q))).toEqual(["jrn_new", "jrn_old", "jrn_prod"]);
  });

  it("returns only the journeys whose last activity is at or after since", async () => {
    expect(found(await search(`${q}&since=2026-09-01T00:00:00Z`))).toEqual(["jrn_new"]);
  });

  it("returns only the journeys whose last activity is before until", async () => {
    expect(found(await search(`${q}&until=2026-09-01T00:00:00Z`))).toEqual(["jrn_old"]);
  });

  it("takes both bounds together", async () => {
    expect(
      found(await search(`${q}&since=2026-07-01T00:00:00Z&until=2026-09-01T00:00:00Z`))
    ).toEqual(["jrn_old"]);
    expect(
      found(await search(`${q}&since=2026-09-16T00:00:00Z&until=2026-09-17T00:00:00Z`))
    ).toEqual([]);
  });

  it("includes a journey whose last activity falls exactly on since", async () => {
    expect(found(await search(`${q}&since=2026-09-15T10:00:00Z`))).toEqual(["jrn_new"]);
  });

  it("excludes a journey whose last activity falls exactly on until", async () => {
    // Half-open, as the journey list's window is, so two adjacent windows
    // neither overlap nor skip a journey.
    expect(found(await search(`${q}&until=2026-09-15T10:00:00Z`))).toEqual(["jrn_old"]);
  });

  describe("environment", () => {
    it("lets an admin pick one environment of the project", async () => {
      expect(found(await admin(`${q}&environment=production`))).toEqual(["jrn_prod"]);
      expect(found(await admin(`${q}&environment=development`))).toEqual(["jrn_new", "jrn_old"]);
    });

    it("is a no-op for an API key naming its own environment", async () => {
      // ADR-029: the key already reads its own environment and nothing else,
      // so naming it can only restate the scope.
      expect(found(await search(`${q}&environment=development`))).toEqual(["jrn_new", "jrn_old"]);
    });

    it("gives an API key naming another environment an empty page, not an error", async () => {
      // Applied on top of the scope, never instead of it. Outside its scope
      // nothing exists, which is how the journey list answers the same request.
      const response = await search(`${q}&environment=production`);
      expect(response.statusCode).toBe(200);
      expect(found(response)).toEqual([]);
    });

    it("never lets an environment name widen a key past its own scope", async () => {
      // The dangerous direction: the production journey must stay invisible to
      // the development key whatever it asks for.
      for (const value of ["production", "PRODUCTION", "", "development"]) {
        const items = found(await search(`${q}&environment=${encodeURIComponent(value)}`));
        expect(items, value).not.toContain("jrn_prod");
      }
    });
  });

  describe("refusals", () => {
    it.each([
      ["an unknown parameter", "status=failed"],
      ["a misspelt environment filter", "enviroment=production"],
      ["a since that is not a full instant", "since=2026-09-01"],
      ["a since naming an impossible day", "since=2026-02-30T00:00:00Z"],
      ["an until that is not a full instant", "until=2026-09-01"],
      ["an until at or before since", "since=2026-09-01T00:00:00Z&until=2026-09-01T00:00:00Z"],
      ["a repeated since", "since=2026-09-01T00:00:00Z&since=2026-09-02T00:00:00Z"],
      ["a repeated environment", "environment=a&environment=b"]
    ])("refuses %s with 400 invalid_query", async (_name, extra) => {
      const response = await search(`${q}&${extra}`);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.code).toBe("invalid_query");
    });

    it("names the parameters it does have", async () => {
      const message = (await search(`${q}&status=failed`)).json().error.message;
      expect(message).toBe(
        "status is not a parameter of this search. Known parameters: q, since, until, environment, limit, cursor."
      );
    });

    it("keeps the answers it already gave for q", async () => {
      for (const [url, message] of [
        ["/v1/search", "q is required."],
        ["/v1/search?q=", "q is required."],
        ["/v1/search?q=a&q=b", "q may be given once."]
      ]) {
        const response = await app.inject({
          method: "GET",
          url: url as string,
          headers: { authorization: `Bearer ${devKey}` }
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("invalid_query");
        expect(response.json().error.message).toBe(message);
      }
    });

    it("still refuses a bad cursor as invalid_cursor, not invalid_query", async () => {
      const response = await search(`${q}&cursor=not-a-cursor`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_cursor");
    });
  });

  it("keeps the window while paging", async () => {
    // The cursor holds a position only, so it continues the filters the
    // request carries, exactly as the journey list's does.
    const first = await search(`${q}&since=2026-07-01T00:00:00Z&limit=1`);
    expect(first.statusCode).toBe(200);
    const cursor = first.json().data.nextCursor;
    expect(cursor).not.toBeNull();
    expect(found(first)).toEqual(["jrn_new"]);

    const second = await search(
      `${q}&since=2026-07-01T00:00:00Z&limit=1&cursor=${encodeURIComponent(cursor as string)}`
    );
    expect(found(second)).toEqual(["jrn_old"]);
  });
});
