// Measure how long the journey list (GET /v1/journeys) takes on a large
// installation.
//
//   pnpm --filter "@wayscribe/api..." build
//   node scripts/measure-journey-list.mjs --database-url postgresql://… --journeys 120000
//
// It records journeys through the real ingestion code, as
// scripts/measure-storage.mjs does, in a shape meant to look like a working
// installation: four environments of very different volume, a spread of
// statuses and entity types, labels that are mostly distinct but share a few
// words, displayable and masked aliases, and last activity spread over 40
// days. Then it times GET /v1/journeys through the real API (Fastify's
// `inject`, so authentication, validation, the query and the response are
// all in the figure, and only the network is not) for each case below, and
// prints the median and 95th percentile. The slowest cases are run once more
// under EXPLAIN (ANALYZE, BUFFERS) with the exact SQL and parameters the API
// sent. It then times ingestion (a batch of 100 events and a single event),
// because every index this list uses is also written on every event.
//
// Like measure-storage.mjs it works in a schema of its own
// (measure_storage_journey_list), created with the real migrations and
// dropped at the end, and refuses a database whose journeys table has rows
// unless --force.
//
// --keep leaves the schema behind and --reuse measures a kept one again
// without recording anything, after applying any migration added since, so an
// index can be measured before and after on the same rows. Each --drop-index
// adds a stage measured without that index and the ones before it, which
// gives the same comparison in one run.
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { URLSearchParams } from "node:url";
import { parseArgs } from "node:util";
import { MEASUREMENT_SCHEMA_PREFIX, vacuumStatement } from "./measure-storage-checks.mjs";

const USAGE = `Usage: node scripts/measure-journey-list.mjs --database-url <url> [options]

  --database-url <url>   A scratch PostgreSQL database (default: $DATABASE_URL)
  --journeys <n>         Journeys to record (default: 120000)
  --samples <n>          Timed requests per case, after three warm-up requests (default: 40)
  --concurrency <n>      Journeys ingested at once (default: 8)
  --explain <n>          Cases to run under EXPLAIN (ANALYZE, BUFFERS), slowest first (default: 4)
  --drop-index <name>    Measure again after dropping this index; repeated, each stage
                         drops one more (a kept schema stays without them)
  --ingest-samples <n>   Timed ingestion requests of each kind per stage per round,
                         0 for none (default: 100)
  --ingest-rounds <n>    Rounds in which the stages take turns at ingestion (default: 3)
  --no-list              Measure ingestion only
  --force                Run even though the database already holds journeys
  --keep                 Leave the schema behind for inspection or --reuse
  --reuse                Measure a schema an earlier --keep run left, without recording
`;

const SCHEMA = `${MEASUREMENT_SCHEMA_PREFIX}journey_list`;
const TABLES = ["journeys", "journey_events", "entity_aliases"];
const APPLICATION_NAME = "measure-journey-list";
const ADMIN_TOKEN = randomBytes(32).toString("hex");

const DAY = 86_400_000;
/** Last activity is spread evenly over this many days before the run. */
const SPREAD_DAYS = 40;

/** Share of journeys per environment: one busy, three quiet. */
const ENVIRONMENTS = [
  ["production", 0.8],
  ["staging", 0.12],
  ["development", 0.06],
  ["sandbox", 0.02]
];
const ENTITY_TYPES = [
  ["customer", 0.5],
  ["order", 0.3],
  ["invoice", 0.15],
  ["subscription", 0.05]
];
/** The journey's last event: completed, failed, or still going (active). */
const OUTCOMES = [
  ["completed", 0.85],
  ["failed", 0.05],
  ["active", 0.1]
];
const ACTIONS = ["Sync", "Import", "Refund", "Update", "Renew", "Export", "Invoice", "Ship"];
const COMPANIES = [
  "Acme",
  "Northwind",
  "Globex",
  "Initech",
  "Umbrella",
  "Stark",
  "Wayne",
  "Tyrell",
  "Soylent",
  "Hooli",
  "Vandelay",
  "Wonka",
  "Cyberdyne",
  "Gringotts",
  "Monarch",
  "Oscorp",
  "Pied Piper",
  "Duff",
  "Nakatomi",
  "Zorg"
];
/** Share of journeys with a label, and with at least one displayable alias. */
const LABELLED = 0.75;
const DISPLAYABLE = 0.85;

