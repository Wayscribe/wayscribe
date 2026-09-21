import { fileURLToPath } from "node:url";
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
import { buildApp } from "../src/app.js";

export interface CapturedCase {
  id: string;
  batches: string[];
  events: Record<string, unknown>[];
  diagnostics: { kind: string; detail?: Record<string, unknown> }[];
}

export interface DriverReport {
  cases: CapturedCase[];
  skipped: { id: string; reason: string }[];
}

type NativeLanguage = "python" | "go";
type Settings = NonNullable<NonNullable<ConformanceCase["setup"]>["environment"]>;

const sdkDirectory = fileURLToPath(
  new URL("../../../packages/protocol/conformance/sdk", import.meta.url)
);
const ENVIRONMENT = "conformance";
const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const exactNativeSkips = [
  { id: "sdk/metadata-uncapturable", reason: "Node-only throwing property getter" },
  { id: "sdk/uncapturable-payload", reason: "Node-only throwing property getter" }
];

export function defineNativeSDKConformanceSuite(
  language: NativeLanguage,
  runDriver: () => DriverReport | Promise<DriverReport>
): void {
  const title = language === "go" ? "Go" : "Python";
  const all = loadConformanceCases(sdkDirectory);
  const cases = all.filter((one) => appliesTo(one, language));
  const fixtures = new Map(cases.map((one) => [one.id, one]));

  describe(`${title} SDK conformance through the real dry-run API`, () => {
    let container: TestDatabase;
    let db: Knex;
    let app: FastifyInstance;
    let defaultKey: string;
    let defaultProject: string;
    let report: DriverReport;
    let captures: Map<string, CapturedCase>;
    const caseKeys = new Map<string, string>();
    const projects = new Map<string, string>();

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
        name: `${language}-sdk`,
        key_prefix: generated.keyPrefix,
        key_hash: generated.verifier,
        key_hash_key_id: generated.keyHashKeyId
      });
      return generated.apiKey;
    }

    beforeAll(async () => {
      report = await runDriver();
      captures = new Map(report.cases.map((one) => [one.id, one]));
      container = await startPostgres();
      db = knex(createKnexConfig(container.getConnectionUri()));
      await db.migrate.latest();

      defaultProject = await insertReturningId(db, "projects", {
        name: `${language} sdk`,
        slug: `${language}-sdk`
      });
      projects.set("default", defaultProject);
      defaultKey = await keyFor(defaultProject, undefined);

      for (const one of cases) {
        const settings = one.setup?.environment;
        if (settings === undefined) continue;
        const projectId = await insertReturningId(db, "projects", {
          name: `${language} ${one.id}`,
          slug: `${language}-sdk-${String(projects.size)}`
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

    it(`accounts for every manifest case with the exact ${title} skip list`, () => {
      expect(all.map((one) => one.id)).toEqual(expectedCaseIds(sdkDirectory, "sdk"));
      expect(report.cases.map((one) => one.id).sort()).toEqual(cases.map((one) => one.id).sort());
      expect(captures.size).toBe(report.cases.length);
      expect(report.skipped).toEqual(exactNativeSkips);

      for (const capture of report.cases) {
        const flattened: Record<string, unknown>[] = [];
        for (const body of capture.batches) {
          const parsed = JSON.parse(body) as {
            events: { event: Record<string, unknown> }[];
          };
          expect(Object.keys(parsed)).toEqual(["events"]);
          expect(parsed.events.length).toBeGreaterThan(0);
          expect(parsed.events.length).toBeLessThanOrEqual(100);
          flattened.push(...parsed.events.map((entry) => entry.event));
        }
        expect(capture.events, capture.id).toEqual(flattened);
      }
    });

    describe.each(cases.map((one) => [one.id] as const))("%s", (id) => {
      it("matches the fixture wire and diagnostic expectations", () => {
        const one = fixtures.get(id);
        const capture = captures.get(id);
        expect(one, "fixture was not loaded").toBeDefined();
        expect(capture, "driver did not report fixture").toBeDefined();
        if (one === undefined || capture === undefined) return;

        expect(capture.events.length).toBe((one.expect.results ?? []).length);
        if (one.expect.wire !== undefined) {
          expect(
            compareExpectation(
              capture.events[0],
              expand(one.expect.wire, { run: "fixture" }),
              "wire"
            )
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
              compareExpectation(
                actual[index]?.detail,
                entry.detail,
                `diagnostics[${String(index)}]`
              )
            ).toEqual([]);
          });
        }

        for (const absent of one.expect.absentFromDiagnostics ?? []) {
          expect(JSON.stringify(capture.diagnostics)).not.toContain(absent);
        }
      });

      it("replays each captured batch byte-for-byte and previews the expected rows", async () => {
        const one = fixtures.get(id);
        const capture = captures.get(id);
        expect(one, "fixture was not loaded").toBeDefined();
        expect(capture, "driver did not report fixture").toBeDefined();
        if (one === undefined || capture === undefined) return;
        const results: Record<string, unknown>[] = [];
        let replayedRequests = 0;

        for (const body of capture.batches) {
          const sent = JSON.parse(body) as { events: unknown[] };
          const response = await app.inject({
            method: "POST",
            url: "/v1/events/batch?dryRun=true",
            headers: {
              authorization: `Bearer ${caseKeys.get(id) ?? defaultKey}`,
              "content-type": "application/json"
            },
            payload: body
          });
          replayedRequests += 1;
          expect(response.statusCode, response.body).toBe(200);
          const parsed: unknown = response.json();
          const data = (
            parsed as {
              data: { dryRun: boolean; results: Record<string, unknown>[] };
            }
          ).data;
          expect(data.dryRun).toBe(true);
          expect(data.results).toHaveLength(sent.events.length);
          results.push(...data.results);
        }

        expect(replayedRequests).toBe(capture.batches.length);
        const expected = one.expect.results ?? [];
        expect(results.length).toBe(expected.length);
        const problems: string[] = [];
        for (const [index, want] of expected.entries()) {
          const actual = results[index] ?? {};
          const at = `results[${String(index)}]`;
          if (actual["status"] !== want.status) {
            problems.push(`${at}.status: expected ${want.status}, got ${String(actual["status"])}`);
          }
          if (want.duplicate !== undefined && actual["duplicate"] !== want.duplicate) {
            problems.push(
              `${at}.duplicate: expected ${String(want.duplicate)}, got ${String(actual["duplicate"])}`
            );
          }
          if (want.eventId !== undefined) {
            problems.push(
              ...compareExpectation(
                actual["eventId"],
                expand(want.eventId, { run: "fixture" }),
                `${at}.eventId`
              )
            );
          }
          if (want.error !== undefined) {
            problems.push(
              ...compareExpectation(
                actual["error"],
                expand(want.error, { run: "fixture" }),
                `${at}.error`
              )
            );
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
}
