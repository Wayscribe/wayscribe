import { describe, expect, it } from "vitest";
import {
  OPERATOR_SESSION_LABEL,
  READER_SESSION_LABEL,
  signSession,
  verifySession
} from "./session";

const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const NOW = 1_800_000_000_000;
const payload = { projectId: "proj_1", expiresAt: NOW + 3_600_000 };

describe("session cookie", () => {
  it("round-trips a signed payload", () => {
    expect(verifySession(ADMIN_TOKEN, signSession(ADMIN_TOKEN, payload), NOW)).toEqual({
      ...payload,
      principal: "admin"
    });
  });

  it("rejects a tampered payload", () => {
    const cookie = signSession(ADMIN_TOKEN, payload);
    const [body, signature] = cookie.split(".");
    const forged = Buffer.from(
      JSON.stringify({ projectId: "someone-elses-project", expiresAt: payload.expiresAt }),
      "utf8"
    ).toString("base64url");

    expect(verifySession(ADMIN_TOKEN, `${forged}.${String(signature)}`, NOW)).toBeNull();
    expect(body).not.toBe(forged);
  });

  it("rejects a tampered signature", () => {
    const cookie = signSession(ADMIN_TOKEN, payload);
    expect(verifySession(ADMIN_TOKEN, `${cookie}x`, NOW)).toBeNull();
  });

  it("rejects a cookie signed with a different admin token", () => {
    // Rotating the admin token must invalidate existing sessions.
    const other = signSession("a-completely-different-admin-token", payload);
    expect(verifySession(ADMIN_TOKEN, other, NOW)).toBeNull();
  });

  it("rejects an expired session", () => {
    const expired = signSession(ADMIN_TOKEN, { projectId: "proj_1", expiresAt: NOW - 1 });
    expect(verifySession(ADMIN_TOKEN, expired, NOW)).toBeNull();
  });

  it("rejects malformed cookies without throwing", () => {
    expect(verifySession(ADMIN_TOKEN, "", NOW)).toBeNull();
    expect(verifySession(ADMIN_TOKEN, "no-separator", NOW)).toBeNull();
    expect(verifySession(ADMIN_TOKEN, ".onlyseparator", NOW)).toBeNull();
    expect(verifySession(ADMIN_TOKEN, "not-base64.signature", NOW)).toBeNull();
  });

  it("never verifies a cookie under the other mode's label, whichever way round", () => {
    const operator = signSession(ADMIN_TOKEN, payload, OPERATOR_SESSION_LABEL);
    const reader = signSession(
      ADMIN_TOKEN,
      { ...payload, principal: "reader" },
      READER_SESSION_LABEL
    );
    expect(verifySession(ADMIN_TOKEN, operator, NOW, READER_SESSION_LABEL)).toBeNull();
    expect(verifySession(ADMIN_TOKEN, reader, NOW, OPERATOR_SESSION_LABEL)).toBeNull();
    expect(verifySession(ADMIN_TOKEN, reader, NOW, READER_SESSION_LABEL)).toEqual({
      ...payload,
      principal: "reader"
    });
  });

  it("reads a reader-label cookie with no principal as a reader's, and refuses one claiming admin", () => {
    const bare = signSession(ADMIN_TOKEN, payload, READER_SESSION_LABEL);
    expect(verifySession(ADMIN_TOKEN, bare, NOW, READER_SESSION_LABEL)).toMatchObject({
      principal: "reader"
    });
    const claimsAdmin = signSession(
      ADMIN_TOKEN,
      { ...payload, principal: "admin" },
      READER_SESSION_LABEL
    );
    expect(verifySession(ADMIN_TOKEN, claimsAdmin, NOW, READER_SESSION_LABEL)).toBeNull();
  });

  it("refuses a principal it does not know", () => {
    // Signed properly, so only the principal check can refuse it.
    const signed = signSession(ADMIN_TOKEN, {
      ...payload,
      principal: "root"
    } as unknown as typeof payload);
    expect(verifySession(ADMIN_TOKEN, signed, NOW)).toBeNull();
  });
});
