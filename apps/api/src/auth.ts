import type { ApiKeyContext } from "@flight-recorder/database";
import { API_KEY_PREFIX_LENGTH, verifyApiKey } from "@flight-recorder/payload-security";

export type AuthResult =
  | { ok: true; context: ApiKeyContext }
  | { ok: false; status: 401 | 403; code: string; message: string };

export type ApiKeyLookup = (keyPrefix: string) => Promise<ApiKeyContext | undefined>;

const UNAUTHORIZED = {
  ok: false as const,
  status: 401 as const,
  code: "unauthorized",
  message: "A valid API key is required."
};

/**
 * Resolve a bearer API key to its project and environment context.
 *
 * Every failure returns the same message. Distinguishing "unknown key" from
 * "revoked key" or "bad signature" in the response would let an attacker probe
 * which prefixes exist.
 */
export async function resolveApiKey(
  authorizationHeader: string | undefined,
  pepper: Buffer,
  lookup: ApiKeyLookup
): Promise<AuthResult> {
  if (authorizationHeader === undefined) return UNAUTHORIZED;

  const [scheme, presented] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || presented === undefined) return UNAUTHORIZED;

  const context = await lookup(presented.slice(0, API_KEY_PREFIX_LENGTH));
  if (context === undefined) return UNAUTHORIZED;
  if (context.revokedAt !== null) return UNAUTHORIZED;
  if (!verifyApiKey(pepper, presented, context.keyHash)) return UNAUTHORIZED;

  return { ok: true, context };
}

/**
 * An API key is scoped to one environment; the event names its own. A mismatch
 * is 403 rather than 401 — the caller authenticated successfully but is not
 * authorized for that environment.
 */
export function authorizeEnvironment(context: ApiKeyContext, eventEnvironment: string): AuthResult {
  if (context.environmentName !== eventEnvironment) {
    return {
      ok: false,
      status: 403,
      code: "unauthorized_environment",
      message: `This key is not authorized for environment ${eventEnvironment}.`
    };
  }
  return { ok: true, context };
}
