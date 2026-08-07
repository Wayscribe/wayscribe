import { deriveSubkeys } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const subkeys = deriveSubkeys("0123456789abcdef0123456789abcdef");

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
    const app = buildApp({ subkeys, db: fakeDb(), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });

    await app.close();
  });

  it("returns 503 with a reason when the database is unreachable", async () => {
    const app = buildApp({ subkeys, db: fakeDb({ reachable: false }), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      reason: "database_unreachable"
    });

    await app.close();
  });

  it("returns 503 when migrations are pending", async () => {
    const app = buildApp({ subkeys, db: fakeDb({ pendingMigrations: 3 }), logLevel: "silent" });
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
    const app = buildApp({ subkeys, db: fakeDb({ reachable: false }), logLevel: "silent" });
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.body).not.toContain("ECONNREFUSED");

    await app.close();
  });
});
