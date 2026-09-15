// Measure how much disk Flight Recorder uses per event, in each capture mode.
//
//   pnpm --filter "@flight-recorder/api..." build
//   node scripts/measure-storage.mjs --database-url postgresql://… --journeys 10000
//
// For each capture mode it records N journeys of the demo's shape through the
// real ingestion code (the function the API's POST /v1/events calls, without
// HTTP in front of it), then reports table and index sizes, bytes per event,
// and bytes per journey, both as ingested and compacted. It then expires half
// the journeys, runs the real retention sweep, and reports the size before and
// after a plain VACUUM and after ingesting as many journeys again, so the
// documentation can say what retention does to disk.
//
// Each mode runs in a schema of its own (measure_storage_<mode>), created with
// the real migrations and dropped at the end. A table's file never shrinks
// under plain VACUUM, so modes sharing tables would each measure the
// high-water mark of the one before. It also means the script never reads or
// writes the tables an installation already has.
//
// It still refuses a database whose journeys table has rows, unless --force:
// ingesting a million events is real load, and nobody should find that out by
// pasting the production URL.
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import { parseArgs } from "node:util";

const USAGE = `Usage: node scripts/measure-storage.mjs --database-url <url> [options]

  --database-url <url>   A scratch PostgreSQL database (default: $DATABASE_URL)
  --journeys <n>         Journeys per capture mode (default: 10000)
  --modes <list>         Comma-separated capture modes (default: all four)
  --concurrency <n>      Journeys ingested at once (default: 8)
  --force                Run even though the database already holds journeys
  --keep                 Leave the measure_storage_* schemas behind for inspection
`;

const ALL_MODES = ["metadata-only", "allowlisted-fields", "redacted-payload", "full-payload"];

/** Ten events, as the demo records them: webhook, transform, persist, identify, publish, consume, three deliveries, dead letter. */
const EVENTS_PER_JOURNEY = 10;

const TABLES = ["journeys", "journey_events", "entity_aliases"];

// Days old of the expiring half and of the kept half, against a retention of
// RETENTION_DAYS. Far from the boundary on both sides so the sweep deletes
// exactly half regardless of how long ingestion took.
const EXPIRED_AGE_DAYS = 20;
const KEPT_AGE_DAYS = 1;
const RETENTION_DAYS = 10;

const { values: args } = parseArgs({
  options: {
    "database-url": { type: "string" },
    journeys: { type: "string", default: "10000" },
    modes: { type: "string", default: ALL_MODES.join(",") },
    concurrency: { type: "string", default: "8" },
    force: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  }
});

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
const journeyCount = Number(args.journeys);
const concurrency = Number(args.concurrency);
const modes = args.modes.split(",").map((mode) => mode.trim());

if (databaseUrl === undefined || databaseUrl === "") fail("--database-url is required.");
if (!Number.isInteger(journeyCount) || journeyCount < 2)
  fail("--journeys must be an integer of at least 2.");
if (!Number.isInteger(concurrency) || concurrency < 1)
  fail("--concurrency must be a positive integer.");
for (const mode of modes) {
  if (!ALL_MODES.includes(mode))
    fail(`Unknown capture mode ${mode}. Expected one of ${ALL_MODES.join(", ")}.`);
}

const root = new URL("../", import.meta.url);

// The built output, not the TypeScript sources: plain `node` cannot load
// those, and dist is what the published image runs.
const { ingestEvent } = await loadBuilt("apps/api/dist/ingestion/ingest-event.js");
const { createKnexConfig, sweepExpiredJourneys } = await loadBuilt(
  "packages/database/dist/index.js"
);
const { createKeyring } = await loadBuilt("packages/payload-security/dist/index.js");
// From the database package: pnpm installs knex there, not at the root.
const knex = createRequire(new URL("packages/database/package.json", root))("knex");

const admin = knex(createKnexConfig(databaseUrl));

