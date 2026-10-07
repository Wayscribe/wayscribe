import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { READER_ROUTES } from "./reader-routes.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const READ_TOKEN = "read-token-for-tests-000000000000";
const GUARD_MESSAGE = "The read-only token may call search and read routes only.";

/**
 * No query here reaches a database. A handler that tries meets a TypeError,
 * which the error handler answers with 500: never 403, so "not refused" stays
 * distinguishable from "refused by the guard".
 */
const db = {} as Knex;

const routeKey = (method: string, url: string): string =>
  `${method === "HEAD" ? "GET" : method} ${url}`;
const concrete = (url: string): string => url.replace(/:[A-Za-z]+/g, "x");

/**
 * The reader allowlist as a property (ADR-070): every route Fastify registers
 * is called with the read token, and only allowlisted ones get past the guard.
 * A route added later is in the inventory the moment it is registered, so it
 * is refused here until somebody allowlists it on purpose.
 */
describe("the reader allowlist", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({
      db,
      keyring,
      adminToken: ADMIN_TOKEN,
      readToken: READ_TOKEN,
      logLevel: "silent",
      otlpLogsEnabled: true
    });
    // Stand-ins for routes that do not exist yet. Key lifecycle is CLI-only
    // today (ROADMAP, "admin endpoints"); when it gets routes, they must be
    // refused to a reader exactly as these are.
    app.post("/v1/projects/:projectId/keys", () => ({ data: "created" }));
    app.delete("/v1/keys/:keyId", () => ({ data: "revoked" }));
    app.get("/v1/added-later", () => ({ data: "read" }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const asReader = (method: string, url: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: method as "GET",
      url: concrete(url),
      headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
      ...(method === "GET" || method === "HEAD" ? {} : { payload: "{}" })
    });

  const registered = (): Set<string> =>
    new Set(app.registeredRoutes.map((route) => routeKey(route.method, route.url)));

  it("sees every route the API registers, including the ones this suite names", () => {
    const keys = registered();
    for (const expected of [
      "POST /v1/events",
      "POST /v1/events/batch",
      "POST /v1/logs",
      "POST /v1/replay-destinations",
      "GET /v1/replay-destinations",
      "POST /v1/replays",
      "GET /v1/replays/:replayId",
      "DELETE /v1/journeys/:journeyId",
      "POST /v1/erasures",
      "DELETE /v1/replay-destinations/:destinationId",
      "POST /v1/projects/:projectId/keys",
      "DELETE /v1/keys/:keyId",
      "GET /v1/added-later"
    ]) {
      expect(keys, expected).toContain(expected);
    }
  });

  it("allowlists only routes that exist, so the list cannot rot", () => {
    const keys = registered();
    for (const allowed of READER_ROUTES) expect(keys, allowed).toContain(allowed);
  });

  it("refuses a reader with 403 on every registered route that is not allowlisted", async () => {
    const refused = app.registeredRoutes.filter(
      (route) => !READER_ROUTES.has(routeKey(route.method, route.url))
    );
    expect(refused.length).toBeGreaterThan(10);
    for (const route of refused) {
      const response = await asReader(route.method, route.url);
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      if (route.method !== "HEAD") {
        const error = response.json<{ error: { code: string; message: string } }>().error;
        expect(error.code).toBe("forbidden");
        expect(error.message, `${route.method} ${route.url}`).toBe(GUARD_MESSAGE);
      }
    }
  });

  // Named explicitly as well as swept above, so a change to the sweep (or to
  // the inventory) cannot quietly drop the routes that matter most.
  it.each([
    ["ingestion", "POST", "/v1/events"],
    ["batch ingestion", "POST", "/v1/events/batch"],
    ["OTLP logs", "POST", "/v1/logs"],
    ["replay", "POST", "/v1/replays"],
    ["replay destination", "POST", "/v1/replay-destinations"],
    ["journey delete", "DELETE", "/v1/journeys/j-1"],
    ["erasure", "POST", "/v1/erasures"],
    ["key creation", "POST", "/v1/projects/p-1/keys"],
    ["key revocation", "DELETE", "/v1/keys/k-1"]
  ])("refuses a reader %s with 403", async (_name, method, url) => {
    const response = await asReader(method, url);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("forbidden");
    expect(response.json<{ error: { message: string } }>().error.message).toBe(GUARD_MESSAGE);
  });

  it("lets a reader past the guard on every allowlisted route", async () => {
    const allowed = app.registeredRoutes.filter((route) =>
      READER_ROUTES.has(routeKey(route.method, route.url))
    );
    expect(allowed.length).toBeGreaterThanOrEqual(READER_ROUTES.size);
    for (const route of allowed) {
      const response = await asReader(route.method, route.url);
      expect(response.statusCode, `${route.method} ${route.url}`).not.toBe(403);
    }
  });

  it("leaves the admin token to each route's own check", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/added-later",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
  });

  it("does nothing when no read token is configured", async () => {
    const plain = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    plain.get("/v1/added-later", () => ({ data: "read" }));
    await plain.ready();
    const response = await plain.inject({
      method: "GET",
      url: "/v1/added-later",
      headers: { authorization: `Bearer ${READ_TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
    await plain.close();
  });
});
