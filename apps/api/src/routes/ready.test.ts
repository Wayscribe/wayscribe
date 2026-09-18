import { createKeyring } from "@wayscribe/payload-security";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

interface FakeDbOptions {
  reachable?: boolean;
  pendingMigrations?: number;
}

function fakeDb({ reachable = true, pendingMigrations = 0 }: FakeDbOptions = {}): Knex {
  return {
    raw: () =>
      reachable
        ? Promise.resolve({ rows: [{ "?column?": 1 }] })
        : Promise.reject(new Error("ECONNREFUSED")),
    migrate: {
      list: () =>
        Promise.resolve([
          [],
          Array.from({ length: pendingMigrations }, (_, i) => `${String(i)}.ts`)
        ])
    }
  } as unknown as Knex;
}

describe("GET /ready", () => {
  it("returns 200 when the database is reachable and the schema is current", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb(),
      logLevel: "silent",
      running: { version: "v0.1.0", source: "build" }
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", version: "v0.1.0", source: "build" });

    await app.close();
  });

  it("says what the API is running", async () => {
    // F-007: neither health endpoint named a version, a commit or an image
    // tag, so a report that records what it ran against had to take the
    // operator's own pin on trust.
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb(),
      logLevel: "silent",
      running: { version: "v0.1.0", commit: "27f4d64e0b5a", source: "build" }
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.json()).toEqual({
      status: "ready",
      version: "v0.1.0",
      commit: "27f4d64e0b5a",
      source: "build"
    });

    await app.close();
  });

  it("omits the commit when the build recorded none", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb(),
      logLevel: "silent",
      running: { version: "0.0.0", source: "package" }
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.json()).toEqual({ status: "ready", version: "0.0.0", source: "package" });

    await app.close();
  });

  it("reports a version even when it is not ready", async () => {
    // The case that matters most: something is wrong and the first question is
    // what is running.
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb({ pendingMigrations: 2 }),
      logLevel: "silent",
      running: { version: "v0.1.0", source: "build" }
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "migrations_pending",
      version: "v0.1.0",
      source: "build"
    });

    await app.close();
  });

  it("answers with the running build when nothing is injected", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb(),
      logLevel: "silent"
    });
    const body: { version: string; source: string } = (
      await app.inject({ method: "GET", url: "/ready" })
    ).json();

    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
    expect(["build", "package"]).toContain(body.source);

    await app.close();
  });

  it("returns 503 with a reason when the database is unreachable", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb({ reachable: false }),
      logLevel: "silent"
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "database_unreachable"
    });

    await app.close();
  });

  it("returns 503 when migrations are pending", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb({ pendingMigrations: 3 }),
      logLevel: "silent"
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "migrations_pending",
      pendingCount: 3
    });

    await app.close();
  });

  it("reports database_unreachable rather than leaking the driver error", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb({ reachable: false }),
      logLevel: "silent"
    });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.body).not.toContain("ECONNREFUSED");

    await app.close();
  });
});
