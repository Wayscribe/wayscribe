import type { Knex } from "knex";

/**
 * Whether the connection holding a transaction-scoped advisory lock still holds it.
 *
 * The lock lasts exactly as long as that connection's transaction, so a query
 * that succeeds on it proves the lock is still held. `select 1` has no bound
 * parameters, so it leaves no portal or snapshot behind, and it resets any
 * idle-in-transaction timer on the way. The rotation and the retention sweep
 * both hold their lock this way and check it before every batch.
 */
export async function lockHolderAlive(holder: Knex.Transaction): Promise<boolean> {
  try {
    await holder.raw("select 1");
    return true;
  } catch {
    return false;
  }
}
