import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const worker = fileURLToPath(
  new URL("../../../../examples/python-worker/worker.py", import.meta.url)
);
const pythonSource = fileURLToPath(new URL("../../../../packages/sdk-python/src", import.meta.url));
const keyring = createKeyring("0123456789abcdef0123456789abcdef");

interface WorkerResult {
  journeyId: string;
  entityId: string;
  alias: string;
  counters: { recorded: number; sent: number; rejected: number; dropped: number };
}

async function runWorker(
  python: string,
  environment: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [worker], { cwd: root, env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

describe("the Python worker against the real API", () => {
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
      name: "python workflow",
      slug: "python-workflow"
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
      name: "python-worker",
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
    const python = process.env["WAYSCRIBE_TEST_PYTHON"] ?? "python3";
    const pythonPath = [pythonSource, process.env["PYTHONPATH"]].filter(Boolean).join(delimiter);
    const completed = await runWorker(python, {
      ...process.env,
      PYTHONPATH: pythonPath,
      WAYSCRIBE_ENDPOINT: endpoint,
      WAYSCRIBE_API_KEY: apiKey,
      WAYSCRIBE_ENVIRONMENT: "development",
      WORKER_ENTITY_ID: "customer-python-42",
      WORKER_ALIAS: "crm-python-9001"
    });
    if (completed.status !== 0) {
      throw new Error(
        `Python worker exited ${String(completed.status)}\nstdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`
      );
    }
    workerResult = JSON.parse(completed.stdout) as WorkerResult;
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

  it("records one searchable journey with a redacted transformation diff", async () => {
    expect(workerResult).toMatchObject({
      entityId: "customer-python-42",
      alias: "crm-python-9001",
      counters: { recorded: 5, sent: 5, rejected: 0, dropped: 0 }
    });
    expect(await db("journeys").count({ n: "*" }).first()).toMatchObject({ n: "1" });

    const search = (await get(`/v1/search?q=${encodeURIComponent(workerResult.alias)}`)) as {
      items: { journeyId: string }[];
    };
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.journeyId).toBe(workerResult.journeyId);

    const timeline = (await get(`/v1/journeys/${workerResult.journeyId}/events`)) as {
      items: { id: string; name: string; operation: string }[];
    };
    expect(timeline.items).toHaveLength(5);
    const transformed = timeline.items.find((event) => event.name === "normalize-customer");
    expect(transformed).toBeDefined();
    const detail = await get(`/v1/events/${String(transformed?.id)}`);
    expect(detail["inputPayload"]).toEqual({
      customerId: "customer-python-42",
      password: "[REDACTED]",
      phone: "+1 919 555 1234"
    });
    expect(detail["outputPayload"]).toEqual({
      customerId: "customer-python-42",
      password: "[REDACTED]",
      phone: null
    });
    expect(detail["payloadDiff"]).toMatchObject({
      truncated: false,
      changes: [{ path: "phone", kind: "changed", before: "+1 919 555 1234", after: null }]
    });
  });

  it("shows the failed delivery, retried attempt and completion", async () => {
    const timeline = (await get(`/v1/journeys/${workerResult.journeyId}/events`)) as {
      items: { id: string; name: string; operation: string }[];
    };
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
