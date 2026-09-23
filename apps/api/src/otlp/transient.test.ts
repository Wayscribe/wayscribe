import { describe, expect, it } from "vitest";
import { isTransientDatabaseError } from "./transient.js";

const withCode = (code: string): Error => Object.assign(new Error("x"), { code });

describe("transient database errors", () => {
  it.each([
    "57014", // statement timeout
    "08006", // connection failure
    "08001",
    "53300", // too many connections
    "57P01", // admin shutdown
    "57P03", // cannot connect now
    "40001", // serialization failure
    "40P01", // deadlock
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN"
  ])("treats %s as transient", (code) => {
    expect(isTransientDatabaseError(withCode(code))).toBe(true);
  });

  it("treats a pool acquire timeout and a dropped connection as transient", () => {
    const acquire = Object.assign(new Error("Knex: Timeout acquiring a connection."), {
      name: "KnexTimeoutError"
    });
    expect(isTransientDatabaseError(acquire)).toBe(true);
    expect(isTransientDatabaseError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it.each([
    withCode("42P01"), // undefined table: a deployment defect, not a blip
    withCode("23505"),
    withCode("22P02"),
    new TypeError("Cannot read properties of undefined"),
    new RangeError("invalid_otlp_response"),
    null,
    "string"
  ])("treats %s as permanent", (error) => {
    expect(isTransientDatabaseError(error)).toBe(false);
  });
});
