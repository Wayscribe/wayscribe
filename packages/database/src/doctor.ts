import { findInsecureDefaults, loadStatementTimeoutMs } from "@flight-recorder/config";
import {
  API_KEY_PREFIX_LENGTH,
  verifyApiKeyWithKeyring,
  type Keyring
} from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import { keyringFromEnvironment } from "./keyring-env.js";
import { pendingMigrationCount } from "./migration-status.js";
import { findUnreadableData } from "./repositories/rotation.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface CheckResult {
  status: CheckStatus;
  check: string;
  /** What was found. Never a secret: see `runDoctor`. */
  detail: string;
  /** For anything but a pass, what to do about it, in one sentence. */
  fix?: string;
}

export interface DoctorOptions {
  db: Knex;
  /** The environment doctor reads, which should be the API's: its keys, token, and timeout. */
  env: Record<string, string | undefined>;
  /** Checks `GET /ready` there when given. */
  apiUrl?: string;
  /** Verifies this key against the database when given. Only its prefix is ever printed. */
  apiKey?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** How long `GET /ready` may take. */
  apiTimeoutMs?: number;
}

/** PostgreSQL 15 is the oldest release Flight Recorder's SQL is written for. */
const MINIMUM_POSTGRES = 150_000;
/** The version CI, Compose, and the Helm chart run. */
const TESTED_POSTGRES = 170_000;

/**
 * Shorter values are not scrubbed from output, because a short password such
 * as the bundled `flight` also names the database and would blank ordinary
 * words. They cannot reach the output anyway: no message doctor prints is
 * built from them, and PostgreSQL's own errors never repeat a password.
 */
const MINIMUM_SCRUBBED_LENGTH = 8;

/**
 * Check an installation end to end and say what to fix.
 *
 * Read-only apart from what `/ready` also does (knex creates its migrations
 * table if it is missing). Every check that depends on another is reported as
 * SKIP when that one failed, rather than failing again with a less useful
 * message.
 *
 * Nothing printed contains the database password, the admin token, either
 * encryption key, or the API key beyond its prefix. Messages are built from
 * counts, names, and codes, and as a second line of defence every configured
 * secret is scrubbed from every line before it is returned.
 */
export async function runDoctor(options: DoctorOptions): Promise<CheckResult[]> {
  const { db, env } = options;
  const results: CheckResult[] = [];

  const database = await checkDatabase(db);
  results.push(database.result);
  if (database.version !== null) results.push(versionResult(database.version));
  else results.push(skip("PostgreSQL version", "the database is unreachable"));

  let migrated = false;
  if (database.version === null) {
    results.push(skip("Migrations", "the database is unreachable"));
  } else {
    const pending = await pendingMigrationCount(db);
    migrated = pending === 0;
    results.push(
      migrated
        ? pass("Migrations", "Every migration is applied.")
        : fail(
            "Migrations",
            `${String(pending)} migration${pending === 1 ? " is" : "s are"} pending, so the API reports /ready 503 migrations_pending.`,
            "Run migrate against this database (docs/OPERATIONS.md §4)."
          )
    );
  }

  results.push(...defaultSecretResults(env));

  let keyring: Keyring | null = null;
  let keyringProblem = "";
  try {
    keyring = keyringFromEnvironment(env);
  } catch (error) {
    keyringProblem = error instanceof Error ? error.message.replace(/\s*\n\s*/g, " ") : "invalid";
  }

  const dataReason = !migrated
    ? database.version === null
      ? "the database is unreachable"
      : "migrations are pending"
    : null;

  if (keyring === null) {
    results.push(
      fail(
        "Keys readable",
        `ENCRYPTION_KEY cannot be used: ${keyringProblem}`,
        "Set ENCRYPTION_KEY (and ENCRYPTION_KEY_PREVIOUS only during a rotation) as the API has them."
      )
    );
  } else if (dataReason !== null) {
    results.push(skip("Keys readable", dataReason));
  } else {
    results.push(await keysReadableResult(db, keyring));
  }

  if (dataReason !== null) results.push(skip("Projects and keys", dataReason));
  else results.push(await projectsResult(db));

  if (options.apiKey !== undefined) {
    if (keyring === null) results.push(skip("API key", "ENCRYPTION_KEY cannot be used"));
    else if (dataReason !== null) results.push(skip("API key", dataReason));
    else results.push(await apiKeyResult(db, keyring, options.apiKey));
  }

  if (options.apiUrl !== undefined) {
    results.push(
      await apiReachableResult(
        options.apiUrl,
        options.fetch ?? fetch,
        options.apiTimeoutMs ?? 5_000
      )
    );
  }

  results.push(statementTimeoutResult(env));

  return scrub(results, secretsIn(env, options.apiKey));
}

