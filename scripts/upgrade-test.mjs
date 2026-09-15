#!/usr/bin/env node
/* global AbortSignal */
// Upgrade test: an older build writes data, this build must read all of it.
//
// Flight Recorder runs on each team's own PostgreSQL, so an upgrade is a new
// image started against a database an older image wrote. This builds the API
// image at a baseline ref and at the working tree, records journeys through the
// baseline, swaps the image while keeping the database volume, and checks that
// every search and detail returns what it returned before, that old API keys
// and replay destinations still work, and that the format upgrade converts what
// it should. See docs/superpowers/specs/2026-09-15-release-hardening-design.md.
//
// Usage: node scripts/upgrade-test.mjs [--print-baseline]
//
// --print-baseline chooses the baseline, prints it, and exits without Docker.
//
// Environment (all optional):
//   UPGRADE_BASELINE_REF   ref to upgrade from; default the newest earlier
//                          vMAJOR.MINOR.PATCH tag, else DEFAULT_BASELINE below
//   UPGRADE_FETCH_TAGS=1   `git fetch --tags` before choosing (CI sets this)
//   UPGRADE_PROJECT        Compose project name (default fr-upgrade-<pid>)
//   UPGRADE_API_PORT       host port for the API (default a free port)
//   UPGRADE_BIND_ADDRESS   address the port binds to (default 127.0.0.1)
//   UPGRADE_API_HOST       host the script calls the API on (default 127.0.0.1)
//   UPGRADE_WORKDIR        where the baseline worktree goes (default a temp dir)
//   UPGRADE_KEEP=1         leave containers, volume, images and worktree behind

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { containedIn, releaseTags } from "./upgrade-test-lib.mjs";

/**
 * main immediately before the key rotation merge (d1bae55^1). It predates
 * migration 012 and the fr1 envelope, 013's recent-journeys indexes, deletion,
 * and error text masking, so one upgrade from it crosses every change v1 made to
 * stored data, and its CLI already has project:create and key:create.
 */
const DEFAULT_BASELINE = "f4a85f0ccb1f25b73be3401f0e9eb81377596df8";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSE_FILE = join(ROOT, "scripts", "upgrade-test.compose.yaml");
// Unique per run by default. Every run begins with `compose down -v` on its
// project, so two runs sharing a name would delete each other's database.
// Compose requires a lowercase project name.
const PROJECT = (process.env.UPGRADE_PROJECT || `fr-upgrade-${String(process.pid)}`).toLowerCase();
const PRINT_BASELINE = process.argv.includes("--print-baseline");
const API_PORT = process.env.UPGRADE_API_PORT || (PRINT_BASELINE ? "0" : String(await freePort()));
const API_HOST = process.env.UPGRADE_API_HOST || "127.0.0.1";
const API = `http://${API_HOST}:${API_PORT}`;
const KEEP = process.env.UPGRADE_KEEP === "1";

const BASELINE_IMAGE = `${PROJECT}-api:baseline`;
const CURRENT_IMAGE = `${PROJECT}-api:current`;

// Never the published defaults: a test that passes on those proves nothing about
// an installation that changed them.
const ENCRYPTION_KEY = randomBytes(32).toString("hex");
const ADMIN_TOKEN = randomBytes(32).toString("hex");
const MARKER = `upgrade-${randomBytes(6).toString("hex")}`;

class UpgradeTestError extends Error {}

const cleanups = [];

/**
 * A port nothing on this machine is listening on, from the kernel. Under
 * docker-in-docker the API publishes on the dind service rather than here, but
 * that daemon is fresh for each job, so its ports are free anyway.
 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) resolvePort(address.port);
        else reject(new Error("no port was assigned"));
      });
    });
  });
}

/** Bounds for child processes, so a hung build or container fails the run. */
const BUILD_TIMEOUT_MS = 12 * 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Processes

/** The child the run is waiting on, so a signal can stop it before cleaning up. */
let currentChild;

/**
 * A command the run waits on without blocking the event loop. Asynchronous so
 * that SIGTERM during a ten-minute image build is handled at once: a signal
 * handler cannot run while `spawnSync` holds the loop.
 */
