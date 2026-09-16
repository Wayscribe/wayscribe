import type { Knex } from "knex";

export interface AliasRow {
  journeyId: string;
  aliasType: string;
  aliasValueHash: string;
  encryptedDisplayValue: string | null;
  /**
   * The alias value as this event stated it. Stored in plain text, as
   * `display_value`, only when this statement is displayable, and kept only
   * while the stored flag stays true; never for a masked alias.
   */
  value: string;
  /**
   * Whether this event marked the alias as displayable. The stored flag is the
   * conjunction of every statement (ADR-053).
   */
  displayable: boolean;
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
 * The display flag is true only while every statement of the alias marked it
 * (ADR-053). A repeat can lower it and never raises it, so the order events
 * arrive in does not matter, and a repeat that leaves it where it is writes
 * nothing: the conflict update runs only for a row that is displayable and a
 * statement that is not, or for the pre-copy row described below.
 *
 * The plain-text copy, `display_value`, exists only while the flag is true.
 * An insert stores it with a displayable statement and never with a masked
 * one. The conflict update that lowers the flag clears it in the same
 * statement, so no reader, and no concurrent writer waiting on the row lock,
 * ever sees a masked row with a copy.
 *
 * A repeat keeps the spelling the row already holds, ciphertext and copy
 * alike: tokens are taken over the normalized value, so " A-1 " repeats
 * "A-1", and the first spelling stays. The one exception is a displayable row
 * written before copies existed (migration 018 has no backfill). A
 * displayable repeat fills its copy and replaces its ciphertext with the
 * repeat's in the same statement, so the two agree on the spelling. That is
 * one write per such row, once; after it the repeat writes nothing again.
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
    const supersedes = alias.supersedesValueHash;
    if (supersedes === null) continue;
    await moveToCurrentToken(db, projectId, alias, supersedes);
  }

  await db("entity_aliases")
    .insert(
      aliases.map((alias) => ({
        project_id: projectId,
        journey_id: alias.journeyId,
        alias_type: alias.aliasType,
        alias_value_hash: alias.aliasValueHash,
        encrypted_display_value: alias.encryptedDisplayValue,
        displayable: alias.displayable,
        display_value: alias.displayable ? alias.value : null
      }))
    )
    .onConflict(["project_id", "journey_id", "alias_type", "alias_value_hash"])
    // The where clause admits a displayable row only, so the stored flag
    // becomes the statement's, and the copy the statement's (null when masked).
    .merge({
      displayable: db.raw("excluded.displayable"),
      display_value: db.raw("case when excluded.displayable then excluded.display_value end"),
      encrypted_display_value: db.raw(
        "case when excluded.displayable then excluded.encrypted_display_value else entity_aliases.encrypted_display_value end"
      )
    })
    .where("entity_aliases.displayable", true)
    .andWhereRaw("(not excluded.displayable or entity_aliases.display_value is null)");
}

/** PostgreSQL's unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The unique constraint on `(project_id, journey_id, alias_type,
 * alias_value_hash)` from migration 005.
 *
 * Knex generated the name from the table and columns, and PostgreSQL truncated
 * it to 63 characters, which is why it ends in "has". Read from `pg_constraint`
 * on a migrated database rather than derived, and checked against it by
 * `aliases.integration.test.ts`, so a migration that renames it fails a test
 * instead of turning every move back into an error.
 */
export const ALIAS_UNIQUE_CONSTRAINT =
  "entity_aliases_project_id_journey_id_alias_type_alias_value_has";

/** Whether an error is a violation of the alias uniqueness constraint, and nothing else. */
export function isAliasUniqueViolation(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown } | null;
  return pgError?.code === UNIQUE_VIOLATION && pgError.constraint === ALIAS_UNIQUE_CONSTRAINT;
}

/**
 * Move a row stored under the previous key's token onto the current one.
 *
 * Run in a savepoint (a nested transaction when the caller holds one, as
 * ingestion does). The NOT EXISTS guard reads a snapshot, so a row under the new
 * token that a concurrent transaction has inserted but not committed is
 * invisible to it; the update then waits on that row and fails with a unique
 * violation once the other commits. That means another event already stored
 * the alias under the new token, which is the outcome this was for, so it is
 * treated as done. The savepoint is what keeps the violation from aborting the
 * caller's transaction and rejecting the event.
 *
 * Only that constraint's violation means "already moved". Any other unique
 * violation is a real failure and is rethrown.
 */
async function moveToCurrentToken(
  db: Knex,
  projectId: string,
  alias: AliasRow,
  supersedes: string
): Promise<void> {
  try {
    await db.transaction(async (savepoint) => {
      await savepoint("entity_aliases")
        .where({
          project_id: projectId,
          journey_id: alias.journeyId,
          alias_type: alias.aliasType,
          alias_value_hash: supersedes
        })
        // A row under the new token can already exist: the previous key was
        // removed early, the alias stored again, and the key restored. Moving
        // the old row onto it would violate the unique constraint, so the old
        // row is left for re-encryption to settle.
        .whereNotExists((current) => {
          void current.select(savepoint.raw("1")).from({ c: "entity_aliases" }).where({
            "c.project_id": projectId,
            "c.journey_id": alias.journeyId,
            "c.alias_type": alias.aliasType,
            "c.alias_value_hash": alias.aliasValueHash
          });
        })
        .update({
          alias_value_hash: alias.aliasValueHash,
          encrypted_display_value: alias.encryptedDisplayValue,
          // The ciphertext now holds this statement's spelling, so a copy
          // follows it. A masking statement leaves the row displayable here
          // with no copy, and the insert that follows, in the same
          // transaction, lowers the flag.
          display_value: savepoint.raw("case when displayable then ?::text end", [
            alias.displayable ? alias.value : null
          ])
        });
    });
  } catch (error) {
    if (!isAliasUniqueViolation(error)) throw error;
  }
}
