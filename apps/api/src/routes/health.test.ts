import { createKeyring } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

function fakeDb(): Knex {
  return {
    raw: () => Promise.resolve({ rows: [{ "?column?": 1 }] }),
    migrate: { list: () => Promise.resolve([[], []]) }
  } as unknown as Knex;
}

describe("GET /health", () => {
  it("returns 200 while the process is serving", async () => {
    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db: fakeDb(),
      logLevel: "silent"
    });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });

    await app.close();
  });

  it("does not touch the database", async () => {
    let dbWasCalled = false;
    const db = {
      raw: () => {
        dbWasCalled = true;
        return Promise.resolve({});
      },
      migrate: { list: () => Promise.resolve([[], []]) }
    } as unknown as Knex;

    const app = buildApp({
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      db,
      logLevel: "silent"
    });
    await app.inject({ method: "GET", url: "/health" });

    expect(dbWasCalled).toBe(false);

    await app.close();
  });
});
