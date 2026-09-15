import { issueApiKey, type Keyring } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { insertReturningId } from "../insert.js";

export interface IssuedKey {
  id: string;
  /** The full key. Returned once and never recoverable. */
  apiKey: string;
  keyPrefix: string;
  projectSlug: string;
  environmentName: string;
}

export interface KeyListing {
  id: string;
  name: string;
  keyPrefix: string;
  projectSlug: string;
  environmentName: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export class KeyAdminError extends Error {
  public override readonly name = "KeyAdminError";
}

/**
 * Issue a key for an existing project and environment.
 *
 * This is the only supported way to obtain a second key. It cannot be done with
 * SQL: `key_hash` is an HMAC under a subkey derived from `ENCRYPTION_KEY`, so
 * the value has to be computed by something that holds the master key.
 *
 * The environment is created if it does not exist, because "give the staging
 * worker a key" should not require first knowing that staging is a row.
 */
export async function issueKey(
  db: Knex,
  keyring: Keyring,
  options: {
    projectSlug: string;
    environmentName: string;
    name: string;
    /** From DEFAULT_RETENTION_DAYS, when this call creates the environment. */
    retentionDays?: number;
  }
): Promise<IssuedKey> {
  const projectRow: unknown = await db("projects").where({ slug: options.projectSlug }).first("id");
  const project = projectRow as { id: string } | undefined;
  if (project === undefined) {
    throw new KeyAdminError(
      `No project with slug "${options.projectSlug}". Existing projects: ${await slugList(db)}`
    );
  }

  const environmentRow: unknown = await db("environments")
    .where({ project_id: project.id, name: options.environmentName })
    .first("id");
  const existing = environmentRow as { id: string } | undefined;

  const environmentId =
    existing?.id ??
    (await insertReturningId(db, "environments", {
      project_id: project.id,
      name: options.environmentName,
      retention_days: options.retentionDays ?? 7,
      capture_mode: "redacted-payload"
    }));

  const generated = issueApiKey(keyring);
  const id = await insertReturningId(db, "api_keys", {
    project_id: project.id,
    environment_id: environmentId,
    name: options.name,
    key_prefix: generated.keyPrefix,
    key_hash: generated.verifier,
    key_hash_key_id: generated.keyHashKeyId
  });

  return {
    id,
    apiKey: generated.apiKey,
    keyPrefix: generated.keyPrefix,
    projectSlug: options.projectSlug,
    environmentName: options.environmentName
  };
}

/**
 * Revoke a key by its prefix.
 *
 * By prefix rather than by the key itself: the full value is not stored and the
 * operator revoking it usually does not have it — that is often why they are
 * revoking it. The prefix is what `key:list` shows.
 */
export async function revokeKey(db: Knex, keyPrefix: string): Promise<KeyListing> {
  const updated: unknown = await db("api_keys")
    .where({ key_prefix: keyPrefix })
    .whereNull("revoked_at")
    .update({ revoked_at: db.fn.now() })
    .returning("id");

  if (!Array.isArray(updated) || updated.length === 0) {
    const knownRow: unknown = await db("api_keys")
      .where({ key_prefix: keyPrefix })
      .first("revoked_at");
    const known = knownRow as { revoked_at: Date | null } | undefined;
    throw new KeyAdminError(
      known === undefined
        ? `No key with prefix "${keyPrefix}".`
        : `Key "${keyPrefix}" was already revoked at ${known.revoked_at?.toISOString() ?? "?"}.`
    );
  }

  const listing = (await listKeys(db)).find((key) => key.keyPrefix === keyPrefix);
  if (listing === undefined) throw new KeyAdminError(`Key "${keyPrefix}" vanished mid-revoke.`);
  return listing;
}

export async function listKeys(db: Knex, projectSlug?: string): Promise<KeyListing[]> {
  const query = db("api_keys")
    .join("projects", "api_keys.project_id", "projects.id")
    .join("environments", "api_keys.environment_id", "environments.id")
    .select(
      "api_keys.id as id",
      "api_keys.name as name",
      "api_keys.key_prefix as keyPrefix",
      "projects.slug as projectSlug",
      "environments.name as environmentName",
      "api_keys.created_at as createdAt",
      "api_keys.last_used_at as lastUsedAt",
      "api_keys.revoked_at as revokedAt"
    )
    .orderBy([{ column: "projects.slug" }, { column: "api_keys.created_at" }]);

  if (projectSlug !== undefined) void query.where("projects.slug", projectSlug);

  const rows: unknown = await query;
  return rows as KeyListing[];
}

async function slugList(db: Knex): Promise<string> {
  const rows: unknown = await db("projects").select("slug").orderBy("slug");
  const slugs = (rows as { slug: string }[]).map((row) => row.slug);
  return slugs.length === 0 ? "(none — run `pnpm db:seed`)" : slugs.join(", ");
}
