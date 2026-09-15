import type { Knex } from "knex";

/**
 * Whether the connection holding a transaction-scoped advisory lock still holds it.
 *
 * The lock lasts exactly as long as that connection's transaction, so a query
 * that succeeds on it proves the lock is still held. `select 1` has no bound
 * parameters, so it leaves no portal or snapshot behind, and it resets any
 * idle-in-transaction timer on the way. The rotation, the retention sweep, and
 * range deletion all hold their lock this way and check it before every batch.
 */
export async function lockHolderAlive(holder: Knex.Transaction): Promise<boolean> {
  try {
    await holder.raw("select 1");
    return true;
  } catch {
    return false;
  }
}

export type LockedRun<T> = { acquired: false } | { acquired: true; value: T };

/**
 * Run `work` while one dedicated connection holds a transaction-scoped advisory lock.
 *
 * A session lock taken and released by separate pooled queries can be released
 * on a different connection than the one that took it; the release then fails
 * and the lock stays with an idle pooled backend until a restart. Here the
 * holder is one transaction for the whole run: committing it releases the lock,
 * and a process that dies drops the connection and the lock with it. `work`
 * writes through other connections, each batch its own transaction, so batches
 * commit as they go; it receives the holder only to check `lockHolderAlive`.
 *
 * The key is inlined, not bound: a bound parameter leaves an unnamed portal
 * open with its snapshot for the life of the transaction, which would keep
 * VACUUM from removing the very rows a deletion removes. That is why it must be
 * a safe integer constant, never input.
 */
export async function withTransactionLock<T>(
  db: Knex,
  key: number,
  work: (holder: Knex.Transaction) => Promise<T>
): Promise<LockedRun<T>> {
  if (!Number.isSafeInteger(key)) throw new RangeError("An advisory lock key must be an integer.");

  const holder = await db.transaction();
  try {
    const acquired: unknown = await holder.raw(
      `select pg_try_advisory_xact_lock(${String(key)}) as locked`
    );
    const locked = (acquired as { rows: { locked: boolean }[] }).rows[0]?.locked === true;
    if (!locked) return { acquired: false };
    return { acquired: true, value: await work(holder) };
  } finally {
    // Nothing was written through the holder. If its connection has already
    // gone, so has the lock, and a failure here must not hide the run's own
    // error.
    await holder.commit().catch(() => undefined);
  }
}
