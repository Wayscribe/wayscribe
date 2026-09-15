import type { Knex } from "knex";

export interface AliasRow {
  journeyId: string;
  aliasType: string;
  aliasValueHash: string;
  encryptedDisplayValue: string | null;
  /**
   * The token this value carried under the previous key, during a rotation;
   * null otherwise. A row stored under it is moved to `aliasValueHash` rather
   * than joined by a second row for the same alias.
   */
  supersedesValueHash: string | null;
}

/**
 * Store aliases for a journey.
 *
 * Re-sending the same alias is a no-op rather than an error: an SDK that repeats
 * `identify()` on every event is behaving reasonably, and the unique constraint
 * exists to deduplicate, not to reject.
 *
 * During a key rotation the same value produces a new token, so the unique
 * constraint no longer recognises a repeat. A row stored under the previous
 * key's token is moved to the new token and display value first; the plaintext
 * is in hand, so this is one indexed update and needs no decryption.
 */
export async function upsertAliases(
  db: Knex,
  projectId: string,
  aliases: readonly AliasRow[]
): Promise<void> {
  if (aliases.length === 0) return;

  for (const alias of aliases) {
    if (alias.supersedesValueHash === null) continue;
    await db("entity_aliases")
      .where({
        project_id: projectId,
        journey_id: alias.journeyId,
        alias_type: alias.aliasType,
        alias_value_hash: alias.supersedesValueHash
      })
      // A row under the new token can already exist: the previous key was
      // removed early, the alias stored again, and the key restored. Moving the
      // old row onto it would violate the unique constraint and fail the event,
      // so the old row is left for re-encryption to settle.
      .whereNotExists((current) => {
        void current.select(db.raw("1")).from({ c: "entity_aliases" }).where({
          "c.project_id": projectId,
          "c.journey_id": alias.journeyId,
          "c.alias_type": alias.aliasType,
          "c.alias_value_hash": alias.aliasValueHash
        });
      })
      .update({
        alias_value_hash: alias.aliasValueHash,
        encrypted_display_value: alias.encryptedDisplayValue
      });
  }

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