/** Exit 0 when nothing failed. Warnings and skips do not fail. */
export function doctorExitCode(results: readonly CheckResult[]): 0 | 1 {
  return results.some((result) => result.status === "FAIL") ? 1 : 0;
}

const CHECK_WIDTH = 23;

export function formatDoctor(results: readonly CheckResult[]): string[] {
  const lines: string[] = [];
  const indent = " ".repeat(6 + CHECK_WIDTH + 1);
  for (const result of results) {
    lines.push(`${result.status.padEnd(4)}  ${result.check.padEnd(CHECK_WIDTH)} ${result.detail}`);
    if (result.fix !== undefined) lines.push(`${indent}Fix: ${result.fix}`);
  }

  const count = (status: CheckStatus): number =>
    results.filter((result) => result.status === status).length;
  const failed = count("FAIL");
  const warned = count("WARN");
  const skipped = count("SKIP");
  lines.push("");
  lines.push(
    [
      `${String(failed)} failed`,
      `${String(warned)} warning${warned === 1 ? "" : "s"}`,
      `${String(count("PASS"))} passed`,
      ...(skipped === 0 ? [] : [`${String(skipped)} skipped`])
    ].join(", ") + "."
  );
  return lines;
}

export type DoctorArgs =
  { ok: true; apiUrl?: string; apiKey?: string } | { ok: false; message: string };

export const DOCTOR_USAGE = "Usage: doctor [--api-url <url>] [--api-key <key>]";

/** `--api-url <url>` and `--api-key <key>`, each at most once, as `--flag value` or `--flag=value`. */
export function parseDoctorArgs(args: readonly string[]): DoctorArgs {
  const values: { "--api-url"?: string; "--api-key"?: string } = {};

  const remaining = [...args];
  while (remaining.length > 0) {
    const arg = remaining.shift() ?? "";
    const [flag, inline] = arg.startsWith("--") ? splitOnce(arg, "=") : [arg, undefined];
    if (flag !== "--api-url" && flag !== "--api-key") {
      // Never echo the argument: it may be a key pasted without its flag.
      return { ok: false, message: `Unknown argument.\n${DOCTOR_USAGE}` };
    }
    if (values[flag] !== undefined) {
      return { ok: false, message: `${flag} was given twice.\n${DOCTOR_USAGE}` };
    }
    const value = inline ?? remaining.shift();
    if (value === undefined || value === "") {
      return { ok: false, message: `${flag} needs a value.\n${DOCTOR_USAGE}` };
    }
    values[flag] = value;
  }

  const apiUrl = values["--api-url"];
  if (apiUrl !== undefined && !isHttpUrl(apiUrl)) {
    return { ok: false, message: `--api-url must be an http:// or https:// URL.\n${DOCTOR_USAGE}` };
  }
  return {
    ok: true,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(values["--api-key"] === undefined ? {} : { apiKey: values["--api-key"] })
  };
}

async function checkDatabase(
  db: Knex
): Promise<{ result: CheckResult; version: { num: number; text: string } | null }> {
  try {
    const found: unknown = await db.raw(
      "select current_setting('server_version_num')::int as num, current_setting('server_version') as text, current_database() as name"
    );
    const row = (found as { rows: { num: number; text: string; name: string }[] }).rows[0];
    if (row === undefined) throw new Error("The version query returned no row.");
    return {
      result: pass("Database reachable", `Connected to database "${row.name}".`),
      version: { num: row.num, text: row.text }
    };
  } catch (error) {
    return {
      result: fail(
        "Database reachable",
        describeConnectionError(error),
        "Check DATABASE_URL, and that PostgreSQL is running and reachable from where doctor runs."
      ),
      version: null
    };
  }
}

/**
 * A connection failure in words, built from the error's code and the fields
 * PostgreSQL returns. Never the URL, which holds the password.
 */
