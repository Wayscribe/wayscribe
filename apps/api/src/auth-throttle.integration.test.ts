import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, issueKey } from "@flight-recorder/database";
import { createKeyring } from "@flight-recorder/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = ["admin-token", "for-tests", "0000000000000000"].join("-");
const WRONG_TOKEN = ["admin-token", "for-tests", "1111111111111111"].join("-");

/**
 * The admin token is one shared secret that reads every payload, and the API
 * compared it in constant time and without limit. The web login throttled
 * guesses; the API it signs in to did not, so a guesser went to the API.
 */
describe("failed admin authentication is throttled per source address", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let projectId: string;
  let apiKey: string;

  const appWith = (trustedProxyCount?: number): FastifyInstance =>
    buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      logLevel: "silent",
      ...(trustedProxyCount === undefined ? {} : { trustedProxyCount })
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    projectId = await insertReturningId(db, "projects", { name: "T", slug: "t" });
    apiKey = (
      await issueKey(db, keyring, { projectSlug: "t", environmentName: "development", name: "k" })
    ).apiKey;
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  const attempt = (
    app: FastifyInstance,
    token: string,
    remoteAddress: string,
    request: {
      method?: "GET" | "POST" | "DELETE";
      url?: string;
      headers?: Record<string, string>;
    } = {}
  ) =>
    app.inject({
      method: request.method ?? "GET",
      url: request.url ?? "/v1/journeys/jrn_x",
      remoteAddress,
      headers: {
        authorization: `Bearer ${token}`,
        "x-flight-project-id": projectId,
        ...request.headers
      }
    });

  it("answers the first five failures with the ordinary 401, then 429 to everything", async () => {
    const app = appWith();
    // Every admin-capable route counts towards one budget.
    const routes = [
      { url: "/v1/journeys/jrn_x" },
      { url: "/v1/search?q=x" },
      { url: "/v1/projects" },
      { method: "DELETE" as const, url: "/v1/journeys/jrn_x" },
      { url: "/v1/replays/00000000-0000-4000-8000-000000000000" }
    ];
    const ordinary: string[] = [];
    for (const route of routes) {
      const response = await attempt(app, WRONG_TOKEN, "203.0.113.10", route);
      expect(response.statusCode, route.url).toBe(401);
      const { requestId: _requestId, ...error } = response.json<{
        error: { code: string; message: string; requestId: string };
      }>().error;
      ordinary.push(JSON.stringify(error));
      expect(error.code).toBe("unauthorized");
    }
    // The 401 bodies are what they were: nothing says a limit is near.
    expect(ordinary.join("")).not.toMatch(/attempt|limit|throttl/i);

    const locked = await attempt(app, WRONG_TOKEN, "203.0.113.10");
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe("too_many_attempts");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);

    // The right token too: otherwise a guesser keeps guessing and reads the
    // one 200 among the 429s.
    const right = await attempt(app, ADMIN_TOKEN, "203.0.113.10");
    expect(right.statusCode).toBe(429);

    // Another address is untouched.
    const other = await attempt(app, ADMIN_TOKEN, "203.0.113.11");
    expect(other.statusCode).toBe(404);
    await app.close();
  });

  it("does not count ingestion's refusals, and never throttles ingestion", async () => {
    const app = appWith();
    for (let i = 0; i < 8; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: "203.0.113.20",
        headers: { authorization: `Bearer fr_${"x".repeat(32)}` },
        payload: {}
      });
      expect(response.statusCode).toBe(401);
    }
    expect((await attempt(app, ADMIN_TOKEN, "203.0.113.20")).statusCode).toBe(404);

    for (let i = 0; i < 5; i += 1) await attempt(app, WRONG_TOKEN, "203.0.113.21");
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/events",
      remoteAddress: "203.0.113.21",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {}
    });
    expect(ingest.statusCode).toBe(400);
    await app.close();
  });

  it("does not count a request that presents no credentials", async () => {
    const app = appWith();
    for (let i = 0; i < 8; i += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/journeys/jrn_x",
        remoteAddress: "203.0.113.30"
      });
      expect(response.statusCode).toBe(401);
    }
    expect((await attempt(app, ADMIN_TOKEN, "203.0.113.30")).statusCode).toBe(404);
    await app.close();
  });

  it("keys on the socket address and ignores X-Forwarded-For by default", async () => {
    const app = appWith();
    for (let i = 0; i < 5; i += 1) {
      await attempt(app, WRONG_TOKEN, "203.0.113.40", {
        headers: { "x-forwarded-for": `198.51.100.${String(i)}` }
      });
    }
    const response = await attempt(app, ADMIN_TOKEN, "203.0.113.40", {
      headers: { "x-forwarded-for": "198.51.100.200" }
    });
    expect(response.statusCode).toBe(429);
    await app.close();
  });

  it("honours X-Forwarded-For that many hops from the right with TRUSTED_PROXY_COUNT", async () => {
    const app = appWith(1);
    const proxy = "10.0.0.5";
    // The client can prepend anything; the proxy appends what it saw.
    for (let i = 0; i < 5; i += 1) {
      await attempt(app, WRONG_TOKEN, proxy, {
        headers: { "x-forwarded-for": `spoofed-${String(i)}, 198.51.100.7` }
      });
    }
    const same = await attempt(app, ADMIN_TOKEN, proxy, {
      headers: { "x-forwarded-for": "another-spoof, 198.51.100.7" }
    });
    expect(same.statusCode).toBe(429);

    // Another client behind the same proxy is not locked out with it.
    const neighbour = await attempt(app, ADMIN_TOKEN, proxy, {
      headers: { "x-forwarded-for": "198.51.100.8" }
    });
    expect(neighbour.statusCode).toBe(404);
    await app.close();
  });
});
