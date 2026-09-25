import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeOwnedTestResources,
  type OwnedTestResource
} from "../../test-support/owned-test-resources.js";
import { buildApp } from "../app.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const example = join(root, "examples", "mixed-language");
const wheel = join(root, "packages", "sdk-python", "dist", "wayscribe-0.1.0a1-py3-none-any.whl");
const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const outputLimit = 128 * 1024;

interface DriverResult {
  journeyId: string;
  entity: { type: string; id: string };
  alias: string;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`${command} exceeded its ${String(options.timeoutMs)}ms test deadline`);
      child.kill("SIGKILL");
    }, options.timeoutMs);
    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > outputLimit && failure === undefined) {
        failure = new Error(`${command} exceeded its ${String(outputLimit)} byte output limit`);
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      append("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append("stderr", chunk);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ status, stdout, stderr });
    });
  });
}

describe("the public SDK mixed-language example against the real API", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let endpoint: string;
  let installedExample: string;
  let driverTemp: string;
  let python: string;
  let result: DriverResult;
  const owned: {
    container: TestDatabase | undefined;
    db: Knex | undefined;
    app: FastifyInstance | undefined;
    example: string | undefined;
  } = { container: undefined, db: undefined, app: undefined, example: undefined };

  async function cleanup(): Promise<void> {
    const appToClose = owned.app;
    const dbToClose = owned.db;
    const containerToClose = owned.container;
    const exampleToRemove = owned.example;
    const resources: (OwnedTestResource | undefined)[] = [
      appToClose === undefined
        ? undefined
        : { name: "Fastify app", close: () => appToClose.close() },
      dbToClose === undefined
        ? undefined
        : { name: "Knex connection", close: () => dbToClose.destroy() },
      containerToClose === undefined
        ? undefined
        : { name: "PostgreSQL container", close: () => containerToClose.stop() },
      exampleToRemove === undefined
        ? undefined
        : {
            name: "installed mixed-language example",
            close: () => {
              rmSync(exampleToRemove, { recursive: true, force: true });
            }
          }
    ];
    owned.app = undefined;
    owned.db = undefined;
    owned.container = undefined;
    owned.example = undefined;
    await closeOwnedTestResources(resources);
  }

  async function requireSuccess(
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
  ): Promise<string> {
    const completed = await runCommand(command, args, options);
    if (completed.status !== 0) {
      throw new Error(
        `${command} exited ${String(completed.status)}\nstdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`
      );
    }
    return completed.stdout;
  }

  async function setup(): Promise<void> {
    if (!existsSync(wheel)) throw new Error(`Build the reviewed Python wheel first: ${wheel}`);

    container = await startPostgres();
    owned.container = container;
    db = knex(createKnexConfig(container.getConnectionUri()));
    owned.db = db;
    await db.migrate.latest();
    const projectId = await insertReturningId(db, "projects", {
      name: "mixed language workflow",
      slug: "mixed-language-workflow"
    });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development",
      capture_mode: "redacted-payload"
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "mixed-language-test",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });

    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });
    owned.app = app;
    endpoint = await app.listen({ host: "127.0.0.1", port: 0 });

    installedExample = mkdtempSync(join(root, "examples", ".mixed-language-test-"));
    owned.example = installedExample;
    cpSync(example, installedExample, { recursive: true });
    driverTemp = join(installedExample, "driver-tmp");
    mkdirSync(driverTemp);
    const packageJson = JSON.parse(
      readFileSync(join(installedExample, "package.json"), "utf8")
    ) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies["@wayscribe/node"] = `file:${join(root, "packages", "sdk-node")}`;
    writeFileSync(
      join(installedExample, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`
    );
    const goMod = readFileSync(join(installedExample, "go.mod"), "utf8").replace(
      "../../packages/sdk-go",
      join(root, "packages", "sdk-go")
    );
    writeFileSync(join(installedExample, "go.mod"), goMod);

    await requireSuccess("pnpm", ["--filter", "@wayscribe/node", "build"], {
      cwd: root,
      timeoutMs: 60_000
    });
    await requireSuccess("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: installedExample,
      timeoutMs: 60_000
    });
    const basePython = process.env["WAYSCRIBE_TEST_PYTHON"] ?? "python3.11";
    await requireSuccess(basePython, ["-m", "venv", ".venv"], {
      cwd: installedExample,
      timeoutMs: 60_000
    });
    python = join(installedExample, ".venv", "bin", "python");
    await requireSuccess(
      python,
      ["-m", "pip", "install", "--no-index", "--disable-pip-version-check", wheel],
      { cwd: installedExample, timeoutMs: 60_000 }
    );

    const driverEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: driverTemp,
      WAYSCRIBE_PYTHON: python
    };
    delete driverEnvironment.PYTHONPATH;
    const stdout = await requireSuccess(
      process.execPath,
      ["run.mjs", "--api-url", endpoint, "--api-key", apiKey, "--environment", "development"],
      {
        cwd: installedExample,
        env: driverEnvironment,
        timeoutMs: 60_000
      }
    );
    result = JSON.parse(stdout) as DriverResult;
  }

  beforeAll(async () => {
    try {
      await setup();
    } catch (setupError) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [setupError, cleanupError],
          "Mixed-language setup and cleanup failed"
        );
      }
      throw setupError;
    }
  }, 240_000);

  afterAll(cleanup);

  async function get(url: string): Promise<Record<string, unknown>> {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data as Record<string, unknown>;
  }

  it("records one searchable journey through Node, Python and Go", async () => {
    expect(result).toEqual({
      journeyId: expect.stringMatching(/^jrn_/),
      entity: { type: "customer", id: "customer-mixed-42" },
      alias: "crm-mixed-9001"
    });
    expect(await db("journeys").count({ n: "*" }).first()).toMatchObject({ n: "1" });

    const search = (await get(`/v1/search?q=${encodeURIComponent(result.alias)}`)) as {
      items: { journeyId: string }[];
    };
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.journeyId).toBe(result.journeyId);

    const journey = await get(`/v1/journeys/${result.journeyId}`);
    expect(journey).toMatchObject({
      journeyId: result.journeyId,
      entity: result.entity,
      status: "completed"
    });
    expect(new Set(journey["services"] as string[])).toEqual(
      new Set(["mixed-node", "mixed-python", "mixed-go"])
    );
    expect(readdirSync(driverTemp)).toEqual([]);
  });

  it("shows the literal redacted transformation, failed delivery, retry and completion", async () => {
    const timeline = (await get(`/v1/journeys/${result.journeyId}/events`)) as {
      items: { id: string; name: string; operation: string; service: string }[];
    };
    expect(timeline.items).toHaveLength(6);
    const transformation = timeline.items.find((event) => event.name === "normalize-email");
    expect(transformation).toBeDefined();
    const detail = await get(`/v1/events/${String(transformation?.id)}`);
    expect(detail["inputPayload"]).toMatchObject({
      email: " Mixed@Example.invalid ",
      password: "[REDACTED]"
    });
    expect(detail["outputPayload"]).toMatchObject({
      email: "mixed@example.invalid",
      password: "[REDACTED]"
    });
    expect((detail["payloadDiff"] as { changes: unknown[] }).changes).toContainEqual(
      expect.objectContaining({ path: "email", kind: "changed" })
    );

    const deliveries = timeline.items.filter((event) => event.name === "deliver-customer");
    expect(deliveries.map((event) => event.operation)).toEqual(["delivered", "retried"]);
    const failed = await get(`/v1/events/${String(deliveries[0]?.id)}`);
    expect(failed["error"]).toMatchObject({ message: "synthetic destination refused attempt" });
    expect(timeline.items.at(-1)).toMatchObject({ operation: "completed", name: "complete" });
  });

  it("refuses an incompatible key environment without creating another journey", async () => {
    const before = await db("journeys").count({ n: "*" }).first();
    const driverEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: driverTemp,
      WAYSCRIBE_PYTHON: python
    };
    delete driverEnvironment.PYTHONPATH;
    const completed = await runCommand(
      process.execPath,
      ["run.mjs", "--api-url", endpoint, "--api-key", apiKey, "--environment", "production"],
      {
        cwd: installedExample,
        env: driverEnvironment,
        timeoutMs: 60_000
      }
    );
    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain("one or more SDKs refused events");
    expect(completed.stderr).not.toContain(apiKey);
    expect(await db("journeys").count({ n: "*" }).first()).toEqual(before);
    expect(readdirSync(driverTemp)).toEqual([]);
  });
});
