import { describe, expect, it } from "vitest";
import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { REDACTED, redact } from "./redact.js";

/**
 * The redaction walk reporting what it kept under a secret-looking name.
 *
 * The walk already visits every key, so this is where the warning is found,
 * rather than in a second traversal of every payload (ADR-055).
 */
function reported(value: unknown, paths: readonly string[] = DEFAULT_SECRET_PATHS): string[] {
  const found: string[] = [];
  redact(value, paths, (name, path) => {
    found.push(`${name} @ ${path}`);
  });
  return found;
}

describe("redact reports kept secret-looking names", () => {
  it("reports a kept credential with its path, and never its value", () => {
    const found = reported({ customer: { sessionCredential: "cred-value-1", name: "Ada" } });
    expect(found).toEqual(["sessionCredential @ customer.sessionCredential"]);
    expect(found.join("")).not.toContain("cred-value-1");
  });

  it("writes every array index as [*]", () => {
    expect(
      reported({ items: [{ apiToken: "a" }, { apiToken: "b" }], root: [[{ authToken: "c" }]] })
    ).toEqual([
      "apiToken @ items[*].apiToken",
      "apiToken @ items[*].apiToken",
      "authToken @ root[*][*].authToken"
    ]);
    expect(reported([{ authToken: "x" }])).toEqual(["authToken @ [*].authToken"]);
  });

  it("reports numbers, and not objects, booleans, null, empty strings or the marker", () => {
    expect(
      reported({
        cardPin: 1234,
        auth: { type: "basic" },
        hasPassword: true,
        authToken: null,
        refreshTokenOld: "",
        botToken: "",
        idToken: REDACTED
      })
    ).toEqual(["cardPin @ cardPin"]);
  });

  it("still walks into a secret-looking object and reports what is inside", () => {
    expect(reported({ credentials: { sessionToken: "s" } })).toEqual([
      "sessionToken @ credentials.sessionToken"
    ]);
  });

  it("never reports a built-in name, in any spelling or place", () => {
    const names = DEFAULT_SECRET_PATHS.map((path) => path.slice("**.".length));
    const spellings = names.flatMap((name) => [
      name,
      name.toUpperCase(),
      name.replace(/[-_]/g, ""),
      name.replace(/_/g, "-")
    ]);
    const payload = Object.fromEntries(spellings.map((name) => [name, "value-1"]));
    expect(reported({ ...payload, nested: [{ deeper: payload }] })).toEqual([]);
  });

  it("never reports a name a configured any-depth rule covers", () => {
    expect(
      reported({ a: { sessionCredential: "x" } }, [
        ...DEFAULT_SECRET_PATHS,
        "**.session_credential"
      ])
    ).toEqual([]);
  });

  it("stays quiet where a scoped rule applies and reports where it does not", () => {
    expect(
      reported({ customer: { authToken: "x" }, vendor: { authToken: "y" } }, [
        ...DEFAULT_SECRET_PATHS,
        "customer.authToken"
      ])
    ).toEqual(["authToken @ vendor.authToken"]);
  });

  it("reports a name inside a Map under the key it is filed under", () => {
    expect(reported({ headers: new Map([["x-session-token", "t"]]) })).toEqual([
      "x-session-token @ headers.x-session-token"
    ]);
  });

  it("leaves the result exactly as it is without an observer", () => {
    const payload = {
      authToken: "a",
      nested: [{ password: "p", sessionId: 7 }],
      headers: [["authorization", "Bearer abcdefgh"]]
    };
    const observed = redact(payload, DEFAULT_SECRET_PATHS, () => undefined);
    expect(observed).toEqual(redact(payload, DEFAULT_SECRET_PATHS));
    expect(observed).toEqual({
      authToken: "a",
      nested: [{ password: REDACTED, sessionId: 7 }],
      headers: [["authorization", REDACTED]]
    });
  });

  it("does not report names that do not look secret", () => {
    expect(reported({ tokenCount: 3, nextPageToken: "n", author: "a", pinned: "yes" })).toEqual([]);
  });

  it("reports even when no rule is configured at all", () => {
    expect(reported({ authToken: "a" }, [])).toEqual(["authToken @ authToken"]);
  });
});
