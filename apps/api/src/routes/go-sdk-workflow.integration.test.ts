import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const example = fileURLToPath(new URL("../../../../examples/go-worker", import.meta.url));
const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const outputLimit = 1024 * 1024;

interface WorkerResult {
  journeyId: string;
  entityId: string;
  alias: string;
  counters: { recorded: number; sent: number; rejected: number; dropped: number };
}

async function runWorker(
  binary: string,
  environment: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, [], { cwd: root, env: environment });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => {
        reject(new Error("Go worker exceeded its 30 second timeout"));
      });
    }, 30_000);
    const append = (stream: "stdout" | "stderr", chunk: string): void => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > outputLimit) {
        child.kill("SIGKILL");
        finish(() => {
          reject(new Error("Go worker exceeded its 1 MiB output limit"));
        });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      append("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      append("stderr", chunk);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (status) => {
      finish(() => {
        resolve({ status, stdout, stderr });
      });
    });
  });
}

describe("an external Go worker against the real API", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let workerResult: WorkerResult;

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();
    const projectId = await insertReturningId(db, "projects", {
      name: "go workflow",
      slug: "go-workflow"
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
      name: "go-worker",
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
    const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });

    const owned = mkdtempSync(join(root, "examples", ".go-worker-test-"));
    try {
      const sourceModule = readFileSync(join(example, "go.mod"), "utf8");
      writeFileSync(join(owned, "go.mod"), sourceModule);
      writeFileSync(join(owned, "main.go"), readFileSync(join(example, "main.go")));
      const binary = join(owned, "go-worker");
      const environment = {
        ...process.env,
        GOTOOLCHAIN: "local",
        GOWORK: "off",
        GOPROXY: "off",
        GOSUMDB: "off",
        GOMODCACHE: join(owned, "module-cache")
      };
      const built = spawnSync("go", ["build", "-trimpath", "-o", binary, "."], {
        cwd: owned,
        encoding: "utf8",
        env: environment,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000
      });
      if (built.status !== 0) {
        throw new Error(
          `External Go worker build exited ${String(built.status)}\nstdout:\n${built.stdout}\nstderr:\n${built.stderr}`
        );
      }
      const identified = spawnSync("go", ["version", "-m", binary], {
        cwd: owned,
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: 10_000
      });
      const buildMetadata = identified.stdout.split("\n").slice(1).join("\n");
      if (
        identified.status !== 0 ||
        buildMetadata.includes(root) ||
        !buildMetadata.includes("=>\t../../packages/sdk-go")
      ) {
        throw new Error(
          `External Go worker exposed unexpected build identity:\n${identified.stdout}`
        );
      }
      const completed = await runWorker(binary, {
        ...environment,
        WAYSCRIBE_ENDPOINT: endpoint,
        WAYSCRIBE_API_KEY: apiKey,
        WAYSCRIBE_ENVIRONMENT: "development",
        WORKER_ENTITY_ID: "customer-go-42",
        WORKER_ALIAS: "crm-go-9001"
      });
      if (completed.status !== 0) {
        throw new Error(
          `Go worker exited ${String(completed.status)}\nstdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`
        );
      }
      workerResult = JSON.parse(completed.stdout) as WorkerResult;
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const get = async (url: string): Promise<Record<string, unknown>> => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data as Record<string, unknown>;
  };

  it("imports the public module and records one searchable completed journey", async () => {
    expect(workerResult).toMatchObject({
      entityId: "customer-go-42",
      alias: "crm-go-9001",
      counters: { recorded: 5, sent: 5, rejected: 0, dropped: 0 }
    });
    expect(await db("journeys").count({ n: "*" }).first()).toMatchObject({ n: "1" });

    const search = (await get(`/v1/search?q=${encodeURIComponent(workerResult.alias)}`)) as {
      items: { journeyId: string }[];
    };
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.journeyId).toBe(workerResult.journeyId);

    const journey = await get(`/v1/journeys/${workerResult.journeyId}`);
    expect(journey).toMatchObject({
      journeyId: workerResult.journeyId,
      status: "completed",
      services: ["go-worker"]
    });
  });

  it("shows redaction, a literal field diff, the failed attempt and explicit retry", async () => {
    const timeline = (await get(`/v1/journeys/${workerResult.journeyId}/events`)) as {
      items: { id: string; name: string; operation: string; service: string }[];
    };
    expect(timeline.items).toHaveLength(5);
    expect(new Set(timeline.items.map((event) => event.service))).toEqual(new Set(["go-worker"]));

    const transformed = timeline.items.find((event) => event.name === "normalize-customer");
    const detail = await get(`/v1/events/${String(transformed?.id)}`);
    expect(detail["inputPayload"]).toEqual({
      customerId: "customer-go-42",
      password: "[REDACTED]",
      phone: "+1 919 555 1234"
    });
    expect(detail["outputPayload"]).toEqual({
      customerId: "customer-go-42",
      password: "[REDACTED]",
      phone: null
    });
    expect(detail["payloadDiff"]).toEqual({
      truncated: false,
      changes: [{ path: "phone", kind: "changed", before: "+1 919 555 1234", after: null }]
    });

    const deliveries = timeline.items.filter((event) => event.name === "deliver-customer");
    expect(deliveries.map((event) => event.operation)).toEqual(["delivered", "retried"]);
    const failed = await get(`/v1/events/${String(deliveries[0]?.id)}`);
    const retried = await get(`/v1/events/${String(deliveries[1]?.id)}`);
    expect(failed["error"]).toMatchObject({ type: "DeliveryRejected" });
    expect(retried).toMatchObject({
      operation: "retried",
      error: { code: "target_rejected" },
      customMetadata: { attempt: 2 }
    });
    expect(timeline.items.at(-1)).toMatchObject({ operation: "completed", name: "complete" });
  });
});
