import { apiKeyRecord, deriveSubkeys } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { insertReturningId } from "./insert.js";

export interface DemoSeedResult {
  projectId: string;
  environmentId: string;
  keyPrefix: string;
}

const PROJECT_SLUG = "demo";
const ENVIRONMENT_NAME = "development";

/**
 * Create the demo project, environment, and its fixed API key.
 *
 * Fully idempotent, including the key: `docker compose up` runs this on every
 * start, and a second run must not leave two rows sharing a prefix, because
 * authentication resolves a key by prefix and would then find an arbitrary one.
 */
export async function seedDemo(
  db: Knex,
  masterKey: string,
  apiKey: string,
  /** From DEFAULT_RETENTION_DAYS. */
  retentionDays = 7
): Promise<DemoSeedResult> {
  const subkeys = deriveSubkeys(masterKey);

  const project = await findOrInsert(
    db,
    "projects",
    { slug: PROJECT_SLUG },
    { name: "Demo", slug: PROJECT_SLUG }
  );

  const environment = await findOrInsert(
    db,
    "environments",
    { project_id: project.id, name: ENVIRONMENT_NAME },
    {
      project_id: project.id,
      name: ENVIRONMENT_NAME,
      retention_days: retentionDays,
      capture_mode: "redacted-payload"
    }
  );

  const record = apiKeyRecord(subkeys.apiKey, apiKey);
  const existing = (await db("api_keys").where({ key_prefix: record.keyPrefix }).first()) as
    { id: string } | undefined;

  if (existing === undefined) {
    await db("api_keys").insert({
      project_id: project.id,
      environment_id: environment.id,
      name: "demo",
      key_prefix: record.keyPrefix,
      key_hash: record.verifier
    });
  } else {
    // The verifier is rewritten rather than left alone: rotating ENCRYPTION_KEY
    // changes the pepper, so the stored verifier for the same key string no
    // longer matches. Without this the demo silently 401s after a rotation.
    await db("api_keys").where({ id: existing.id }).update({
      project_id: project.id,
      environment_id: environment.id,
      key_hash: record.verifier,
      revoked_at: null
    });
  }

  return {
    projectId: project.id,
    environmentId: environment.id,
    keyPrefix: record.keyPrefix
  };
}

async function findOrInsert(
  db: Knex,
  table: string,
  match: Record<string, unknown>,
  insert: Record<string, unknown>
): Promise<{ id: string }> {
  const existing = (await db(table).where(match).first()) as { id: string } | undefined;
  if (existing !== undefined) return existing;

  return { id: await insertReturningId(db, table, insert) };
}