/** Text that matches many journeys: one label in eight starts with it. */
const TEXT_MANY = "sync";
/** Text that matches none, so every journey in the window is tested. */
const TEXT_NONE = "zq-no-such-text";
/** Text that matches a few percent, for the combination with entityType. */
const TEXT_SOME = "acme";

const { values: args } = parseArgs({
  options: {
    "database-url": { type: "string" },
    journeys: { type: "string", default: "120000" },
    samples: { type: "string", default: "40" },
    concurrency: { type: "string", default: "8" },
    explain: { type: "string", default: "4" },
    "drop-index": { type: "string", multiple: true, default: [] },
    "ingest-samples": { type: "string", default: "100" },
    "ingest-rounds": { type: "string", default: "3" },
    "no-list": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    reuse: { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  }
});

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
const journeyCount = Number(args.journeys);
const samples = Number(args.samples);
const concurrency = Number(args.concurrency);
const explainCount = Number(args.explain);
const ingestSamples = Number(args["ingest-samples"]);
const ingestRounds = Number(args["ingest-rounds"]);

if (databaseUrl === undefined || databaseUrl === "") fail("--database-url is required.");
for (const [name, value, least] of [
  ["--journeys", journeyCount, 100],
  ["--samples", samples, 2],
  ["--concurrency", concurrency, 1],
  ["--explain", explainCount, 0],
  ["--ingest-samples", ingestSamples, 0],
  ["--ingest-rounds", ingestRounds, 1]
]) {
  if (!Number.isInteger(value) || value < least)
    fail(`${name} must be an integer of at least ${least}.`);
}

const root = new URL("../", import.meta.url);
const { ingestEvent } = await loadBuilt("apps/api/dist/ingestion/ingest-event.js");
const { buildApp } = await loadBuilt("apps/api/dist/app.js");
const { createKnexConfig } = await loadBuilt("packages/database/dist/index.js");
const { createKeyring, issueApiKey } = await loadBuilt("packages/payload-security/dist/index.js");
const knex = createRequire(new URL("packages/database/package.json", root))("knex");

const admin = knex(createKnexConfig(databaseUrl));
let interrupted = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    console.error(`\n${signal}: stopping.`);
    void stopAndCleanUp().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

try {
  await refuseNonEmptyDatabase(admin);
  const server = await admin.raw(
    "select version() as version, current_setting('shared_buffers') as sb"
  );
  console.log(`\n${server.rows[0].version} (shared_buffers ${server.rows[0].sb})`);
  await run();
} finally {
  await admin.destroy();
}

async function run() {
  if (args.reuse) {
    const found = await admin.raw("select 1 from pg_namespace where nspname = ?", [SCHEMA]);
    if (found.rows.length === 0)
      fail(`--reuse: there is no ${SCHEMA} schema. Run with --keep first.`);
  } else {
    await admin.raw("drop schema if exists ?? cascade", [SCHEMA]);
    await admin.raw("create schema ??", [SCHEMA]);
  }

  const db = knex({
    ...createKnexConfig(databaseUrl),
    connection: { connectionString: databaseUrl, application_name: APPLICATION_NAME },
    searchPath: [SCHEMA]
  });
  let app;
  try {
    await db.migrate.latest();
    const keyring = createKeyring(await measurementKey(db));
    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
    // Before recording, so a mistyped name costs seconds rather than the
    // whole recording, and by throwing, so the schema is still dropped.
    const drops = args["drop-index"];
    const definitions = await indexDefinitions(db, drops);
    const setup = args.reuse ? await existingSetup(db, keyring) : await record(db, keyring);
    const { sql, bindings } = vacuumStatement(["analyze"], SCHEMA, TABLES);
    await db.raw(sql, bindings);
    await describeData(db);

    // Every index first, then one stage per --drop-index, each without the
    // indexes dropped so far, all on the same rows.
    const setStage = async (stage) => {
      for (const [i, index] of drops.entries()) {
        await (i < stage
          ? db.raw("drop index if exists ??", [`${SCHEMA}.${index}`])
          : db.raw(definitions.get(index)));
      }
      await db.raw(sql, bindings);
    };
    const labels = [0, ...drops.map((_, i) => i + 1)].map((stage) =>
      stage === 0 ? "every index" : `without ${drops.slice(0, stage).join(", ")}`
    );
    const stages = labels.map((label) => ({ label }));

    if (!args["no-list"]) {
      for (const [i, stage] of stages.entries()) {
        await setStage(i);
        stage.list = await measure(db, app, setup);
        printResults(`GET /v1/journeys, page of 25, milliseconds, ${stage.label}`, stage.list);
        await explainSlowest(db, app, setup, stage.list);
      }
    }

    // Ingestion is a few milliseconds an event and drifts as the tables grow
    // and the cache warms, so the stages take turns, round after round, and
    // each stage's samples are pooled.
    if (ingestSamples > 0) {
      const pooled = stages.map(() => new Map());
      for (let round = 0; round < ingestRounds; round += 1) {
        for (const [i, pool] of pooled.entries()) {
          await setStage(i);
          for (const [name, times] of await measureIngestion(app, setup)) {
            pool.set(name, [...(pool.get(name) ?? []), ...times]);
          }
        }
      }
      for (const [i, stage] of stages.entries()) {
        stage.ingestion = [...pooled[i]].map(([name, times]) => summarize(name, times));
        printResults(`Ingestion, milliseconds, ${stage.label}`, stage.ingestion);
      }
    }
    await setStage(0);
    if (stages.length > 1) printComparison(stages);
  } finally {
    await app?.close();
    await db.destroy();
    if (!args.keep && !interrupted) await admin.raw("drop schema if exists ?? cascade", [SCHEMA]);
    if (args.keep) console.log(`\nKept ${SCHEMA}. Measure it again with --reuse.`);
  }
}

/**
 * The project, environments and API key, then every journey through the real
 * ingestion code. Returns what the measurement needs to call the API.
 */
async function record(db, keyring) {
  const [project] = await db("projects")
    .insert({ name: "List measurement", slug: "list-measurement" })
    .returning("id");
  const contexts = [];
  for (const [name] of ENVIRONMENTS) {
    const [environment] = await db("environments")
      .insert({
        project_id: project.id,
        name,
        capture_mode: "metadata-only",
        retention_days: 3650
      })
      .returning("id");
    contexts.push({
      id: randomUUID(),
      projectId: project.id,
      environmentId: environment.id,
      environmentName: name,
      keyHash: "",
      keyHashKeyId: null,
      revokedAt: null,
      captureMode: "metadata-only",
      redactionPaths: [],
      captureAllowlist: []
    });
  }
  const apiKey = await storeKey(db, keyring, project.id, contexts[0].environmentId);

  const now = Date.now();
  let next = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    while (next < journeyCount && !interrupted) {
      const index = next;
      next += 1;
      const journey = shapedJourney(index, now);
      const context = contexts[journey.environment];
      for (const envelope of journey.events) {
        const result = await ingestEvent(db, keyring, context, envelope);
        if (result.status !== "accepted") {
          throw new Error(
            `Ingestion rejected an event: ${result.code ?? ""} ${result.message ?? ""}`
          );
        }
      }
      done += 1;
      if (done % 20_000 === 0) {
        console.log(
          `  ${done.toLocaleString("en-US")} journeys in ${((Date.now() - started) / 1000).toFixed(0)} s`
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(
    `Recorded ${journeyCount.toLocaleString("en-US")} journeys in ${((Date.now() - started) / 1000).toFixed(0)} s`
  );
  return { projectId: project.id, apiKey, keyEnvironment: ENVIRONMENTS[0][0] };
}

/**
 * The encryption key the recorded journeys were written with, kept in the
 * schema so a --reuse run decrypts entity ids as the first run did rather
 * than skipping them as unreadable. A scratch key for scratch data.
 */
async function measurementKey(db) {
  await db.raw("create table if not exists measurement_key (key text not null)");
  const kept = await db("measurement_key").first("key");
  if (kept !== undefined) return kept.key;
  const key = randomBytes(16).toString("hex");
  await db("measurement_key").insert({ key });
  return key;
}

/** A kept schema's project, with a fresh key for its busy environment. */
async function existingSetup(db, keyring) {
  const project = await db("projects").where({ slug: "list-measurement" }).first("id");
  const environment = await db("environments")
    .where({ project_id: project.id, name: ENVIRONMENTS[0][0] })
    .first("id");
  const apiKey = await storeKey(db, keyring, project.id, environment.id);
  return { projectId: project.id, apiKey, keyEnvironment: ENVIRONMENTS[0][0] };
}

async function storeKey(db, keyring, projectId, environmentId) {
  // The keyring is new on every run, so a kept schema's old keys no longer verify.
  await db("api_keys").where({ project_id: projectId }).delete();
  const generated = issueApiKey(keyring);
  await db("api_keys").insert({
    project_id: projectId,
    environment_id: environmentId,
    name: "measurement",
    key_prefix: generated.keyPrefix,
    key_hash: generated.verifier,
    key_hash_key_id: generated.keyHashKeyId
  });
  return generated.apiKey;
}

/**
 * One journey of three events. Chosen from the index by a seeded generator, so
 * two runs of the same size record the same shape.
 */
function shapedJourney(index, now) {
  const random = mulberry32(index + 1);
  const environment = pick(
    ENVIRONMENTS.map(([, share], i) => [i, share]),
    random()
  );
  const entityType = pick(ENTITY_TYPES, random());
  const outcome = pick(OUTCOMES, random());
  const company = COMPANIES[Math.floor(random() * COMPANIES.length)];
  const action = ACTIONS[Math.floor(random() * ACTIONS.length)];
  const labelled = random() < LABELLED;
  const displayable = random() < DISPLAYABLE;
  const last = now - random() * SPREAD_DAYS * DAY;

  const journeyId = `jrn_${randomUUID()}`;
  const entityId = `${entityType.slice(0, 3).toUpperCase()}-${String(index).padStart(7, "0")}`;
  const reference = `REF-${String(100_000 + index)}`;
  const aliases = {
    reference,
    internalId: String(9_000_000 + index),
    account: `${company} ${String(index % 997)}`
  };

  const event = (offsetMs, operation, name, fields = {}) => ({
    protocolVersion: "0.1",
    event: {
      id: `evt_${randomUUID()}`,
      journeyId,
      environment: ENVIRONMENTS[environment][0],
      service: offsetMs < 0 ? "intake" : "worker",
      entity: { type: entityType, id: entityId },
      operation,
      name,
      timestamp: new Date(last + offsetMs).toISOString(),
      ...fields
    }
  });

  const terminal =
    outcome === "completed"
      ? event(0, "completed", "finish")
      : outcome === "failed"
        ? event(0, "failed", "deliver", { error: { type: "DeliveryFailed", message: "Rejected." } })
        : event(0, "consumed", "consume");

  return {
    environment,
    events: [
      event(-5_000, "received", "receive", {
        aliases,
        // Most journeys show their reference and account; the rest keep every
        // alias masked, and their internal id is never displayable.
        ...(displayable ? { displayableAliases: ["reference", "account"] } : {}),
        ...(labelled
          ? {
              journeyLabel: `${action} ${entityType} ${entityId} for ${company} ${String(index % 997)}`
            }
          : {})
      }),
      event(-2_000, "transformed", "transform"),
      terminal
    ]
  };
}

async function describeData(db) {
  const shape = await db.raw(
    `select count(*)::int as journeys,
            count(*) filter (where last_event_at >= now() - interval '1 day')::int as day,
            count(*) filter (where last_event_at >= now() - interval '30 days')::int as month,
            count(*) filter (where status = 'failed')::int as failed,
            count(*) filter (where label is not null)::int as labelled,
            count(*) filter (where label ilike ?)::int as many,
            count(*) filter (where label ilike ?)::int as some,
            (select count(*)::int from journey_events) as events,
            (select count(*)::int from entity_aliases) as aliases,
            (select count(*)::int from entity_aliases where displayable) as displayable
       from journeys`,
    [`%${TEXT_MANY}%`, `%${TEXT_SOME}%`]
  );
  const s = shape.rows[0];
  const n = (value) => value.toLocaleString("en-US");
  console.log(
    `\n${n(s.journeys)} journeys (${n(s.day)} in the last 24 hours, ${n(s.month)} in 30 days), ` +
      `${n(s.events)} events, ${n(s.aliases)} aliases (${n(s.displayable)} displayable)`
  );
  console.log(
    `${n(s.failed)} failed, ${n(s.labelled)} labelled; label contains "${TEXT_MANY}": ${n(s.many)}, "${TEXT_SOME}": ${n(s.some)}`
  );
  const sizes = await db.raw(
    `select c.relname as name, pg_size_pretty(pg_total_relation_size(c.oid)) as size
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ? and c.relname = any(?) order by c.relname`,
    [SCHEMA, TABLES]
  );
  console.log(sizes.rows.map((row) => `${row.name} ${row.size}`).join(", "));
}

/** Every case: a name, the query string, and whether it is the API key's. */
function cases(setup) {
  const now = Date.now();
  const since = (days) => new Date(now - days * DAY).toISOString();
  const windows = [
    ["24 h", since(1)],
    ["30 d", since(30)]
  ];
  const list = [];
  for (const [window, from] of windows) {
    list.push(
      { name: `1. no filter, admin, ${window}`, query: { since: from }, page2: true },
      { name: `2. no filter, API key, ${window}`, query: { since: from }, key: true },
      { name: `3. failed, admin, ${window}`, query: { since: from, status: "failed" } },
      {
        name: `4. q many ("${TEXT_MANY}"), admin, ${window}`,
        query: { since: from, q: TEXT_MANY },
        page2: true
      },
      { name: `5. q none, admin, ${window}`, query: { since: from, q: TEXT_NONE } },
      { name: `5k. q none, API key, ${window}`, query: { since: from, q: TEXT_NONE }, key: true }
    );
  }
  list.push({
    name: `6. q ("${TEXT_SOME}") + entityType invoice, admin, 30 d`,
    query: { since: since(30), q: TEXT_SOME, entityType: "invoice" }
  });
  return list.map((entry) => ({
    ...entry,
    headers: entry.key
      ? { authorization: `Bearer ${setup.apiKey}` }
      : { authorization: `Bearer ${ADMIN_TOKEN}`, "x-wayscribe-project-id": setup.projectId }
  }));
}

async function measure(db, app, setup) {
  const results = [];
  for (const entry of cases(setup)) {
    const first = await timeCase(db, app, entry, entry.query);
    results.push({ ...first, name: entry.name, entry, query: entry.query });
    if (entry.page2) {
      if (first.nextCursor === null) {
        console.log(`${entry.name}: one page only, so no second page to measure.`);
        continue;
      }
      const query = { ...entry.query, cursor: first.nextCursor };
      const second = await timeCase(db, app, entry, query);
      // "1. no filter, ..." becomes "7. no filter, ..., page 2".
      const name = `7. ${entry.name.replace(/^\S+ /, "")}, page 2`;
      results.push({ ...second, name, entry, query });
    }
  }
  return results;
}

/**
 * POST /v1/events/batch with 100 events (ten new journeys of ten events, each
 * with a label and three aliases, two of them displayable in half the
 * journeys and one in the rest), and POST /v1/events with one event that
 * starts a new journey with the same label and aliases. Timed through the API
 * with the busy environment's key, `--ingest-samples` of each after five
 * warm-up requests. Returns the times by name.
 */
async function measureIngestion(app, setup) {
  const headers = { authorization: `Bearer ${setup.apiKey}` };
  let serial = 0;
  const journeyEvents = (count, withTail) => {
    serial += 1;
    const journeyId = `jrn_ingest_${randomUUID()}`;
    const company = COMPANIES[serial % COMPANIES.length];
    const now = Date.now();
    return Array.from({ length: count }, (_, step) => ({
      id: `evt_${randomUUID()}`,
      journeyId,
      environment: setup.keyEnvironment,
      service: "worker",
      entity: { type: "order", id: `ORD-I${String(serial).padStart(8, "0")}` },
      operation: step === count - 1 && withTail ? "completed" : "transformed",
      name: `step-${String(step)}`,
      timestamp: new Date(now + step).toISOString(),
      ...(step === 0 || step === count - 1
        ? { journeyLabel: `Ship order ORD-I${String(serial)} for ${company}` }
        : {}),
      ...(step === 0
        ? {
            aliases: {
              reference: `REF-I${String(serial)}`,
              account: `${company} ${String(serial % 997)}`,
              internalId: String(50_000_000 + serial)
            },
            displayableAliases: serial % 2 === 0 ? ["reference", "account"] : ["reference"]
          }
        : {})
    }));
  };
  const time = async (name, request) => {
    const once = async () => {
      const started = performance.now();
      const response = await app.inject(request());
      const elapsed = performance.now() - started;
      if (response.statusCode !== 202) {
        throw new Error(`${name}: ${response.statusCode} ${response.body}`);
      }
      const results = response.json().data.results;
      if (results !== undefined && results.some((one) => one.status !== "accepted")) {
        throw new Error(`${name}: an event was rejected: ${response.body}`);
      }
      return elapsed;
    };
    for (let i = 0; i < 5; i += 1) await once();
    const times = [];
    for (let i = 0; i < ingestSamples; i += 1) times.push(await once());
    return [name, times];
  };
  return [
    await time("batch of 100 events, 10 new journeys", () => ({
      method: "POST",
      url: "/v1/events/batch",
      headers,
      payload: {
        events: Array.from({ length: 10 }, () => journeyEvents(10, true))
          .flat()
          .map((event) => ({ protocolVersion: "0.1", event }))
      }
    })),
    await time("single event, new journey", () => ({
      method: "POST",
      url: "/v1/events",
      headers,
      payload: { protocolVersion: "0.1", event: journeyEvents(1, false)[0] }
    }))
  ];
}

/** Three warm-up requests, then `samples` timed ones. */
async function timeCase(db, app, entry, query) {
  const url = `/v1/journeys?${new URLSearchParams(query).toString()}`;
  let body;
  const once = async () => {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url, headers: entry.headers });
    const elapsed = performance.now() - started;
    if (response.statusCode !== 200) {
      throw new Error(`${entry.name}: ${response.statusCode} ${response.body}`);
    }
    body = response.json();
    return elapsed;
  };
  for (let i = 0; i < 3; i += 1) await once();
  const times = [];
  for (let i = 0; i < samples; i += 1) times.push(await once());
  times.sort((a, b) => a - b);
  return {
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    rows: body.data.items.length,
    nextCursor: body.data.nextCursor
  };
}

/** The list query exactly as the API sent it, under EXPLAIN (ANALYZE, BUFFERS). */
async function explainSlowest(db, app, setup, results) {
  const slowest = [...results].sort((a, b) => b.p95 - a.p95).slice(0, explainCount);
  for (const result of slowest) {
    let captured;
    const listen = (query) => {
      if (query.sql.includes('as "environment"')) captured = query;
    };
    db.on("query", listen);
    try {
      const url = `/v1/journeys?${new URLSearchParams(result.query).toString()}`;
      await app.inject({ method: "GET", url, headers: result.entry.headers });
    } finally {
      db.off("query", listen);
    }
    if (captured === undefined) throw new Error(`${result.name}: the list query was not seen.`);
    const connection = await db.client.acquireConnection();
    try {
      const plan = await connection.query(
        `explain (analyze, buffers) ${captured.sql}`,
        db.client.prepBindings(captured.bindings)
      );
      console.log(`\nEXPLAIN (ANALYZE, BUFFERS): ${result.name}`);
      for (const row of plan.rows) console.log(`  ${row["QUERY PLAN"]}`);
    } finally {
      await db.client.releaseConnection(connection);
    }
  }
}

function printResults(title, results) {
  console.log(`\n${title}`);
  printTable(
    ["case", "p50", "p95", "rows"],
    results.map((r) => [r.name, r.p50.toFixed(1), r.p95.toFixed(1), r.rows])
  );
}

/** p95 of every case in every stage, stages as columns (1 is every index). */
function printComparison(stages) {
  console.log("\np95 in milliseconds by stage:");
  stages.forEach((stage, i) => console.log(`  ${String(i + 1)}: ${stage.label}`));
  const rows = [];
  for (const part of ["list", "ingestion"]) {
    const names = [...new Set(stages.flatMap((stage) => (stage[part] ?? []).map((r) => r.name)))];
    for (const name of names) {
      rows.push([
        name,
        ...stages.map((stage) => stage[part]?.find((r) => r.name === name)?.p95.toFixed(1) ?? "")
      ]);
    }
  }
  printTable(["case", ...stages.map((_, i) => String(i + 1))], rows);
}

function summarize(name, times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    name: `${name} (${String(sorted.length)})`,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    rows: ""
  };
}

/** Each index's own CREATE INDEX statement, to put it back between stages. */
async function indexDefinitions(db, names) {
  const definitions = new Map();
  for (const name of names) {
    const found = await db.raw(
      `select pg_get_indexdef(c.oid) as definition
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relname = ? and n.nspname = ? and c.relkind = 'i'`,
      [name, SCHEMA]
    );
    if (found.rows.length === 0) {
      throw new Error(`--drop-index: there is no index ${name} in ${SCHEMA}.`);
    }
    // Schema-qualified by PostgreSQL, and built only when missing. Not
    // concurrently: nothing else writes this schema.
    definitions.set(
      name,
      found.rows[0].definition.replace(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS ")
    );
  }
  return definitions;
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

/** Nearest-rank percentile of sorted values. */
function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** The first choice whose cumulative share passes `value`, from `[choice, share]` pairs. */
function pick(choices, value) {
  let total = 0;
  for (const [choice, share] of choices) {
    total += share;
    if (value < total) return choice;
  }
  return choices.at(-1)[0];
}

/** A small seeded generator, so the data shape repeats from run to run. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function stopAndCleanUp() {
  try {
    await admin.raw(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where application_name = ? and datname = current_database() and pid <> pg_backend_pid()`,
      [APPLICATION_NAME]
    );
    if (!args.keep) {
      await admin.raw("drop schema if exists ?? cascade", [SCHEMA]);
      console.error(`Dropped ${SCHEMA}.`);
    }
  } catch (error) {
    console.error(`Cleanup failed: ${error.message}. Drop ${SCHEMA} by hand.`);
  }
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
          "The measurement records every journey through the real ingestion code, which is real load.\n" +
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
      fail(`${path} is missing. Build first: pnpm --filter "@wayscribe/api..." build`);
    }
    throw error;
  }
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}
