import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { createKnexConfig, insertReturningId } from "@wayscribe/database";
import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import {
  appliesTo,
  compareExpectation,
  expand,
  expectedCaseIds,
  loadConformanceCases,
  type ConformanceCase
} from "@wayscribe/protocol/conformance";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

interface CapturedCase {
  id: string;
  batches: string[];
  events: Record<string, unknown>[];
  diagnostics: { kind: string; detail?: Record<string, unknown> }[];
}

interface DriverReport {
  cases: CapturedCase[];
  skipped: { id: string; reason: string }[];
}

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const sdkDirectory = fileURLToPath(
  new URL("../../../../packages/protocol/conformance/sdk", import.meta.url)
);
const driver = fileURLToPath(
  new URL("../../../../packages/sdk-python/tests/conformance_driver.py", import.meta.url)
);
const pythonSource = fileURLToPath(new URL("../../../../packages/sdk-python/src", import.meta.url));
const LANGUAGE = "python";
const ENVIRONMENT = "conformance";
const keyring = createKeyring("0123456789abcdef0123456789abcdef");

function runDriver(): DriverReport {
  const python = process.env["WAYSCRIBE_TEST_PYTHON"] ?? "python3";
  const pythonPath = [pythonSource, process.env["PYTHONPATH"]].filter(Boolean).join(delimiter);
  const completed = spawnSync(python, [driver], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pythonPath },
    maxBuffer: 32 * 1024 * 1024
  });
  if (completed.status !== 0) {
    throw new Error(
      `Python conformance driver exited ${String(completed.status)}\nstdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`
    );
  }
  return JSON.parse(completed.stdout) as DriverReport;
}

describe("Python SDK conformance through the real dry-run API", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let defaultKey: string;
  let defaultProject: string;

  const all = loadConformanceCases(sdkDirectory);
  const cases = all.filter((one) => appliesTo(one, LANGUAGE));
  const fixtures = new Map(cases.map((one) => [one.id, one]));
  const report = runDriver();
  const caseKeys = new Map<string, string>();
  const projects = new Map<string, string>();

  type Settings = NonNullable<NonNullable<ConformanceCase["setup"]>["environment"]>;

  async function keyFor(projectId: string, settings: Settings | undefined): Promise<string> {
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: ENVIRONMENT,
      ...(settings === undefined
        ? {}
        : {
            capture_mode: settings.captureMode,
            redaction_paths: JSON.stringify(settings.redactionPaths ?? []),
            capture_allowlist: JSON.stringify(settings.captureAllowlist ?? [])
          })
    });
    const generated = issueApiKey(keyring);
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "python-sdk",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    return generated.apiKey;
  }

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    defaultProject = await insertReturningId(db, "projects", {
      name: "python sdk",
      slug: "python-sdk"
    });
    projects.set("default", defaultProject);
    defaultKey = await keyFor(defaultProject, undefined);

    for (const one of cases) {
      const settings = one.setup?.environment;
      if (settings === undefined) continue;
      const projectId = await insertReturningId(db, "projects", {
        name: `python ${one.id}`,
        slug: `python-sdk-${String(projects.size)}`
      });
      projects.set(one.id, projectId);
      caseKeys.set(one.id, await keyFor(projectId, settings));
    }

    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("accounts for every manifest case with the exact Python skip list", () => {
    expect(all.map((one) => one.id)).toEqual(expectedCaseIds(sdkDirectory, "sdk"));
    expect(report.cases.map((one) => one.id).sort()).toEqual(cases.map((one) => one.id).sort());
    expect(report.skipped).toEqual([
      {
        id: "sdk/metadata-uncapturable",
        reason: "Node-only throwing property getter"
      },
      {
        id: "sdk/uncapturable-payload",
        reason: "Node-only throwing property getter"
      }
    ]);
  });

  describe.each(report.cases.map((one) => [one.id, one] as const))("%s", (id, capture) => {
    it("matches the fixture wire and diagnostic expectations", () => {
      const one = fixtures.get(id);
      expect(one, "fixture was not loaded").toBeDefined();
      if (one === undefined) return;

      expect(capture.events.length).toBe((one.expect.results ?? []).length);
      if (one.expect.wire !== undefined) {
        expect(
          compareExpectation(capture.events[0], expand(one.expect.wire, { run: "fixture" }), "wire")
        ).toEqual([]);
      }

      const expectedDiagnostics = one.expect.diagnostics;
      if (expectedDiagnostics !== undefined) {
        const kinds = new Set(expectedDiagnostics.map((entry) => entry.kind));
        const actual = capture.diagnostics.filter((entry) => kinds.has(entry.kind));
        expect(actual.map((entry) => entry.kind)).toEqual(
          expectedDiagnostics.map((entry) => entry.kind)
        );
        expectedDiagnostics.forEach((entry, index) => {
          if (entry.detail === undefined) return;
          expect(
            compareExpectation(actual[index]?.detail, entry.detail, `diagnostics[${String(index)}]`)
          ).toEqual([]);
        });
      }

      for (const absent of one.expect.absentFromDiagnostics ?? []) {
        expect(JSON.stringify(capture.diagnostics)).not.toContain(absent);
      }
    });

    it("replays each captured batch byte-for-byte and previews the expected rows", async () => {
      const one = fixtures.get(id);
      expect(one, "fixture was not loaded").toBeDefined();
      if (one === undefined) return;
      const results: Record<string, unknown>[] = [];

      for (const body of capture.batches) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/events/batch?dryRun=true",
          headers: {
            authorization: `Bearer ${caseKeys.get(id) ?? defaultKey}`,
            "content-type": "application/json"
          },
          payload: body
        });
        expect(response.statusCode, response.body).toBe(200);
        const data = response.json().data as {
          dryRun: boolean;
          results: Record<string, unknown>[];
        };
        expect(data.dryRun).toBe(true);
        results.push(...data.results);
      }

      const expected = one.expect.results ?? [];
      expect(results.length).toBe(expected.length);
      const problems: string[] = [];
      for (const [index, want] of expected.entries()) {
        const actual = results[index] ?? {};
        const at = `results[${String(index)}]`;
        if (actual["status"] !== want.status) {
          problems.push(`${at}.status: expected ${want.status}, got ${String(actual["status"])}`);
        }
        const stored = actual["stored"] as { event?: unknown; journey?: unknown } | undefined;
        if (want.stored?.event !== undefined) {
          problems.push(
            ...compareExpectation(
              stored?.event,
              expand(want.stored.event, { run: "fixture" }),
              `${at}.stored.event`
            )
          );
        }
        if (want.stored?.journey !== undefined) {
          problems.push(
            ...compareExpectation(
              stored?.journey,
              expand(want.stored.journey, { run: "fixture" }),
              `${at}.stored.journey`
            )
          );
        }
      }
      expect(problems).toEqual([]);
    });
  });

  it("keeps every fixture project empty after all dry runs", async () => {
    for (const [caseId, projectId] of projects) {
      for (const table of ["journey_events", "journeys", "entity_aliases"]) {
        const row: unknown = await db(table)
          .where({ project_id: projectId })
          .count({ n: "*" })
          .first();
        expect(Number((row as { n: string }).n), `${caseId}: ${table}`).toBe(0);
      }
    }
  });
});
