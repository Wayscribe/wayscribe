import {
  findApiKeyByPrefix,
  replaceApiKeyVerifier,
  type ApiKeyContext
} from "@flight-recorder/database";
import {
  API_KEY_PREFIX_LENGTH,
  verifyApiKeyWithKeyring,
  type Keyring
} from "@flight-recorder/payload-security";
import type { Knex } from "knex";

export type AuthResult =
  | { ok: true; context: ApiKeyContext }
  | { ok: false; status: 401 | 403; code: string; message: string };

export type ApiKeyLookup = (keyPrefix: string) => Promise<ApiKeyContext | undefined>;

/** What authenticating an API key needs: the keys, and the rows they verify against. */
export interface ApiKeyAuthenticator {
  keyring: Keyring;
  find: ApiKeyLookup;
  /** Store a verifier under the current key in place of `expectedKeyHash`. */
  replaceVerifier: (
    id: string,
    expectedKeyHash: string,
    next: { keyHash: string; keyHashKeyId: string }
  ) => Promise<unknown>;
  /** Told when that write fails, with the row's id. Authentication has already succeeded. */
  onReplaceFailure: (error: unknown, apiKeyId: string) => void;
}

/**
 * The failure report every route passes to `databaseApiKeys`.
 *
 * Names the `api_keys` row, which is not secret, so an operator reading the
 * warning can tell which key is still under the old key and will fail once the
 * previous key is removed.
 */
export function logVerifierReplaceFailure(log: {
  warn: (fields: Record<string, unknown>, message: string) => void;
}): (error: unknown, apiKeyId: string) => void {
  return (error, apiKeyId) => {
    log.warn(
      { err: error, apiKeyId },
      "failed to move an API key verifier to the current key; the next request retries"
    );
  };
}

/** The authenticator every route uses, backed by the `api_keys` table. */
export function databaseApiKeys(
  db: Knex,
  keyring: Keyring,
  onReplaceFailure: (error: unknown, apiKeyId: string) => void
): ApiKeyAuthenticator {
  return {
    keyring,
    find: (keyPrefix) => findApiKeyByPrefix(db, keyPrefix),
    replaceVerifier: (id, expectedKeyHash, next) =>
      replaceApiKeyVerifier(db, id, expectedKeyHash, next),
    onReplaceFailure
  };
}

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
  authenticator: ApiKeyAuthenticator
): Promise<AuthResult> {
  if (authorizationHeader === undefined) return UNAUTHORIZED;

  const [scheme, presented] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || presented === undefined) return UNAUTHORIZED;

  const context = await authenticatePresentedKey(presented, authenticator);
  return context === undefined ? UNAUTHORIZED : { ok: true, context };
}

/**
 * The context for a presented API key, or undefined when it does not authenticate.
 *
 * Shared by ingestion and the read routes, which parse the header differently
 * because the read routes also accept the admin token.
 *
 * A key whose verifier is under the previous key, or carries no key id, has its
 * verifier moved to the current key here. The presented key is the only
 * plaintext that can produce the new verifier, so this request is the only
 * chance. The write is awaited so a key is not rewritten by every request that
 * races it, but its failure is reported and swallowed: refusing an
 * authenticated client over bookkeeping would turn a database hiccup into an
 * ingestion outage, and the next request tries again.
 */
export async function authenticatePresentedKey(
  presented: string,
  authenticator: ApiKeyAuthenticator
): Promise<ApiKeyContext | undefined> {
  const context = await authenticator.find(presented.slice(0, API_KEY_PREFIX_LENGTH));
  if (context === undefined) return undefined;
  if (context.revokedAt !== null) return undefined;

  const verification = verifyApiKeyWithKeyring(authenticator.keyring, presented, {
    keyHash: context.keyHash,
    keyHashKeyId: context.keyHashKeyId
  });
  if (!verification.ok) return undefined;

  if (verification.migrate !== null) {
    try {
      await authenticator.replaceVerifier(context.id, context.keyHash, verification.migrate);
    } catch (error) {
      authenticator.onReplaceFailure(error, context.id);
    }
  }

  return context;
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
