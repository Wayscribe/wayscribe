import { issueApiKey, type Keyring } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { insertReturningId } from "./insert.js";

export interface SeedResult {
  projectId: string;
  environmentId: string;
  apiKey: string;
  keyPrefix: string;
}

const PROJECT_SLUG = "local";
const ENVIRONMENT_NAME = "development";

/**
 * Create the local development project, environment, and API key.
 *
 * Idempotent for the project and environment, so re-running after a schema
 * change is safe. A fresh API key is issued on every run: the full key is shown
 * once and never stored, so there is no way to reprint an existing one.
 */
export async function seedLocal(
  db: Knex,
  keyring: Keyring,
  /** From DEFAULT_RETENTION_DAYS. The knob was inert before this. */
  retentionDays = 7
): Promise<SeedResult> {
  const project = await findOrInsert(
    db,
    "projects",
    { slug: PROJECT_SLUG },
    { name: "Local", slug: PROJECT_SLUG }
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

  const generated = issueApiKey(keyring);
  await db("api_keys").insert({
    project_id: project.id,
    environment_id: environment.id,
    name: "local-development",
    key_prefix: generated.keyPrefix,
    key_hash: generated.verifier,
    key_hash_key_id: generated.keyHashKeyId
  });

  return {
    projectId: project.id,
    environmentId: environment.id,
    apiKey: generated.apiKey,
    keyPrefix: generated.keyPrefix
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