try {
  await refuseNonEmptyDatabase(admin);
  const server = await admin.raw("select version() as version");
  console.log(`\n${server.rows[0].version}`);
  console.log(
    `${journeyCount.toLocaleString("en-US")} journeys and ${(journeyCount * EVENTS_PER_JOURNEY).toLocaleString("en-US")} events per capture mode\n`
  );

  const results = [];
  for (const mode of modes) {
    results.push(await measureMode(mode));
  }
  printSummary(results);
} finally {
  await admin.destroy();
}

async function measureMode(mode) {
  const schema = `measure_storage_${mode.replaceAll("-", "_")}`;
  await admin.raw("drop schema if exists ?? cascade", [schema]);
  await admin.raw("create schema ??", [schema]);

  const db = knex({ ...createKnexConfig(databaseUrl), searchPath: [schema] });
  try {
    await db.migrate.latest();

    const [project] = await db("projects")
      .insert({ name: "Storage measurement", slug: "storage-measurement" })
      .returning("id");
    const allowlist = [
      "Id",
      "Status__c",
      "externalId",
      "status",
      "customer.externalId",
      "internalCustomerId",
      "messageId"
    ];
    const [environment] = await db("environments")
      .insert({
        project_id: project.id,
        name: "measurement",
        capture_mode: mode,
        capture_allowlist: JSON.stringify(allowlist),
        retention_days: 3650
      })
      .returning("id");

    const context = {
      id: randomUUID(),
      projectId: project.id,
      environmentId: environment.id,
      environmentName: "measurement",
      keyHash: "",
      keyHashKeyId: null,
      revokedAt: null,
      captureMode: mode,
      redactionPaths: [],
      captureAllowlist: allowlist
    };
    const keyring = createKeyring(randomBytes(16).toString("hex"));

    /**
     * Journeys [from, to), `concurrency` at a time. The events of one journey
     * go in order, as a single SDK process sends them; journeys interleave.
     */
    const ingest = async (from, to, isExpired) => {
      let next = from;
      const worker = async () => {
        while (next < to) {
          const index = next;
          next += 1;
          for (const envelope of demoJourney(index, isExpired(index))) {
            const result = await ingestEvent(
              db,
              keyring,
              context,
              envelope,
              undefined,
              mode === "full-payload"
            );
            if (result.status !== "accepted") {
              throw new Error(
                `Ingestion rejected an event: ${result.code ?? ""} ${result.message ?? ""}`
              );
            }
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
    };

    const started = Date.now();
    await ingest(0, journeyCount, (index) => index % 2 === 0);
    const seconds = (Date.now() - started) / 1000;

    // As ingested, after one plain VACUUM. Every event updates its journey
    // row, and none of those updates can be HOT because indexed columns
    // change, so the journeys table and its indexes carry the churn of ten
    // versions per journey. That space is reusable but still on disk.
    await db.raw("vacuum analyze");
    const stored = await sizes(db, schema);
    const counts = await rowCounts(db);

    // The same rows rewritten without the churn: the least this data can
    // occupy. An installation's real footprint lies between the two.
    await db.raw("vacuum full");
    const compacted = await sizes(db, schema);

    // Retention: half the journeys fall outside the window and the real sweep
    // deletes them, with their events and aliases by cascade.
    await db("environments")
      .where({ id: environment.id })
      .update({ retention_days: RETENTION_DAYS });
    const sweep = await sweepExpiredJourneys(db, {
      batchSize: 1_000,
      maxBatchesPerEnvironment: 1_000_000
    });
    const afterSweep = await sizes(db, schema);
    await db.raw("vacuum");
    const afterVacuum = await sizes(db, schema);

    // Then as many new journeys as the sweep removed, which is a retention
    // window in steady state. Whether disk grows again or the freed space is
    // reused is what an operator sizing a volume needs to know.
    await ingest(journeyCount, journeyCount + sweep.journeysDeleted, () => false);
    await db.raw("vacuum");
    const afterRefill = await sizes(db, schema);

    const result = {
      mode,
      seconds,
      stored,
      compacted,
      counts,
      sweep,
      afterSweep,
      afterVacuum,
      afterRefill
    };
    printMode(result);
    return result;
  } finally {
    await db.destroy();
    if (!args.keep) await admin.raw("drop schema if exists ?? cascade", [schema]);
  }
}

/**
 * The demo journey (docs/DEMO_SCENARIO.md), with values that differ per
 * journey so compression and TOAST see realistic variety rather than one row
 * repeated.
 */
function demoJourney(index, expired) {
  const journeyId = `jrn_${randomUUID()}`;
  const accountId = `0018Z${String(index).padStart(8, "0")}`;
  const internalCustomerId = String(100_000 + index);
  const messageId = randomUUID();
  const base =
    Date.now() -
    (expired ? EXPIRED_AGE_DAYS : KEPT_AGE_DAYS) * 86_400_000 +
    (index % 3_600) * 1_000;

  const account = {
    Id: accountId,
    Name: `Customer ${String(index)}`,
    Phone: `+1 919 555 ${String(index % 10_000).padStart(4, "0")}`,
    Status__c: "Active"
  };
  const customer = { externalId: accountId, name: account.Name, phone: null, status: "active" };
  const message = { customer, internalCustomerId: Number(internalCustomerId) };
  const rejection = {
    status: 422,
    body: { error: { code: "phone_required", message: "A phone number is required." } }
  };

  const event = (offsetSeconds, service, fields) => ({
    protocolVersion: "0.1",
    event: {
      id: `evt_${randomUUID()}`,
      journeyId,
      environment: "measurement",
      service,
      entity: { type: "customer", id: accountId },
      timestamp: new Date(base + offsetSeconds * 1_000).toISOString(),
      ...fields
    }
  });

  const delivery = (offsetSeconds, name, operation, attempt) =>
    event(offsetSeconds, "demo-worker", {
      operation,
      name,
      durationMs: 41,
      input: customer,
      output: rejection,
      error: {
        type: "DeliveryFailed",
        message: "The target rejected the customer.",
        code: "phone_required"
      },
      metadata: { attempt }
    });

  return [
    event(0, "demo-integration", {
      operation: "received",
      name: "receive-salesforce-webhook",
      input: account
    }),
    event(2, "demo-integration", {
      operation: "transformed",
      name: "transform-salesforce-account",
      durationMs: 1,
      input: account,
      output: customer
    }),
    event(3, "demo-integration", {
      operation: "persisted",
      name: "persist-customer",
      durationMs: 6,
      input: customer,
      output: Number(internalCustomerId)
    }),
    event(3, "demo-integration", {
      operation: "identified",
      name: "identify",
      aliases: { salesforceAccountId: accountId, internalCustomerId }
    }),
    event(4, "demo-integration", {
      operation: "published",
      name: "publish-customer-updated",
      durationMs: 9,
      input: message,
      output: { messageId }
    }),
    event(5, "demo-worker", {
      operation: "consumed",
      name: "consume-customer-updated",
      input: message,
      metadata: { messageId }
    }),
    delivery(7, "deliver-customer-to-target", "delivered", 1),
    delivery(37, "retry-customer-delivery", "retried", 2),
    delivery(97, "retry-customer-delivery", "retried", 3),
    event(216, "demo-worker", {
      operation: "failed",
      name: "move-message-to-dead-letter",
      error: {
        type: "Error",
        message: "Delivery failed on every attempt; the message moved to the dead-letter queue."
      },
      metadata: { queue: "customer-updates-dlq", messageId }
    })
  ];
}

async function sizes(db, schema) {
  const result = await db.raw(
    `select c.relname as table,
            pg_relation_size(c.oid) as heap,
            coalesce(pg_total_relation_size(c.reltoastrelid), 0) as toast,
            pg_indexes_size(c.oid) as indexes,
            pg_total_relation_size(c.oid) as total
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ? and c.relname = any(?)`,
    [schema, TABLES]
  );
  const byTable = Object.fromEntries(
    result.rows.map((row) => [
      row.table,
      {
        heap: Number(row.heap),
        toast: Number(row.toast),
        indexes: Number(row.indexes),
        total: Number(row.total)
      }
    ])
  );
  const total = TABLES.reduce((sum, table) => sum + (byTable[table]?.total ?? 0), 0);
  return { byTable, total };
}

async function rowCounts(db) {
  const [journeys, events, aliases] = await Promise.all(
    TABLES.map(async (table) => Number((await db(table).count({ n: "*" }))[0].n))
  );
  return { journeys, events, aliases };
}

function printMode(result) {
  const { mode, seconds, stored, compacted, counts, sweep } = result;
  const rows = {
    journeys: counts.journeys,
    journey_events: counts.events,
    entity_aliases: counts.aliases
  };
  console.log(
    `${mode}  (${counts.events.toLocaleString("en-US")} events ingested in ${seconds.toFixed(0)} s)`
  );
  printTable(
    ["table", "rows", "heap", "toast", "indexes", "total", "compacted"],
    [
      ...TABLES.map((table) => {
        const size = stored.byTable[table];
        return [
          table,
          rows[table].toLocaleString("en-US"),
          bytes(size.heap),
          bytes(size.toast),
          bytes(size.indexes),
          bytes(size.total),
          bytes(compacted.byTable[table].total)
        ];
      }),
      ["all three", "", "", "", "", bytes(stored.total), bytes(compacted.total)]
    ]
  );
  console.log(
    `  per event: ${perEvent(stored, counts)} as ingested, ${perEvent(compacted, counts)} compacted`
  );
  console.log(
    `  retention deleted ${sweep.journeysDeleted.toLocaleString("en-US")} journeys: ` +
      `${bytes(compacted.total)} before, ${bytes(result.afterSweep.total)} after the sweep, ` +
      `${bytes(result.afterVacuum.total)} after VACUUM, ` +
      `${bytes(result.afterRefill.total)} after as many new journeys again\n`
  );
}

function printSummary(results) {
  console.log(
    "Summary (sizes are journeys, journey_events, and entity_aliases with their indexes)"
  );
  printTable(
    [
      "capture mode",
      "per event",
      "compacted",
      "per journey",
      "total",
      "retention: swept + VACUUM",
      "refilled"
    ],
    results.map((r) => [
      r.mode,
      perEvent(r.stored, r.counts),
      perEvent(r.compacted, r.counts),
      bytes(r.stored.total / r.counts.journeys),
      bytes(r.stored.total),
      bytes(r.afterVacuum.total),
      bytes(r.afterRefill.total)
    ])
  );
}

function perEvent(size, counts) {
  return `${Math.round(size.total / counts.events).toLocaleString("en-US")} B`;
}

function printTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length))
  );
  const line = (cells) =>
    "  " +
    cells
      .map((cell, column) =>
        column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column])
      )
      .join("  ");
  console.log(line(headers));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(line(row));
}

function bytes(value) {
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

async function refuseNonEmptyDatabase(db) {
  const tables = await db.raw(
    `select n.nspname as schema from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relname = 'journeys' and c.relkind = 'r' and n.nspname not like 'measure\\_storage\\_%'`
  );
  for (const { schema } of tables.rows) {
    const found = await db.raw(`select exists (select 1 from ??.journeys) as found`, [schema]);
    if (found.rows[0].found && !args.force) {
      fail(
        `${schema}.journeys already has rows, so this looks like a real installation.\n` +
          "The measurement ingests every journey through the real ingestion code, which is real load.\n" +
          "Point --database-url at a scratch database, or pass --force if you mean it."
      );
    }
  }
}

async function loadBuilt(path) {
  try {
    return await import(new URL(path, root).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      fail(`${path} is missing. Build first: pnpm --filter "@flight-recorder/api..." build`);
    }
    throw error;
  }
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}
