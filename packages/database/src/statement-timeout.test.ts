import { describe, expect, it } from "vitest";
import { createKnexConfig } from "./knex-config.js";
import { isStatementTimeout } from "./statement-timeout.js";

describe("isStatementTimeout", () => {
  it("recognises PostgreSQL's query_canceled SQLSTATE", () => {
    expect(
      isStatementTimeout(Object.assign(new Error("canceling statement"), { code: "57014" }))
    ).toBe(true);
  });

  it.each([
    ["another SQLSTATE", Object.assign(new Error("unique violation"), { code: "23505" })],
    ["a plain error", new Error("57014")],
    ["undefined", undefined],
    ["a string", "57014"]
  ])("does not match %s", (_label, error) => {
    expect(isStatementTimeout(error)).toBe(false);
  });
});

describe("createKnexConfig", () => {
  const url = "postgresql://flight:flight@localhost:5432/flight";

  it("sets no afterCreate hook without a timeout, or with 0", () => {
    expect(createKnexConfig(url).pool).not.toHaveProperty("afterCreate");
    expect(createKnexConfig(url, { statementTimeoutMs: 0 }).pool).not.toHaveProperty("afterCreate");
  });

  it("sets statement_timeout on every new connection", () => {
    const pool = createKnexConfig(url, { statementTimeoutMs: 1500 }).pool as {
      afterCreate: (
        connection: { query: (sql: string, callback: (error: Error | null) => void) => void },
        done: (error: Error | null, connection: unknown) => void
      ) => void;
    };
    const statements: string[] = [];
    const connection = {
      query: (sql: string, callback: (error: Error | null) => void): void => {
        statements.push(sql);
        callback(null);
      }
    };
    let handed: unknown;
    pool.afterCreate(connection, (_error, created) => {
      handed = created;
    });
    expect(statements).toEqual(["SET statement_timeout = 1500"]);
    expect(handed).toBe(connection);
  });

  it.each([-1, 1.5, Number.NaN])("refuses %s, which would be inlined into SQL", (value) => {
    expect(() => createKnexConfig(url, { statementTimeoutMs: value })).toThrow(RangeError);
  });
});
