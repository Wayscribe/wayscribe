import type { Knex } from "knex";

export interface ApiKeyContext {
  id: string;
  projectId: string;
  environmentId: string;
  environmentName: string;
  keyHash: string;
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