function run(command, args, options = {}) {
  const limit = options.timeout ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    currentChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limit);
    child.on("error", (error) => {
      clearTimeout(timer);
      currentChild = undefined;
      reject(new UpgradeTestError(`${command} could not run: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      currentChild = undefined;
      if (timedOut) {
        reject(
          new UpgradeTestError(
            `${command} ${args.join(" ")} did not finish within ${String(limit / 60_000)} minutes`
          )
        );
        return;
      }
      const outcome = { status: code ?? 1, stdout, stderr };
      if (!options.allowFailure && outcome.status !== 0) {
        reject(
          new UpgradeTestError(
            `${command} ${args.join(" ")} exited ${String(outcome.status)}\n${tail(stdout + stderr, 60)}`
          )
        );
        return;
      }
      resolveRun(outcome);
    });
  });
}

/** For git, which is quick, and for cleanup, which must finish before exit. */
function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL"
  });
  if (result.error) {
    const minutes = String((options.timeout ?? COMMAND_TIMEOUT_MS) / 60_000);
    throw new UpgradeTestError(
      /ETIMEDOUT/.test(result.error.message)
        ? `${command} ${args.join(" ")} did not finish within ${minutes} minutes`
        : `${command} could not run: ${result.error.message}`
    );
  }
  const outcome = { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  if (!options.allowFailure && outcome.status !== 0) {
    throw new UpgradeTestError(
      `${command} ${args.join(" ")} exited ${String(outcome.status)}\n${tail(outcome.stdout + outcome.stderr, 60)}`
    );
  }
  return outcome;
}

function tail(text, lines) {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function composeEnv(image) {
  return {
    UPGRADE_API_IMAGE: image,
    UPGRADE_ENCRYPTION_KEY: ENCRYPTION_KEY,
    UPGRADE_ADMIN_TOKEN: ADMIN_TOKEN,
    UPGRADE_API_PORT: API_PORT
  };
}

function composeArgs(args) {
  return ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args];
}

function compose(image, args, options = {}) {
  return run("docker", composeArgs(args), { ...options, env: composeEnv(image) });
}

function composeSync(image, args, options = {}) {
  return runSync("docker", composeArgs(args), { ...options, env: composeEnv(image) });
}

/** The image's database CLI, in a one-off container beside the stack. */
function cli(image, args, options = {}) {
  return compose(
    image,
    ["run", "--rm", "-T", "--entrypoint", "node", "api", "packages/database/dist/cli.js", ...args],
    options
  );
}

async function sql(image, statement) {
  const result = await compose(image, [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "flight",
    "-d",
    "flight",
    "-tAc",
    statement
  ]);
  return result.stdout.trim();
}

function git(args, options = {}) {
  return runSync("git", args, options);
}

// ---------------------------------------------------------------------------
// Reporting

function step(title) {
  console.log(`\n==> ${title}`);
}

function ok(message) {
  console.log(`  ok    ${message}`);
}

function check(condition, message, detail) {
  if (!condition) {
    throw new UpgradeTestError(
      `${message}${detail === undefined ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`
    );
  }
  ok(message);
}

// ---------------------------------------------------------------------------
// HTTP

async function request(method, path, { token = ADMIN_TOKEN, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

async function waitForReady(image, label) {
  const deadline = Date.now() + 180_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API}/ready`, { signal: AbortSignal.timeout(5_000) });
      if (response.status === 200) {
        ok(`${label} API ready at ${API}`);
        return;
      }
      last = `${String(response.status)} ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const state = (
      await compose(image, ["ps", "-a", "--format", "{{.State}}", "api"], { allowFailure: true })
    ).stdout.trim();
    if (state === "exited" || state === "dead") break;
    await sleep(1_000);
  }
  throw new UpgradeTestError(
    `${label} API did not become ready (last: ${last})\n${composeSync(image, ["logs", "--tail", "80", "api"], { allowFailure: true }).stdout}`
  );
}

// ---------------------------------------------------------------------------
// Comparison

/**
 * Recorded reads whose header maps are compared by name, with values allowed to
 * have become `[REDACTED]` (see `containedIn` in upgrade-test-lib.mjs).
 *
 * Only the replay run's `requestHeaders`. The replay-header-storage branch stops
 * storing destination header values in replay runs, and its migration 015
 * rewrites every stored run header to `[REDACTED]`, because those values were
 * decrypted copies of credentials that are encrypted at rest everywhere else.
 * Which headers a replay sent is the record; their values were never meant to be.
 */
const HEADER_MAPS = new Set(["baseline replay run.requestHeaders"]);

async function compareRecorded(recorded, label, skip = new Set()) {
  const mismatches = [];
  let compared = 0;
  for (const [name, { path, data }] of recorded) {
    if (skip.has(name)) continue;
    const response = await request("GET", path);
    if (response.status !== 200) {
      mismatches.push(
        `${name} (${path}): status ${String(response.status)} ${JSON.stringify(response.json)}`
      );
      continue;
    }
    containedIn(data, response.json.data, name, mismatches, HEADER_MAPS);
    compared += 1;
  }
  check(
    mismatches.length === 0,
    `${label}: ${String(compared)} recorded reads return the data the baseline returned`,
    mismatches.join("\n")
  );
}

// ---------------------------------------------------------------------------
// Data

function timestamp(offsetSeconds) {
  return new Date(STARTED_AT.getTime() + offsetSeconds * 1000).toISOString();
}

const STARTED_AT = new Date(Date.now() - 120_000);

const J1 = {
  journeyId: "jrn_upgrade_customer_failed",
  entity: { type: "customer", id: "cust-upgrade-18492" },
  aliases: { salesforceAccountId: "0018Z00002UPGRD1", hubspotContactId: "hs-upgrade-5501" },
  traceId: "trace-upgrade-4bf92f3577b34da6",
  correlationId: "corr-upgrade-77f1"
};
const J2 = {
  journeyId: "jrn_upgrade_order_completed",
  entity: { type: "order", id: "order-upgrade-7731" },
  aliases: { externalOrderRef: "EXT-UPGRADE-7731" }
};
const J3 = {
  journeyId: "jrn_upgrade_customer_erased",
  entity: { type: "customer", id: "cust-upgrade-erase-9001" }
};
const ERROR = {
  type: "ValidationError",
  message: "phone is required for delivery to the CRM",
  code: "E_PHONE_REQUIRED"
};
const TRANSFORM_INPUT = { id: "0018Z00002UPGRD1", name: "Ada Lovelace", phone: "+1 919 555 1234" };
const TRANSFORM_OUTPUT = { customerId: "cust-upgrade-18492", name: "Ada Lovelace", phone: null };

function envelope(event) {
  return { protocolVersion: "0.1", event: { environment: "production", ...event } };
}

function baselineEvents() {
  return {
    [J1.journeyId]: [
      {
        id: "evt_upgrade_j1_received",
        journeyId: J1.journeyId,
        service: "salesforce-webhook-api",
        entity: J1.entity,
        operation: "received",
        name: "receive-salesforce-webhook",
        timestamp: timestamp(0),
        aliases: { salesforceAccountId: J1.aliases.salesforceAccountId },
        traceId: J1.traceId,
        correlationId: J1.correlationId,
        input: TRANSFORM_INPUT
      },
      {
        id: "evt_upgrade_j1_transformed",
        journeyId: J1.journeyId,
        parentEventId: "evt_upgrade_j1_received",
        service: "customer-sync-worker",
        entity: J1.entity,
        operation: "transformed",
        name: "transform-salesforce-account",
        timestamp: timestamp(1),
        durationMs: 12,
        aliases: { hubspotContactId: J1.aliases.hubspotContactId },
        traceId: J1.traceId,
        input: TRANSFORM_INPUT,
        output: TRANSFORM_OUTPUT
      },
      {
        id: "evt_upgrade_j1_failed",
        journeyId: J1.journeyId,
        parentEventId: "evt_upgrade_j1_transformed",
        service: "customer-sync-worker",
        entity: J1.entity,
        operation: "failed",
        name: "deliver-customer-to-crm",
        timestamp: timestamp(2),
        traceId: J1.traceId,
        input: TRANSFORM_OUTPUT,
        error: ERROR
      }
    ],
    [J2.journeyId]: [
      {
        id: "evt_upgrade_j2_received",
        journeyId: J2.journeyId,
        service: "order-api",
        entity: J2.entity,
        operation: "received",
        name: "receive-order",
        timestamp: timestamp(3),
        aliases: J2.aliases,
        input: { orderRef: "EXT-UPGRADE-7731", total: 42.5 }
      },
      {
        id: "evt_upgrade_j2_completed",
        journeyId: J2.journeyId,
        service: "order-api",
        entity: J2.entity,
        operation: "completed",
        name: "complete-order",
        timestamp: timestamp(4)
      }
    ],
    [J3.journeyId]: [
      {
        id: "evt_upgrade_j3_received",
        journeyId: J3.journeyId,
        service: "salesforce-webhook-api",
        entity: J3.entity,
        operation: "received",
        name: "receive-salesforce-webhook",
        timestamp: timestamp(5),
        input: { id: "cust-upgrade-erase-9001" }
      }
    ]
  };
}

async function ingest(apiKey, events, label) {
  const response = await request("POST", "/v1/events/batch", {
    token: apiKey,
    body: { events: events.map(envelope) }
  });
  const results = response.json?.data?.results ?? [];
  const accepted = results.filter((result) => result.status === "accepted").length;
  check(
    response.status < 300 && accepted === events.length,
    `${label}: ${String(accepted)}/${String(events.length)} events accepted`,
    response.json
  );
}

function apiKeyFrom(output) {
  const match = /fr_[A-Za-z0-9_-]{16,}/.exec(output);
  if (match === null) throw new UpgradeTestError(`key:create printed no key:\n${output}`);
  return match[0];
}

/** Table rows of rotate:status: name followed by six counts. */
function rotationTable(output) {
  const tables = {};
  for (const line of output.split("\n")) {
    const match =
      /^(journeys|entity_aliases|replay_destinations)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(
        line
      );
    if (match === null) continue;
    const [, table, current, previous, legacy, unknownKey, malformed, noValue] = match;
    tables[table] = {
      current: Number(current),
      previous: Number(previous),
      legacy: Number(legacy),
      unknownKey: Number(unknownKey),
      malformed: Number(malformed),
      noValue: Number(noValue)
    };
  }
  return tables;
}

async function replayThroughEcho(destinationId, label) {
  const response = await request("POST", "/v1/replays", {
    body: {
      eventId: "evt_upgrade_j1_transformed",
      destinationId,
      method: "POST",
      path: "/replay/customer"
    }
  });
  const data = response.json?.data;
  check(
    response.status === 200 && data?.status === "completed",
    `${label}: replay completed`,
    response.json
  );
  check(
    data.responsePayload?.headers?.["x-upgrade-marker"] === MARKER,
    `${label}: the destination's encrypted header reached the destination`,
    data.responsePayload
  );
  return data;
}

// ---------------------------------------------------------------------------
// Baseline choice

function chooseBaseline() {
  if (process.env.UPGRADE_FETCH_TAGS === "1") {
    git(["fetch", "--tags", "--force", "origin"]);
  }
  const explicit = process.env.UPGRADE_BASELINE_REF;
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  let ref;
  let reason;
  if (explicit) {
    ref = explicit;
    reason = "UPGRADE_BASELINE_REF";
  } else {
    // Releases only, newest first: never a pre-release or a phase tag.
    const tags = releaseTags(git(["tag", "--list", "v*"]).stdout.split("\n").filter(Boolean));
    for (const tag of tags) {
      const commit = git(["rev-parse", `${tag}^{commit}`]).stdout.trim();
      if (commit === head) continue;
      if (git(["merge-base", "--is-ancestor", tag, "HEAD"], { allowFailure: true }).status !== 0)
        continue;
      ref = tag;
      reason = "newest earlier release tag";
      break;
    }
    if (ref === undefined) {
      ref = DEFAULT_BASELINE;
      reason = "no earlier release tag; default baseline, main before the key rotation merge";
    }
  }
  const exists = git(["cat-file", "-e", `${ref}^{commit}`], { allowFailure: true });
  if (exists.status !== 0) {
    throw new UpgradeTestError(
      `Baseline ${ref} is not in this clone. A shallow clone lacks it: fetch full history (GIT_DEPTH: 0 in CI).`
    );
  }
  const commit = git(["rev-parse", `${ref}^{commit}`]).stdout.trim();
  return { ref, commit, reason, head };
}

// ---------------------------------------------------------------------------
// The test

async function main() {
  if (PRINT_BASELINE) {
    const choice = chooseBaseline();
    console.log(`${choice.ref} ${choice.commit} (${choice.reason})`);
    return;
  }

  step("Choosing the baseline");
  const baseline = chooseBaseline();
  const dirty = git(["status", "--porcelain"]).stdout.trim() !== "";
  console.log(`  baseline  ${baseline.ref} (${baseline.commit.slice(0, 10)}): ${baseline.reason}`);
  console.log(
    `  current   working tree at ${baseline.head.slice(0, 10)}${dirty ? " (with uncommitted changes)" : ""}`
  );
  console.log(`  project   ${PROJECT}, API on ${API}`);

  const legacyBaseline =
    git(["cat-file", "-e", `${baseline.commit}:packages/database/migrations/012_key_rotation.js`], {
      allowFailure: true
    }).status !== 0;
  console.log(
    legacyBaseline
      ? "  expect    legacy encrypted values and unrecorded key ids (baseline predates migration 012)"
      : "  expect    no legacy values (baseline already writes the fr1 format)"
  );

  const workdir = process.env.UPGRADE_WORKDIR
    ? resolve(process.env.UPGRADE_WORKDIR)
    : mkdtempSync(join(tmpdir(), "fr-upgrade-"));
  const worktree = join(workdir, `baseline-${baseline.commit.slice(0, 10)}`);

  // Registered before anything is created, and run in reverse, so an early
  // failure still removes whatever did get created.
  cleanups.push(() => {
    if (existsSync(worktree))
      git(["worktree", "remove", "--force", worktree], { allowFailure: true });
    git(["worktree", "prune"], { allowFailure: true });
    if (!process.env.UPGRADE_WORKDIR) rmSync(workdir, { recursive: true, force: true });
  });
  cleanups.push(() => {
    runSync("docker", ["image", "rm", "-f", BASELINE_IMAGE, CURRENT_IMAGE], { allowFailure: true });
  });
  cleanups.push(() => {
    composeSync(CURRENT_IMAGE, ["down", "-v", "--remove-orphans"], { allowFailure: true });
  });

  step("Building the baseline API image");
  git(["worktree", "add", "--detach", worktree, baseline.commit]);
  ok(`worktree at ${worktree}`);
  await run("docker", ["build", "-q", "-f", "apps/api/Dockerfile", "-t", BASELINE_IMAGE, "."], {
    cwd: worktree,
    timeout: BUILD_TIMEOUT_MS
  });
  ok(`built ${BASELINE_IMAGE}`);

  step("Baseline: migrate, provision, start");
  await compose(BASELINE_IMAGE, ["down", "-v", "--remove-orphans"], { allowFailure: true });
  const baselineMigrate = await cli(BASELINE_IMAGE, ["migrate"]);
  console.log(baselineMigrate.stdout.trimEnd().replace(/^/gm, "        "));
  await cli(BASELINE_IMAGE, ["project:create", "upgrade", "Upgrade Test"]);
  ok("project upgrade created with the baseline CLI");
  const oldKey = apiKeyFrom(
    (await cli(BASELINE_IMAGE, ["key:create", "upgrade", "production", "baseline-worker"])).stdout
  );
  ok(`API key issued with the baseline CLI (${oldKey.slice(0, 12)}...)`);
  await compose(BASELINE_IMAGE, ["up", "-d", "api", "replay-echo"]);
  await waitForReady(BASELINE_IMAGE, "baseline");

  step("Baseline: ingest and record");
  const events = baselineEvents();
  for (const [journeyId, journeyEvents] of Object.entries(events)) {
    await ingest(oldKey, journeyEvents, `baseline ${journeyId}`);
  }

  const destination = await request("POST", "/v1/replay-destinations", {
    body: {
      name: "Upgrade echo",
      baseUrl: "http://replay-echo:3999",
      environmentType: "development",
      headers: { "x-upgrade-marker": MARKER }
    }
  });
  check(
    destination.status === 201,
    "baseline: replay destination with headers created",
    destination.json
  );
  const destinationId = destination.json.data.id;
  const baselineReplay = await replayThroughEcho(destinationId, "baseline");

  const reads = [
    ["search J1 entity id", `/v1/search?q=${encodeURIComponent(J1.entity.id)}`],
    [
      "search J1 salesforce alias",
      `/v1/search?q=${encodeURIComponent(J1.aliases.salesforceAccountId)}`
    ],
    ["search J1 hubspot alias", `/v1/search?q=${encodeURIComponent(J1.aliases.hubspotContactId)}`],
    ["search J1 journey id", `/v1/search?q=${encodeURIComponent(J1.journeyId)}`],
    ["search J1 trace id", `/v1/search?q=${encodeURIComponent(J1.traceId)}`],
    ["search J1 correlation id", `/v1/search?q=${encodeURIComponent(J1.correlationId)}`],
    ["search J2 entity id", `/v1/search?q=${encodeURIComponent(J2.entity.id)}`],
    ["search J2 alias", `/v1/search?q=${encodeURIComponent(J2.aliases.externalOrderRef)}`],
    ["search J3 entity id", `/v1/search?q=${encodeURIComponent(J3.entity.id)}`],
    ["replay destinations", "/v1/replay-destinations"],
    ["baseline replay run", `/v1/replays/${baselineReplay.id}`]
  ];
  for (const [journeyId, journeyEvents] of Object.entries(events)) {
    reads.push([`journey ${journeyId}`, `/v1/journeys/${journeyId}`]);
    reads.push([`events of ${journeyId}`, `/v1/journeys/${journeyId}/events`]);
    for (const event of journeyEvents) reads.push([`event ${event.id}`, `/v1/events/${event.id}`]);
  }

  const recorded = new Map();
  for (const [name, path] of reads) {
    const response = await request("GET", path);
    check(response.status === 200, `baseline: ${name}`, response.json);
    recorded.set(name, { path, data: response.json.data });
  }

  // The baseline must itself be right, or a mismatch later would blame the
  // upgrade for a baseline that never worked.
  const j1Search = recorded.get("search J1 entity id").data.items;
  check(
    j1Search.length === 1 &&
      j1Search[0].entity.id === J1.entity.id &&
      j1Search[0].status === "failed",
    "baseline: J1 found by entity id, decrypted, status failed",
    j1Search
  );
  check(
    recorded.get("search J1 hubspot alias").data.items[0]?.journeyId === J1.journeyId,
    "baseline: J1 found by alias",
    recorded.get("search J1 hubspot alias").data
  );
  const j1Detail = recorded.get(`journey ${J1.journeyId}`).data;
  check(
    j1Detail.aliases.length === 2 &&
      j1Detail.aliases.every((alias) => typeof alias.displayValue === "string"),
    "baseline: J1 detail has both aliases with display values",
    j1Detail.aliases
  );
  const transformed = recorded.get("event evt_upgrade_j1_transformed").data;
  check(
    transformed.payloadDiff !== null && JSON.stringify(transformed.payloadDiff).includes("phone"),
    "baseline: transformed event carries a diff that names phone",
    transformed.payloadDiff
  );
  const failed = recorded.get("event evt_upgrade_j1_failed").data;
  check(
    failed.error?.message === ERROR.message,
    "baseline: failed event carries its error",
    failed.error
  );
  check(
    recorded.get(`journey ${J2.journeyId}`).data.status === "completed",
    "baseline: J2 completed"
  );

  step("Stopping the baseline API (the database volume stays)");
  await compose(BASELINE_IMAGE, ["rm", "--stop", "--force", "api"]);
  ok("baseline API removed");

  step("Building the current API image");
  await run("docker", ["build", "-q", "-f", "apps/api/Dockerfile", "-t", CURRENT_IMAGE, "."], {
    timeout: BUILD_TIMEOUT_MS
  });
  ok(`built ${CURRENT_IMAGE}`);

  step("Current: migrate");
  const migrate = await cli(CURRENT_IMAGE, ["migrate"]);
  console.log(migrate.stdout.trimEnd().replace(/^/gm, "        "));
  if (legacyBaseline) {
    check(
      migrate.stdout.includes("012_key_rotation.js") &&
        migrate.stdout.includes("013_journeys_status_recent_index.js"),
      "current migrate applied 012 and 013 to the baseline's database"
    );
  }

  step("Current: rotate:status before any key is presented");
  const statusBefore = await cli(CURRENT_IMAGE, ["rotate:status"], { allowFailure: true });
  console.log(statusBefore.stdout.trimEnd().replace(/^/gm, "        "));
  const before = rotationTable(statusBefore.stdout);
  check(
    ["journeys", "entity_aliases", "replay_destinations"].every((table) => table in before),
    "rotate:status reports all three encrypted tables",
    statusBefore.stdout + statusBefore.stderr
  );
  if (legacyBaseline) {
    check(
      before.journeys.legacy === 3 &&
        before.entity_aliases.legacy === 3 &&
        before.replay_destinations.legacy === 1,
      "rotate:status counts the baseline's rows as legacy (3 journeys, 3 aliases, 1 destination)",
      before
    );
    check(
      /key id not recorded yet; recorded on next use: 1/.test(statusBefore.stdout),
      "rotate:status lists the baseline API key as having no recorded key id"
    );
  } else {
    check(
      Object.values(before).every((table) => table.legacy === 0),
      "rotate:status reports no legacy rows",
      before
    );
  }

  step("Current: start the API and read everything back");
  await compose(CURRENT_IMAGE, ["up", "-d", "api", "replay-echo"]);
  await waitForReady(CURRENT_IMAGE, "current");
  await compareRecorded(recorded, "after upgrade");

  const nullKeyIdsBefore = Number(
    await sql(CURRENT_IMAGE, "select count(*) from api_keys where key_hash_key_id is null")
  );
  await ingest(
    oldKey,
    [
      {
        id: "evt_upgrade_j4_received",
        journeyId: "jrn_upgrade_after_upgrade",
        service: "salesforce-webhook-api",
        entity: { type: "customer", id: "cust-upgrade-after-1" },
        operation: "received",
        name: "receive-salesforce-webhook",
        timestamp: new Date().toISOString(),
        input: { id: "cust-upgrade-after-1" }
      }
    ],
    "current API, baseline key"
  );
  const nullKeyIdsAfter = Number(
    await sql(CURRENT_IMAGE, "select count(*) from api_keys where key_hash_key_id is null")
  );
  check(
    nullKeyIdsAfter === 0 && (!legacyBaseline || nullKeyIdsBefore === 1),
    `the baseline key's verifier recorded its key id on use (unrecorded: ${String(nullKeyIdsBefore)} before, ${String(nullKeyIdsAfter)} after)`
  );
  const j4 = await request("GET", `/v1/search?q=${encodeURIComponent("cust-upgrade-after-1")}`);
  check(
    j4.status === 200 && j4.json.data.items[0]?.entity.id === "cust-upgrade-after-1",
    "the event ingested after the upgrade is searchable",
    j4.json
  );

  const recent = await request(
    "GET",
    `/v1/journeys?since=${encodeURIComponent(new Date(STARTED_AT.getTime() - 60_000).toISOString())}&status=failed`
  );
  check(
    recent.status === 200 &&
      recent.json.data.items.some(
        (item) => item.journeyId === J1.journeyId && item.entity.id === J1.entity.id
      ),
    "recent failed journeys (GET /v1/journeys) lists the baseline's failed journey",
    recent.json
  );

  await replayThroughEcho(destinationId, "current, legacy destination headers");

  const dryRun = await request("POST", "/v1/erasures", {
    body: { value: J3.entity.id, dryRun: true }
  });
  check(
    dryRun.status === 200 &&
      dryRun.json.data.total === 1 &&
      dryRun.json.data.journeys[0]?.id === J3.journeyId,
    "erasure dry run selects exactly the baseline journey J3",
    dryRun.json
  );
  const erasure = await request("POST", "/v1/erasures", { body: { value: J3.entity.id } });
  check(
    erasure.status === 200 &&
      erasure.json.data.deletedJourneys === 1 &&
      erasure.json.data.complete === true,
    "erasure deletes the baseline journey J3",
    erasure.json
  );
  const erasedSearch = await request("GET", `/v1/search?q=${encodeURIComponent(J3.entity.id)}`);
  const erasedDetail = await request("GET", `/v1/journeys/${J3.journeyId}`);
  check(
    erasedSearch.json?.data?.items?.length === 0 && erasedDetail.status === 404,
    "J3 is gone from search and detail"
  );
  const erased = new Set([
    "search J3 entity id",
    `journey ${J3.journeyId}`,
    `events of ${J3.journeyId}`,
    ...events[J3.journeyId].map((event) => `event ${event.id}`)
  ]);

  step("Current: rotate:reencrypt in upgrade mode");
  const reencrypt = await cli(CURRENT_IMAGE, ["rotate:reencrypt"], { allowFailure: true });
  console.log(reencrypt.stdout.trimEnd().replace(/^/gm, "        "));
  check(reencrypt.status === 0, "rotate:reencrypt exited 0", reencrypt.stderr);
  check(
    reencrypt.stdout.startsWith("Upgrading legacy values under key"),
    "rotate:reencrypt ran in upgrade mode"
  );

  const statusAfter = await cli(CURRENT_IMAGE, ["rotate:status"], { allowFailure: true });
  console.log(statusAfter.stdout.trimEnd().replace(/^/gm, "        "));
  const after = rotationTable(statusAfter.stdout);
  check(
    statusAfter.status === 0 &&
      Object.values(after).every(
        (table) => table.legacy === 0 && table.unknownKey === 0 && table.malformed === 0
      ),
    "rotate:status exits 0 with no legacy, unknown-key or malformed rows",
    after
  );
  const notEnvelope = await sql(
    CURRENT_IMAGE,
    "select (select count(*) from journeys where encrypted_primary_entity_id not like 'fr1.%') + " +
      "(select count(*) from entity_aliases where encrypted_display_value not like 'fr1.%') + " +
      "(select count(*) from replay_destinations where encrypted_headers is not null and encrypted_headers not like 'fr1.%')"
  );
  check(
    notEnvelope === "0",
    `every stored encrypted value is in the fr1 format (${notEnvelope} not)`
  );

  step("Current: read everything back again, now from fr1 values");
  await compareRecorded(recorded, "after re-encryption", erased);
  await replayThroughEcho(destinationId, "current, re-encrypted destination headers");

  step("Current: doctor");
  const doctor = await cli(CURRENT_IMAGE, ["doctor"], { allowFailure: true });
  if (/Unknown command/.test(doctor.stderr)) {
    console.log("  skip  doctor is not in this build's CLI");
  } else {
    console.log((doctor.stdout + doctor.stderr).trimEnd().replace(/^/gm, "        "));
    check(doctor.status === 0, "doctor passes against the upgraded database");
  }

  step("Current: a key issued by this build ingests");
  const newKey = apiKeyFrom(
    (await cli(CURRENT_IMAGE, ["key:create", "upgrade", "production", "current-worker"])).stdout
  );
  await ingest(
    newKey,
    [
      {
        id: "evt_upgrade_j5_received",
        journeyId: "jrn_upgrade_new_key",
        service: "order-api",
        entity: { type: "order", id: "order-upgrade-new-key" },
        operation: "received",
        name: "receive-order",
        timestamp: new Date().toISOString()
      }
    ],
    "current API, current key"
  );

  console.log(`\nUpgrade from ${baseline.ref} to the working tree preserved every recorded read.`);
}

function cleanup() {
  if (KEEP) {
    console.log(
      `\nUPGRADE_KEEP=1: leaving project ${PROJECT}, its volume, images and worktree in place.`
    );
    return;
  }
  while (cleanups.length > 0) {
    const task = cleanups.pop();
    try {
      task();
    } catch (error) {
      console.error(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// A cancelled CI job sends SIGTERM, a closed terminal SIGHUP, Ctrl-C SIGINT.
// Each stops the command in progress, removes what the run created, and exits
// with the conventional 128 + signal number.
let stopping = false;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129]
]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`\nReceived ${signal}: stopping and cleaning up.`);
    currentChild?.kill("SIGKILL");
    cleanup();
    process.exit(code);
  });
}

try {
  await main();
  cleanup();
} catch (error) {
  console.error(`\nUPGRADE TEST FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (!(error instanceof UpgradeTestError) && error instanceof Error) console.error(error.stack);
  // Request lines drown out what explains a failure: boot errors and warnings.
  // Best effort: a failure before Docker was reached has no log to show.
  try {
    const logs = composeSync(CURRENT_IMAGE, ["logs", "--no-color", "api"], { allowFailure: true })
      .stdout.split("\n")
      .filter(
        (line) => line.trim() !== "" && !/"msg":"(incoming request|request completed)"/.test(line)
      );
    if (logs.length > 0) {
      console.error(`\nAPI log, requests omitted:\n${logs.slice(-40).join("\n")}`);
    }
  } catch {
    // Nothing to add.
  }
  cleanup();
  process.exitCode = 1;
}
