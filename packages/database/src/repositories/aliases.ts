import type { Knex } from "knex";

export interface AliasRow {
  journeyId: string;
  aliasType: string;
  aliasValueHash: string;
  encryptedDisplayValue: string | null;
}

/**
 * Store aliases for a journey.
 *
 * Re-sending the same alias is a no-op rather than an error: an SDK that repeats
 * `identify()` on every event is behaving reasonably, and the unique constraint
 * exists to deduplicate, not to reject.
 */
export async function upsertAliases(
  db: Knex,
  projectId: string,
  aliases: readonly AliasRow[]
): Promise<void> {
  if (aliases.length === 0) return;

  await db("entity_aliases")
    .insert(
      aliases.map((alias) => ({
        project_id: projectId,
        journey_id: alias.journeyId,
        alias_type: alias.aliasType,
        alias_value_hash: alias.aliasValueHash,
        encrypted_display_value: alias.encryptedDisplayValue
      }))
    )
    .onConflict(["project_id", "journey_id", "alias_type", "alias_value_hash"])
    .ignore();
}
