import { describe, expect, it } from "vitest";
import { OPERATOR_SESSION_LABEL, READER_SESSION_LABEL, signSession } from "./session";
import { ANONYMOUS_SESSION_MS, resolveSession } from "./web-session";

const ADMIN = "admin-token-for-tests-00000000000000";
const READ = "read-token-for-tests-000000000000000";
const NOW = 1_800_000_000_000;
const operator = { ADMIN_TOKEN: ADMIN };
const anonymous = { WEB_ANONYMOUS_READ_ONLY: "true", READ_TOKEN: READ };

describe("resolveSession", () => {
  it("signs every visitor in as a reader in anonymous read-only mode", () => {
    expect(resolveSession(undefined, NOW, anonymous)).toEqual({
      projectId: "",
      expiresAt: NOW + ANONYMOUS_SESSION_MS,
      principal: "reader"
    });
  });

  it("keeps the project a reader chose", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000, principal: "reader" },
      READER_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, anonymous)).toEqual({
      projectId: "p1",
      expiresAt: NOW + 1000,
      principal: "reader"
    });
  });

  it("never verifies an operator-mode cookie in anonymous mode: it starts a fresh reader session", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000 },
      OPERATOR_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, anonymous)).toMatchObject({
      projectId: "",
      principal: "reader"
    });
  });

  it("refuses a cookie under the reader label that claims to be an admin", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000, principal: "admin" },
      READER_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, anonymous)).toMatchObject({
      projectId: "",
      principal: "reader"
    });
  });

  it("never verifies a reader cookie in operator mode, even with the same secret", () => {
    const cookie = signSession(
      READ,
      { projectId: "p1", expiresAt: NOW + 1000, principal: "reader" },
      READER_SESSION_LABEL
    );
    expect(resolveSession(cookie, NOW, { ADMIN_TOKEN: READ })).toBeNull();
  });

  it("requires a cookie in operator mode and reads an existing one as an admin's", () => {
    expect(resolveSession(undefined, NOW, operator)).toBeNull();
    const legacy = signSession(ADMIN, { projectId: "", expiresAt: NOW + 1000 });
    expect(resolveSession(legacy, NOW, operator)).toEqual({
      projectId: "",
      expiresAt: NOW + 1000,
      principal: "admin"
    });
  });

  it("admits nobody when the mode's token is missing", () => {
    expect(resolveSession(undefined, NOW, { WEB_ANONYMOUS_READ_ONLY: "true" })).toBeNull();
    expect(resolveSession(undefined, NOW, {})).toBeNull();
  });
});
