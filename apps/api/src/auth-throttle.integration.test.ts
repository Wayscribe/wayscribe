import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
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
  let container: TestDatabase;
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
    container = await startPostgres();
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
        "x-wayscribe-project-id": projectId,
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

  const tally = (statuses: number[]): Record<string, number> =>
    statuses.reduce<Record<string, number>>((counts, status) => {
      counts[String(status)] = (counts[String(status)] ?? 0) + 1;
      return counts;
    }, {});

  it("answers exactly five sequential guesses with 401 and the sixth with 429, on each kind of route", async () => {
    const app = appWith();
    const kinds: [string, string, { method?: "GET" | "DELETE"; url: string }][] = [
      [
        "admin route, wrong admin token",
        WRONG_TOKEN,
        { method: "DELETE", url: "/v1/journeys/jrn_x" }
      ],
      ["projects, wrong admin token", WRONG_TOKEN, { url: "/v1/projects" }],
      ["read route, wrong admin token", WRONG_TOKEN, { url: "/v1/journeys/jrn_x" }],
      ["read route, unknown API key", `wsk_${"B".repeat(32)}`, { url: "/v1/search?q=x" }]
    ];
    let source = 70;
    for (const [kind, token, route] of kinds) {
      source += 1;
      const address = `203.0.113.${String(source)}`;
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await attempt(app, token, address, route)).statusCode);
      }
      expect(statuses, kind).toEqual([401, 401, 401, 401, 401, 429]);
    }
    await app.close();
  });

  it("bounds a concurrent burst of bad API keys, and refuses the next request after it", async () => {
    // Failures are counted, not attempts in flight: every request in a burst
    // that passed the lock check before the fifth failure was recorded still
    // has its key looked up. That is at most the burst's own concurrency, and
    // the lock holds from then on.
    const app = appWith();
    const BURST = 50;
    const responses = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        attempt(app, `wsk_${String(i).padStart(32, "C")}`, "203.0.113.60")
      )
    );
    const counts = tally(responses.map((r) => r.statusCode));
    expect(Object.keys(counts).every((status) => status === "401" || status === "429")).toBe(true);
    expect(counts["401"] ?? 0).toBeGreaterThanOrEqual(5);
    expect(counts["401"] ?? 0).toBeLessThanOrEqual(BURST);

    const next = await attempt(app, apiKey, "203.0.113.60", { url: "/v1/journeys/jrn_x" });
    expect(next.statusCode).toBe(429);
    await app.close();
  });

  it("never holds back the admin token's own concurrent reads", async () => {
    // The web app reads from one address with the admin token, many requests
    // at once.
    const app = appWith();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => attempt(app, ADMIN_TOKEN, "203.0.113.62"))
    );
    expect(tally(responses.map((r) => r.statusCode))).toEqual({ "404": 100 });
    await app.close();
  });

  it("serves 50 concurrent valid-key reads from one address", async () => {
    // A version that reserved a slot per attempt in flight answered the sixth
    // concurrent read with 429: 20 at once got 5 answers and 15 refusals.
    const app = appWith();
    for (const url of [
      "/v1/search?q=anything",
      "/v1/journeys?since=2026-01-01T00:00:00Z",
      "/v1/journeys/jrn_x"
    ]) {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () => attempt(app, apiKey, "203.0.113.64", { url }))
      );
      const expected = url === "/v1/journeys/jrn_x" ? "404" : "200";
      expect(tally(responses.map((r) => r.statusCode)), url).toEqual({ [expected]: 50 });
    }
    await app.close();
  });

  it("does not count a database error while a key is looked up", async () => {
    // A 500 is the server's failure, not a refused credential: an outage must
    // not lock out every reader.
    const broken = knex(createKnexConfig("postgresql://nobody:nothing@127.0.0.1:1/none"));
    const app = buildApp({ db: broken, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    for (let i = 0; i < 8; i += 1) {
      const response = await attempt(app, apiKey, "203.0.113.65", { url: "/v1/search?q=x" });
      expect(response.statusCode).toBe(500);
    }
    await app.close();
    await broken.destroy();
  });

  it("does not count ingestion's refusals, and never throttles ingestion", async () => {
    const app = appWith();
    for (let i = 0; i < 8; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/events",
        remoteAddress: "203.0.113.20",
        headers: { authorization: `Bearer wsk_${"x".repeat(32)}` },
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
