import type { Knex } from "knex";

/**
 * Insert a row and return its generated id.
 *
 * Knex types `.returning()` as `any`, which puts every call site in a bind: an
 * assertion trips `no-unnecessary-type-assertion` (asserting *from* `any`
 * "changes nothing"), while no assertion trips `no-unsafe-assignment`. This is
 * the single place that boundary is crossed, and it narrows by actually checking
 * the value at runtime rather than asserting a shape and hoping.
 */
export async function insertReturningId(
  db: Knex,
  table: string,
  values: Record<string, unknown>
): Promise<string> {
  const rows: unknown = await db(table).insert(values).returning("id");

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Insert into ${table} returned no rows.`);
  }

  const first: unknown = rows[0];
  if (typeof first !== "object" || first === null || !("id" in first)) {
    throw new Error(`Insert into ${table} returned no id column.`);
  }

  const id: unknown = (first as Record<"id", unknown>).id;
  if (typeof id !== "string") {
    throw new Error(`Insert into ${table} returned a non-string id.`);
  }
  return id;
}