function describeConnectionError(error: unknown): string {
  const { code, message } = error as { code?: unknown; message?: unknown };
  switch (code) {
    case "ECONNREFUSED":
      return "The connection was refused (ECONNREFUSED): nothing is listening at DATABASE_URL's host and port.";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `DATABASE_URL's host name does not resolve (${code}).`;
    case "ETIMEDOUT":
      return "The connection timed out (ETIMEDOUT).";
    case "28P01":
      return "PostgreSQL refused the password for DATABASE_URL's user (28P01).";
    case "28000":
      return "PostgreSQL refused DATABASE_URL's user (28000); check pg_hba.conf and the role.";
    case "3D000":
      return "DATABASE_URL names a database that does not exist (3D000).";
    default:
      if (typeof message === "string" && message.includes("Timeout acquiring a connection")) {
        return "No connection was established within 10 seconds.";
      }
      return `The connection failed${typeof code === "string" ? ` (${code})` : ""}: ${typeof message === "string" ? message : String(error)}`;
  }
}

export function versionResult(version: { num: number; text: string }): CheckResult {
  if (version.num < MINIMUM_POSTGRES) {
    return fail(
      "PostgreSQL version",
      `PostgreSQL ${version.text} is older than 15, the oldest supported.`,
      "Upgrade PostgreSQL to 17, or at least 15."
    );
  }
  if (version.num < TESTED_POSTGRES) {
    return warn(
      "PostgreSQL version",
      `PostgreSQL ${version.text} is supported, but CI tests against 17.`,
      "Upgrade to PostgreSQL 17 when you can; nothing is known to break on 15 or 16."
    );
  }
  return pass("PostgreSQL version", `PostgreSQL ${version.text}.`);
}

function defaultSecretResults(env: Record<string, string | undefined>): CheckResult[] {
  const results: CheckResult[] = [];
  const findings = findInsecureDefaults(env);

  for (const finding of findings) {
    const check = finding.variable;
    if (finding.variable === "ENCRYPTION_KEY") {
      results.push(
        fail(
          check,
          "ENCRYPTION_KEY is a published development default, so anyone can decrypt what is stored under it.",
          "On an installation holding nothing yet, set your own (openssl rand -hex 32) and recreate the API; with data stored, rotate to it instead (docs/OPERATIONS.md §6)."
        )
      );
    } else if (finding.variable === "ADMIN_TOKEN") {
      results.push(
        fail(
          check,
          "ADMIN_TOKEN is a published development default, so anyone can read every recorded payload.",
          "Set your own (openssl rand -hex 32) for both the API and the web app, and recreate both."
        )
      );
    } else {
      results.push(
        fail(
          check,
          "ENCRYPTION_KEY_PREVIOUS, the key being rotated out, is a published development default, so data still under it is readable by anyone.",
          // The generic advice would replace the key the stored data is still
          // under, which makes that data unreadable.
          "Do not replace it: finish rotate:reencrypt, then remove it (docs/OPERATIONS.md §6)."
        )
      );
    }
  }

  const flagged = new Set(findings.map((finding) => finding.variable));
  if (!flagged.has("ENCRYPTION_KEY") && (env["ENCRYPTION_KEY"] ?? "").trim() !== "") {
    results.push(pass("ENCRYPTION_KEY", "Not a published default."));
  }

  const token = env["ADMIN_TOKEN"];
  if (!flagged.has("ADMIN_TOKEN")) {
    if (token === undefined || token === "") {
      results.push(
        warn(
          "ADMIN_TOKEN",
          "Not set where doctor runs, so it was not checked.",
          "Run doctor with the API's environment, for example with `docker compose run --rm api`."
        )
      );
    } else if (token.length < 32) {
      results.push(
        fail(
          "ADMIN_TOKEN",
          "Shorter than 32 characters, so the API refuses to start.",
          "Set a longer one: openssl rand -hex 32."
        )
      );
    } else {
      results.push(pass("ADMIN_TOKEN", "Not a published default."));
    }
  }
  return results;
}

