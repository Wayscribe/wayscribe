import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../../../packages/cli/src/cli.js";
import { closeOwnedTestResources } from "../../test-support/owned-test-resources.js";
import { buildApp } from "../app.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const modes = ["redacted-payload", "metadata-only", "custom"] as const;
describe("CLI dry runs against the owned real API/database", () => {
  let container: TestDatabase | undefined;
  let db: Knex | undefined;
  let app: FastifyInstance | undefined;
  let directory: string | undefined;
  let endpoint: string;
  const keys = new Map<string, string>();
  async function cleanup() {
    await closeOwnedTestResources([
      app === undefined ? undefined : { name: "API", close: () => required(app).close() },
      db === undefined
        ? undefined
        : { name: "database connection", close: () => required(db).destroy() },
      container === undefined
        ? undefined
        : { name: "isolated database", close: () => required(container).stop() },
      directory === undefined
        ? undefined
        : {
            name: "preview fixtures",
            close: () => rm(required(directory), { recursive: true, force: true })
          }
    ]);
  }
  beforeAll(async () => {
    try {
      container = await startPostgres();
      db = knex(createKnexConfig(container.getConnectionUri()));
      await db.migrate.latest();
      directory = await mkdtemp(join(tmpdir(), "wayscribe-cli-api-"));
      const project = await insertReturningId(db, "projects", {
        name: "CLI preview",
        slug: "cli-preview"
      });
      for (const mode of modes) {
        const environment = await insertReturningId(db, "environments", {
          project_id: project,
          name: mode,
          capture_mode: mode === "custom" ? "redacted-payload" : mode,
          redaction_paths: JSON.stringify(mode === "custom" ? ["**.privateNote"] : [])
        });
        const issued = issueApiKey(keyring);
        keys.set(mode, issued.apiKey);
        await db("api_keys").insert({
          project_id: project,
          environment_id: environment,
          name: `preview-${mode}`,
          key_prefix: issued.keyPrefix,
          key_hash: issued.verifier,
          key_hash_key_id: issued.keyHashKeyId
        });
      }
      app = buildApp({
        db,
        keyring,
        adminToken: "admin-token-for-tests-0000000000",
        logLevel: "silent"
      });
      endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      await cleanup();
      throw error;
    }
  });
  afterAll(cleanup);

  async function counts() {
    const result: Record<string, unknown> = {};
    for (const table of [
      "journeys",
      "journey_events",
      "entity_aliases",
      "replay_runs",
      "replay_destinations",
      "audit_events"
    ]) {
      result[table] = await required(db)(table).count({ n: "*" }).first();
    }
    return result;
  }
  async function command(args: string[], key: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run([...args, "--url", endpoint, "--json"], {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      isTty: false,
      env: { WAYSCRIBE_API_KEY: key }
    });
    expect(err).toEqual([]);
    expect(out.join("")).not.toContain(key);
    return { code, result: JSON.parse(out.join("")) };
  }
  function envelope(environment: string) {
    return {
      protocolVersion: "0.1",
      event: {
        id: `evt_${randomUUID()}`,
        journeyId: `jrn_${randomUUID()}`,
        environment,
        service: "preview-worker",
        entity: { type: "order", id: "synthetic-order-42" },
        aliases: { externalOrder: "external-42" },
        displayableAliases: ["externalOrder"],
        operation: "transformed",
        name: "normalize",
        timestamp: "2026-09-20T10:00:00.000Z",
        input: { value: "before", password: "synthetic-secret-42", privateNote: "synthetic-note" },
        output: { value: "after", password: "synthetic-secret-42", privateNote: "synthetic-note" }
      }
    };
  }
  it.each(modes)("check and %s stored-form preview preserve every evidence table", async (mode) => {
    const before = await counts();
    const key = required(keys.get(mode));
    const check = await command(["check", "--environment", mode, "--service", "setup-check"], key);
    expect(check.code).toBe(0);
    expect(check.result).toMatchObject({
      dryRun: true,
      results: [{ status: "accepted", preview: "stored-form" }]
    });
    expect(await counts()).toEqual(before);
    const file = join(required(directory), `${mode}.json`);
    await writeFile(file, JSON.stringify({ events: [envelope(mode)] }));
    const preview = await command(["preview", file], key);
    expect(preview.code).toBe(0);
    const result = preview.result.results[0];
    expect(result).toMatchObject({
      status: "accepted",
      duplicate: false,
      preview: "stored-form",
      stored: {
        journey: {
          environment: mode,
          entity: { type: "order", id: "synthetic-order-42" },
          status: "active",
          aliases: [{ type: "externalOrder", displayValue: "external-42", displayable: true }],
          services: ["preview-worker"]
        },
        event: {
          operation: "transformed",
          name: "normalize",
          service: "preview-worker",
          hasInput: mode !== "metadata-only",
          hasOutput: mode !== "metadata-only",
          hasError: false
        }
      }
    });
    if (mode === "metadata-only") {
      expect(result.stored.event).toMatchObject({
        inputPayload: null,
        outputPayload: null,
        payloadDiff: null
      });
    } else {
      expect(result.stored.event.inputPayload).toEqual({
        value: "before",
        password: "[REDACTED]",
        privateNote: mode === "custom" ? "[REDACTED]" : "synthetic-note"
      });
      expect(result.stored.event.outputPayload).toEqual({
        value: "after",
        password: "[REDACTED]",
        privateNote: mode === "custom" ? "[REDACTED]" : "synthetic-note"
      });
      expect(result.stored.event.payloadDiff.changes).toEqual([
        { path: "value", kind: "changed", before: "before", after: "after" }
      ]);
    }
    expect(await counts()).toEqual(before);
    const used = await required(db)("api_keys")
      .whereNotNull("last_used_at")
      .count({ n: "*" })
      .first();
    expect(Number(used?.n)).toBeGreaterThan(0);
  });

  it("reports per-position event refusals and environment refusal without any evidence writes", async () => {
    const before = await counts();
    const file = join(required(directory), "rejected.json");
    await writeFile(file, JSON.stringify({ events: [null, envelope("metadata-only")] }));
    const preview = await command(["preview", file], required(keys.get("redacted-payload")));
    expect(preview.code).toBe(1);
    expect(preview.result.results).toMatchObject([
      { position: 0, status: "rejected", error: { code: "invalid_event", httpStatus: 400 } },
      {
        position: 1,
        status: "rejected",
        error: { code: "unauthorized_environment", httpStatus: 403 }
      }
    ]);
    const check = await command(
      ["check", "--environment", "metadata-only", "--service", "check"],
      required(keys.get("redacted-payload"))
    );
    expect(check.code).toBe(1);
    expect(check.result.results[0]).toMatchObject({
      status: "rejected",
      error: { code: "unauthorized_environment" }
    });
    expect(await counts()).toEqual(before);
  });
});
