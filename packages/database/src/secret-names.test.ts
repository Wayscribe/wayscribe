import { describe, expect, it } from "vitest";
import { SAMPLE_BOUNDS, secretNamesResult, suffixFilter } from "./secret-names.js";

/**
 * Doctor's report on stored key names that look like secrets (ADR-055). The
 * sample itself is tested against PostgreSQL in the integration test; this is
 * what doctor makes of it.
 */
describe("secretNamesResult", () => {
  it("passes when nothing secret-looking is stored in the clear", () => {
    expect(
      secretNamesResult({ events: 1_200, names: [{ name: "tokenCount", events: 900 }] })
    ).toEqual({
      status: "PASS",
      check: "Secret-looking names",
      detail:
        "No key that looks like a secret holds a plain value in the 1,200 most recent events sampled."
    });
  });

  it("says so when there was nothing to sample", () => {
    expect(secretNamesResult({ events: 0, names: [] })).toMatchObject({
      status: "PASS",
      detail: "No event is stored yet, so there was nothing to sample."
    });
  });

  it("warns with each name and how many sampled events hold it, most first", () => {
    const result = secretNamesResult({
      events: 2_000,
      names: [
        { name: "sessionCredential", events: 3 },
        { name: "orderId", events: 2_000 },
        { name: "authToken", events: 12 }
      ]
    });
    expect(result).toEqual({
      status: "WARN",
      check: "Secret-looking names",
      detail:
        "2 key names that look like secrets hold plain values in the 2,000 most recent events sampled: authToken (in 12), sessionCredential (in 3).",
      fix: "If a name holds a secret, add \"**.<name>\" to the SDK's redact option, or to the environment's redaction_paths for another sender; values already stored stay until deleted (docs/OPERATIONS.md §8). If it does not, the warning can be ignored; it never fails doctor."
    });
  });

  it("prints at most ten names, and says how many more there are", () => {
    const names = Array.from({ length: 13 }, (_unused, index) => ({
      name: `vendor${String(index)}Token`,
      events: 100 - index
    }));
    const { detail } = secretNamesResult({ events: 500, names });
    expect(detail).toContain("vendor9Token (in 91), and 3 more.");
    expect(detail).not.toContain("vendor10Token");
  });

  it("cuts a long name and removes control characters from it", () => {
    const { detail } = secretNamesResult({
      events: 5,
      names: [{ name: `evil\u001b[2J\n${"x".repeat(200)}Token`, events: 1 }]
    });
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    expect(detail).not.toMatch(/[\u0000-\u001f]/);
    expect(detail).toContain("evil [2J x");
    expect(detail.length).toBeLessThan(200);
  });

  it("orders names with equal counts by name, so the output is stable", () => {
    const { detail } = secretNamesResult({
      events: 5,
      names: [
        { name: "zToken", events: 1 },
        { name: "aToken", events: 1 }
      ]
    });
    expect(detail).toContain("aToken (in 1), zToken (in 1)");
  });
});

describe("the sample", () => {
  it("is bounded", () => {
    expect(SAMPLE_BOUNDS).toEqual({
      journeysPerEnvironment: 100,
      eventsPerJourney: 20,
      events: 2_000,
      timeoutMs: 5_000
    });
  });

  it("pre-filters names by the same three-character tails the heuristic uses", () => {
    const tails = suffixFilter();
    for (const name of ["authtoken", "sessioncredential", "pin", "apikey", "password"]) {
      expect(tails, name).toContain(name.slice(-3));
    }
    expect(tails).not.toContain("unt");
  });
});