async function keysReadableResult(db: Knex, keyring: Keyring): Promise<CheckResult> {
  const found = await findUnreadableData(db, keyring);
  if (found.total > 0) {
    const parts = found.tables
      .map(
        (table) =>
          [table.table, table.unknownKey + table.malformed + table.legacyUnreadable] as const
      )
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${table} ${String(count)}`);
    if (found.apiKeys > 0) parts.push(`api_keys ${String(found.apiKeys)}`);
    return fail(
      "Keys readable",
      `The configured keys cannot read stored data: ${parts.join(", ")}.`,
      "Restore the key that wrote it as ENCRYPTION_KEY_PREVIOUS and recreate the API; rotate:status shows which key id is missing (docs/OPERATIONS.md §6)."
    );
  }
  if (keyring.previous !== null) {
    return warn(
      "Keys readable",
      `Everything is readable, and a rotation is in progress (previous key ${keyring.previous.id}).`,
      "Finish it: run rotate:reencrypt until rotate:status exits 0, then remove ENCRYPTION_KEY_PREVIOUS (docs/OPERATIONS.md §6)."
    );
  }
  return pass("Keys readable", `Everything stored is readable under key ${keyring.current.id}.`);
}

async function projectsResult(db: Knex): Promise<CheckResult> {
  const projectRows: unknown = await db("projects").count({ n: "*" });
  const keyRows: unknown = await db("api_keys").whereNull("revoked_at").count({ n: "*" });
  const projects = Number((projectRows as { n: string | number }[])[0]?.n ?? 0);
  const keys = Number((keyRows as { n: string | number }[])[0]?.n ?? 0);

  if (projects === 0) {
    return warn(
      "Projects and keys",
      "No project exists, so nothing can send events.",
      'Create one: project:create <slug> "<name>", then key:create <slug> <environment>.'
    );
  }
  if (keys === 0) {
    return warn(
      "Projects and keys",
      `${plural(projects, "project")}, and no unrevoked API key.`,
      "Issue one: key:create <project-slug> <environment>."
    );
  }
  return pass(
    "Projects and keys",
    `${plural(projects, "project")}, ${plural(keys, "unrevoked API key")}.`
  );
}

async function apiKeyResult(db: Knex, keyring: Keyring, apiKey: string): Promise<CheckResult> {
  const presented = apiKey.trim();
  if (!presented.startsWith("fr_") || presented.length <= API_KEY_PREFIX_LENGTH) {
    return fail(
      "API key",
      "The key given is not a Flight Recorder API key, which starts fr_ and is 35 characters.",
      "Pass the key key:create printed, whole."
    );
  }

  const prefix = presented.slice(0, API_KEY_PREFIX_LENGTH);
  const row: unknown = await db("api_keys")
    .leftJoin("environments", "api_keys.environment_id", "environments.id")
    .leftJoin("projects", "api_keys.project_id", "projects.id")
    .where("api_keys.key_prefix", prefix)
    .first(
      "api_keys.key_hash as keyHash",
      "api_keys.key_hash_key_id as keyHashKeyId",
      "api_keys.revoked_at as revokedAt",
      "environments.name as environmentName",
      "projects.slug as projectSlug"
    );
  const key = row as
    | {
        keyHash: string;
        keyHashKeyId: string | null;
        revokedAt: Date | null;
        environmentName: string | null;
        projectSlug: string | null;
      }
    | undefined;

  if (key === undefined) {
    return fail(
      "API key",
      `No key with prefix ${prefix} exists in this database.`,
      "Check that DATABASE_URL is the database the key was issued in (key:list shows every prefix), or issue a new key."
    );
  }
  if (key.projectSlug === null || key.environmentName === null) {
    return fail(
      "API key",
      `Key ${prefix} belongs to a project or environment that no longer exists.`,
      "Issue a new key with key:create <project-slug> <environment>."
    );
  }
  const scope = `${key.projectSlug}/${key.environmentName}`;
  if (key.revokedAt !== null) {
    return fail(
      "API key",
      `Key ${prefix} (${scope}) was revoked at ${key.revokedAt.toISOString()}.`,
      `Issue a new one: key:create ${key.projectSlug} ${key.environmentName}.`
    );
  }

  const verification = verifyApiKeyWithKeyring(keyring, presented, {
    keyHash: key.keyHash,
    keyHashKeyId: key.keyHashKeyId
  });
  if (!verification.ok) {
    return fail(
      "API key",
      `Key ${prefix} (${scope}) does not authenticate: the rest of it does not match what was issued, or it was issued under a different ENCRYPTION_KEY.`,
      "Check the key was copied whole and that ENCRYPTION_KEY here is the API's; otherwise issue a new key."
    );
  }
  return pass(
    "API key",
    `Key ${prefix} authenticates for ${scope}. Events it sends must name environment "${key.environmentName}".`
  );
}

async function apiReachableResult(
  apiUrl: string,
  fetcher: typeof fetch,
  timeoutMs: number
): Promise<CheckResult> {
  const shown = displayUrl(apiUrl);
  const readyUrl = `${apiUrl.replace(/\/+$/, "")}/ready`;
  const unreachableFix =
    "Check the URL and that the API is running; inside Compose the API is http://api:8080, not localhost.";

  let response: Response;
  try {
    response = await fetcher(readyUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // fetch wraps the socket error as its cause, and a host name that resolves
    // to several addresses wraps one error per address in an AggregateError.
    const cause = (
      error as { cause?: { code?: unknown; message?: unknown; errors?: { code?: unknown }[] } }
    ).cause;
    const code = cause?.code ?? cause?.errors?.[0]?.code;
    const name = (error as { name?: unknown }).name;
    const reason =
      name === "TimeoutError"
        ? `no answer within ${String(timeoutMs / 1000)} seconds`
        : typeof code === "string"
          ? code
          : typeof cause?.message === "string"
            ? cause.message
            : "the request failed";
    return fail("API reachable", `GET ${shown}/ready: ${reason}.`, unreachableFix);
  }

  if (response.status === 200) return pass("API reachable", `GET ${shown}/ready answered 200.`);

  let reason: string | undefined;
  try {
    const body = (await response.json()) as { reason?: unknown };
    if (typeof body.reason === "string" && /^[a-z_]+$/.test(body.reason)) reason = body.reason;
  } catch {
    // Not the API's JSON: the status alone is reported.
  }

  const fixes: Record<string, string> = {
    migrations_pending: "Run migrate against the API's database (docs/OPERATIONS.md §4).",
    database_unreachable: "The API cannot reach its database: check the API's DATABASE_URL."
  };
  return fail(
    "API reachable",
    `GET ${shown}/ready answered ${String(response.status)}${reason === undefined ? "" : ` ${reason}`}.`,
    (reason === undefined ? undefined : fixes[reason]) ??
      "Check that the URL is Flight Recorder's API and read the API's log."
  );
}

function statementTimeoutResult(env: Record<string, string | undefined>): CheckResult {
  let timeoutMs: number;
  try {
    timeoutMs = loadStatementTimeoutMs(env);
  } catch {
    return fail(
      "Statement timeout",
      "DATABASE_STATEMENT_TIMEOUT_MS is not a whole number of milliseconds, so the API refuses to start.",
      "Set it to a whole number such as 15000, or 0 to disable it."
    );
  }
  if (timeoutMs === 0) {
    return warn(
      "Statement timeout",
      "DATABASE_STATEMENT_TIMEOUT_MS is 0, so one slow query can hold a connection ingestion needs.",
      "Remove it to use the default of 15000, unless your database sets statement_timeout itself."
    );
  }
  return pass("Statement timeout", `The API cancels a statement after ${String(timeoutMs)} ms.`);
}

function secretsIn(env: Record<string, string | undefined>, apiKey: string | undefined): string[] {
  const secrets = [
    env["ADMIN_TOKEN"],
    env["ENCRYPTION_KEY"],
    env["ENCRYPTION_KEY_PREVIOUS"],
    apiKey,
    ...databasePassword(env["DATABASE_URL"])
  ];
  return secrets
    .map((secret) => secret?.trim() ?? "")
    .filter((secret) => secret.length >= MINIMUM_SCRUBBED_LENGTH);
}

function databasePassword(databaseUrl: string | undefined): string[] {
  if (databaseUrl === undefined) return [];
  try {
    const { password } = new URL(databaseUrl);
    return password === "" ? [] : [password, decodeURIComponent(password)];
  } catch {
    return [];
  }
}

function scrub(results: CheckResult[], secrets: readonly string[]): CheckResult[] {
  const clean = (text: string): string =>
    secrets.reduce((current, secret) => current.split(secret).join("[redacted]"), text);
  return results.map((result) => ({
    ...result,
    detail: clean(result.detail),
    ...(result.fix === undefined ? {} : { fix: clean(result.fix) })
  }));
}

/** Scheme, host, port, and path; never credentials or a query string. */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "the API URL";
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  return at === -1 ? [value, undefined] : [value.slice(0, at), value.slice(at + 1)];
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

function pass(check: string, detail: string): CheckResult {
  return { status: "PASS", check, detail };
}

function warn(check: string, detail: string, fix: string): CheckResult {
  return { status: "WARN", check, detail, fix };
}

function fail(check: string, detail: string, fix?: string): CheckResult {
  return { status: "FAIL", check, detail, ...(fix === undefined ? {} : { fix }) };
}

function skip(check: string, reason: string): CheckResult {
  return { status: "SKIP", check, detail: `Not checked: ${reason}.` };
}
