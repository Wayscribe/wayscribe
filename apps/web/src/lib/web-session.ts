import { sessionSigner } from "./config";
import { verifySession, type VerifiedSession } from "./session";

/** How long an anonymous reader's implicit session lasts. */
export const ANONYMOUS_SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * The session behind a request, or null when nobody is signed in.
 *
 * The one place a cookie is verified. In anonymous read-only mode every
 * visitor is a reader: a request with no cookie, or with one that does not
 * verify under the reader key, gets a fresh reader session rather than the
 * login page (ADR-069). A cookie exists in that mode only once a reader picks
 * a project.
 *
 * No signer means no token to verify against, and nothing is verified:
 * verifying against an empty key would admit a cookie signed with an empty
 * key, turning a misconfiguration into a way in.
 */
export function resolveSession(
  cookie: string | undefined,
  now: number,
  source: Record<string, string | undefined> = process.env
): VerifiedSession | null {
  const signer = sessionSigner(source);
  if (signer === null) return null;
  const verified =
    cookie === undefined ? null : verifySession(signer.secret, cookie, now, signer.label);
  if (verified !== null) return verified;
  if (signer.principal === "reader") {
    return { projectId: "", expiresAt: now + ANONYMOUS_SESSION_MS, principal: "reader" };
  }
  return null;
}
