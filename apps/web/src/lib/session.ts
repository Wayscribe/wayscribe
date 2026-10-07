import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "wayscribe_session";

/** Who a session signs in. Only an admin sees replay and delete. */
export type WebPrincipal = "admin" | "reader";

/**
 * The HKDF label for sessions signed with the admin token. It predates the
 * rename to Wayscribe and must not change: it determines the signing key, so
 * renaming it ends every session (ADR-057).
 */
export const OPERATOR_SESSION_LABEL = "flight-recorder/web-session";

/**
 * The HKDF label for anonymous read-only mode, keyed from the read token
 * (ADR-070). Distinct from the operator label so a session from one mode never
 * verifies in the other, even if both tokens held the same value.
 */
export const READER_SESSION_LABEL = "wayscribe/web-session-anonymous-reader";

export interface SessionPayload {
  projectId: string;
  /** Unix milliseconds. */
  expiresAt: number;
  /** Absent in cookies issued before principals existed, which were all an admin's. */
  principal?: WebPrincipal;
}

export interface VerifiedSession {
  projectId: string;
  expiresAt: number;
  principal: WebPrincipal;
}

/**
 * Derive the cookie signing key from a token.
 *
 * The same HKDF pattern the API uses for its three subkeys. The web application
 * therefore needs one secret rather than two, and rotating the token
 * invalidates every existing session — which is correct behavior, not an
 * inconvenience (ADR-029).
 */
function signingKey(secret: string, label: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", label, 32));
}

/**
 * Sign a session payload.
 *
 * Signed, not encrypted: nothing in the payload is secret, and what matters is
 * that it cannot be altered. A user who decodes their own cookie learns only
 * which project they are already looking at, and whom they are signed in as.
 */
export function signSession(
  secret: string,
  payload: SessionPayload,
  label: string = OPERATOR_SESSION_LABEL
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(secret, label, body)}`;
}

export function verifySession(
  secret: string,
  cookie: string,
  now: number,
  label: string = OPERATOR_SESSION_LABEL
): VerifiedSession | null {
  const separator = cookie.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = cookie.slice(0, separator);
  const presented = cookie.slice(separator + 1);

  const expected = Buffer.from(sign(secret, label, body), "utf8");
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
  const { projectId, expiresAt, principal } = payload as Record<string, unknown>;
  if (typeof projectId !== "string" || typeof expiresAt !== "number") return null;
  if (expiresAt <= now) return null;

  const resolved: unknown = principal ?? (label === READER_SESSION_LABEL ? "reader" : "admin");
  if (resolved !== "admin" && resolved !== "reader") return null;
  // A key derived from the read token can only ever sign a reader in.
  if (label === READER_SESSION_LABEL && resolved !== "reader") return null;

  return { projectId, expiresAt, principal: resolved };
}

function sign(secret: string, label: string, body: string): string {
  return createHmac("sha256", signingKey(secret, label)).update(body, "utf8").digest("base64url");
}
