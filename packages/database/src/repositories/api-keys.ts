import type { Knex } from "knex";

export interface ApiKeyContext {
  id: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  keyHash: string;
  /** Id of the key whose pepper produced `keyHash`; null when written before ids were stored. */
  keyHashKeyId: string | null;
  revokedAt: Date | null;
  captureMode: string;
  redactionPaths: string[];
  captureAllowlist: string[];
}

/**
 * Resolve an API key by its public prefix.
 *
 * Joins the environment so authentication is a single indexed read returning
 * everything ingestion needs: project scope, environment scope, and capture
 * policy.
 *
 * Deliberately does not filter on revoked_at. The caller needs to distinguish a
 * revoked key from an unknown one for logging, even though both produce the same
 * response to the client.
 */
export async function findApiKeyByPrefix(
  db: Knex,
  keyPrefix: string
): Promise<ApiKeyContext | undefined> {
  const row: unknown = await db("api_keys")
    .join("environments", "api_keys.environment_id", "environments.id")
    .where("api_keys.key_prefix", keyPrefix)
    .first(
      "api_keys.id as id",
      "api_keys.project_id as projectId",
      "api_keys.environment_id as environmentId",
      "api_keys.key_hash as keyHash",
      "api_keys.key_hash_key_id as keyHashKeyId",
      "api_keys.revoked_at as revokedAt",
      "environments.name as environmentName",
      "environments.capture_mode as captureMode",
      "environments.redaction_paths as redactionPaths",
      "environments.capture_allowlist as captureAllowlist"
    );

  return row === undefined ? undefined : (row as ApiKeyContext);
}

/**
 * Record key usage. Called outside the request path: a failure here must never
 * fail ingestion.
 */
export async function touchApiKey(db: Knex, id: string): Promise<void> {
  await db("api_keys").where({ id }).update({ last_used_at: db.fn.now() });
}

/**
 * Store a verifier computed under a newer key in place of the one that was read.
 *
 * Conditional on the stored hash being the one the caller verified against, so
 * two requests migrating the same key cannot overwrite each other or a verifier
 * the demo seed rewrote in between. Returns whether a row changed.
 */
export async function replaceApiKeyVerifier(
  db: Knex,
  id: string,
  expectedKeyHash: string,
  next: { keyHash: string; keyHashKeyId: string }
): Promise<boolean> {
  const updated = await db("api_keys")
    .where({ id, key_hash: expectedKeyHash })
    .update({ key_hash: next.keyHash, key_hash_key_id: next.keyHashKeyId });
  return updated > 0;
}
