import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "wayscribe_session";

export interface SessionPayload {
  projectId: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/**
 * Derive the cookie signing key from the admin token.
 *
 * The same HKDF pattern the API uses for its three subkeys. The web application
 * therefore needs one secret rather than two, and rotating the admin token
 * invalidates every existing session — which is correct behavior, not an
 * inconvenience (ADR-029).
 */
function signingKey(adminToken: string): Buffer {
  // The label predates the rename to Wayscribe and must not change: it
  // determines the signing key, so renaming it ends every session (ADR-057).
  return Buffer.from(hkdfSync("sha256", adminToken, "", "flight-recorder/web-session", 32));
}

/**
 * Sign a session payload.
 *
 * Signed, not encrypted: nothing in the payload is secret, and what matters is
 * that it cannot be altered. A user who decodes their own cookie learns only
 * which project they are already looking at.
 */
export function signSession(adminToken: string, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(adminToken, body)}`;
}

export function verifySession(
  adminToken: string,
  cookie: string,
  now: number
): SessionPayload | null {
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = cookie.slice(0, separator);
  const presented = cookie.slice(separator + 1);

  const expected = Buffer.from(sign(adminToken, body), "utf8");
  const actual = Buffer.from(presented, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload !== "object" || payload === null) return null;
  const { projectId, expiresAt } = payload as Record<string, unknown>;
  if (typeof projectId !== "string" || typeof expiresAt !== "number") return null;
  if (expiresAt <= now) return null;

  return { projectId, expiresAt };
}

function sign(adminToken: string, body: string): string {
  return createHmac("sha256", signingKey(adminToken)).update(body, "utf8").digest("base64url");
}
