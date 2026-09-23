export type EncryptedTable = "journeys" | "entity_aliases" | "replay_destinations";

export interface TableSpec {
  table: EncryptedTable;
  column: string;
  /** The primary key, in the order batches are walked. */
  key: readonly string[];
  /** The search token column derived from the same plaintext, if any. */
  searchToken?: string;
}

/**
 * Every column holding a value `encryptValue` wrote.
 *
 * Journeys and aliases also carry a search token computed from the same
 * plaintext; each is rewritten in the same statement as its ciphertext, so the
 * ciphertext's key id marks progress for both.
 */
export const ENCRYPTED_TABLES: readonly TableSpec[] = [
  {
    table: "journeys",
    column: "encrypted_primary_entity_id",
    key: ["project_id", "id"],
    searchToken: "primary_entity_id_hash"
  },
  {
    table: "entity_aliases",
    column: "encrypted_display_value",
    key: ["id"],
    searchToken: "alias_value_hash"
  },
  { table: "replay_destinations", column: "encrypted_headers", key: ["id"] }
];
