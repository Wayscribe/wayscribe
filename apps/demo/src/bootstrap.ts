import { createKnexConfig, seedDemo } from "@flight-recorder/database";
import knex, { type Knex } from "knex";
import { demoDatabase, ensureCustomerTable } from "./customers.js";
import { requiredEnv } from "./env.js";

/**
 * Everything the demo needs before any service starts, in one place.
 *
 * Compose runs this once and waits for it to exit, so the services that follow
 * can assume a migrated schema, a registered API key, and a customer table.
 * Every step is idempotent, because `up` runs it again on every start.
 */

/**
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT EXISTS`,
 * so existence is checked first.
 */
async function createDemoDatabase(db: Knex, name: string): Promise<void> {
  const result: unknown = await db.raw("select 1 from pg_database where datname = ?", [name]);
  const rows = (result as { rows?: unknown[] }).rows ?? [];
  if (rows.length > 0) {
    console.log(`[bootstrap] database ${name} already exists`);
    return;
  }

  // The name comes from Compose, not from a request, and an identifier cannot
  // be bound as a parameter — so it is quoted rather than interpolated raw.
  await db.raw(`create database "${name.replace(/"/g, '""')}"`);
  console.log(`[bootstrap] created database ${name}`);
}

const flight = knex(createKnexConfig(requiredEnv("DATABASE_URL")));

try {
  const [, applied] = (await flight.migrate.latest()) as [number, string[]];
  console.log(
    applied.length === 0
      ? "[bootstrap] schema already up to date"
      : `[bootstrap] applied ${String(applied.length)} migrations`
  );

  const seeded = await seedDemo(
    flight,
    requiredEnv("ENCRYPTION_KEY"),
    requiredEnv("FLIGHT_API_KEY")
  );
  console.log(`[bootstrap] demo project ${seeded.projectId} ready`);

  await createDemoDatabase(flight, requiredEnv("DEMO_DATABASE_NAME"));
} finally {
  await flight.destroy();
}

const demo = demoDatabase();
try {
  await ensureCustomerTable(demo);
  console.log("[bootstrap] customer table ready");
} finally {
  await demo.destroy();
}
