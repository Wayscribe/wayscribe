import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "./session.js";

const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const NOW = 1_800_000_000_000;
const payload = { projectId: "proj_1", expiresAt: NOW + 3_600_000 };

describe("session cookie", () => {
  it("round-trips a signed payload", () => {
    expect(verifySession(ADMIN_TOKEN, signSession(ADMIN_TOKEN, payload), NOW)).toEqual(payload);
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
});
