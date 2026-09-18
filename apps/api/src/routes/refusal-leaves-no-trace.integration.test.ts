import { startPostgres, type TestDatabase } from "@wayscribe/database/testing";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";
const NUL = "\u0000";

type Environment = "production" | "development";
type Route = "single" | "batch" | "dry-run";

/** The tables a refused event could leave a trace in. */
const TRACE_TABLES = ["journeys", "entity_aliases", "journey_events"] as const;

function envelope(environment: Environment, overrides: Record<string, unknown>): unknown {
  return {
    protocolVersion: "0.1",
    event: {
      environment,
      service: "svc",
      entity: { type: "order", id: "ord-1" },
      operation: "received",
      name: "step",
      timestamp: "2026-09-15T10:00:00.000Z",
      ...overrides
    }
  };
}

interface RefusalCase {
  code: string;
  /** Stores whatever the refusal needs to exist first. Runs once per route. */
  arrange: (suffix: string) => Promise<void>;
  /** The refused event, with a journey id nothing has used yet. */
  refused: (suffix: string) => { environment: Environment; body: unknown; journeyId: string };
}

/**
 * A refused event leaves nothing behind: no journey, no alias, no event, and no
 * change to a journey's summary.
 *
 * The journey is written before the event, because journey_events carries a
 * foreign key to it. A refusal discovered after that write used to be returned
 * from inside the transaction, which committed it: an `event_id_conflict` sent
 * with a new journey id created an empty journey that the list route showed.
 * This sweeps every refusal that can be reached after the journey is touched,
 * through all three ways of sending an event, and reads the rows back from
 * PostgreSQL rather than inferring them from the response.
 */
describe("a refused event leaves no trace", () => {
  let container: TestDatabase;
  let db: Knex;
  let app: FastifyInstance;
  let projectId: string;
  const keys: Record<Environment, string> = { production: "", development: "" };

  beforeAll(async () => {
    container = await startPostgres();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    for (const environment of ["production", "development"] as const) {
      keys[environment] = (
        await issueKey(db, keyring, {
          projectSlug: "acme",
          environmentName: environment,
          name: "k"
        })
      ).apiKey;
    }

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const post = (environment: Environment, route: Route, bodies: unknown[]) =>
    route === "single"
      ? app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { authorization: `Bearer ${keys[environment]}` },
          payload: bodies[0] as object
        })
      : app.inject({
          method: "POST",
          url: route === "dry-run" ? "/v1/events/batch?dryRun=true" : "/v1/events/batch",
          headers: { authorization: `Bearer ${keys[environment]}` },
          payload: { events: bodies } as object
        });

  const accept = async (environment: Environment, body: unknown) => {
    const response = await post(environment, "single", [body]);
    expect(response.statusCode, response.body).toBe(202);
  };

  const counts = async (): Promise<Record<string, number>> => {
    const result: Record<string, number> = {};
    for (const table of TRACE_TABLES) {
      const row: unknown = await db(table)
        .where({ project_id: projectId })
        .count({ n: "*" })
        .first();
      result[table] = Number((row as { n: string }).n);
    }
    return result;
  };

  /** The code a refusal came back with, from whichever route answered. */
  const refusalCode = (route: Route, response: { statusCode: number; body: string }) => {
    if (route === "single")
      return (JSON.parse(response.body) as { error: { code: string } }).error.code;
    const body = JSON.parse(response.body) as {
      data: { results: { status: string; error?: { code: string } }[] };
    };
    expect(body.data.results[0]?.status).toBe("rejected");
    return body.data.results[0]?.error?.code;
  };

  const cases: RefusalCase[] = [
    {
      code: "event_id_conflict",
      arrange: (suffix) =>
        accept(
          "production",
          envelope("production", { id: `evt_c_${suffix}`, journeyId: `jrn_c_${suffix}` })
        ),
      // The same id with a new journey id: different content, and a journey
      // nothing has created yet.
      refused: (suffix) => ({
        environment: "production",
        journeyId: `jrn_c_new_${suffix}`,
        body: envelope("production", {
          id: `evt_c_${suffix}`,
          journeyId: `jrn_c_new_${suffix}`,
          aliases: { orderId: "ord-ghost" }
        })
      })
    },
    {
      code: "event_id_conflict",
      // The same id and journey, different content: the journey exists, and
      // its summary and aliases must not move.
      arrange: (suffix) =>
        accept(
          "production",
          envelope("production", { id: `evt_s_${suffix}`, journeyId: `jrn_s_${suffix}` })
        ),
      refused: (suffix) => ({
        environment: "production",
        journeyId: `jrn_s_${suffix}`,
        body: envelope("production", {
          id: `evt_s_${suffix}`,
          journeyId: `jrn_s_${suffix}`,
          name: "different",
          timestamp: "2026-09-15T12:00:00.000Z",
          error: { message: "boom" },
          aliases: { orderId: "ord-ghost" }
        })
      })
    },
    {
      code: "journey_environment_mismatch",
      arrange: (suffix) =>
        accept(
          "production",
          envelope("production", { id: `evt_m_${suffix}`, journeyId: `jrn_m_${suffix}` })
        ),
      refused: (suffix) => ({
        environment: "development",
        journeyId: `jrn_m_${suffix}`,
        body: envelope("development", {
          id: `evt_m_dev_${suffix}`,
          journeyId: `jrn_m_${suffix}`,
          aliases: { orderId: "ord-ghost" }
        })
      })
    },
    {
      code: "unstorable_payload",
      arrange: () => Promise.resolve(),
      refused: (suffix) => ({
        environment: "production",
        journeyId: `jrn_u_${suffix}`,
        body: envelope("production", {
          id: `evt_u_${suffix}`,
          journeyId: `jrn_u_${suffix}`,
          aliases: { orderId: "ord-ghost" },
          input: { note: `a${NUL}b` }
        })
      })
    }
  ];

  const routes: Route[] = ["single", "batch", "dry-run"];

  for (const [index, refusal] of cases.entries()) {
    for (const route of routes) {
      it(`${refusal.code} (case ${String(index + 1)}) through ${route} stores nothing`, async () => {
        const suffix = `${String(index)}_${route}`;
        await refusal.arrange(suffix);
        const { environment, body, journeyId } = refusal.refused(suffix);

        const journeyBefore: unknown = await db("journeys")
          .where({ project_id: projectId, id: journeyId })
          .first();
        const before = await counts();

        const response = await post(environment, route, [body]);
        if (route !== "single" || refusal.code !== "unstorable_payload") {
          expect(refusalCode(route, response)).toBe(refusal.code);
        } else {
          expect(response.statusCode).toBe(400);
        }

        expect(await counts()).toEqual(before);
        const journeyAfter: unknown = await db("journeys")
          .where({ project_id: projectId, id: journeyId })
          .first();
        // Absent if it was absent, and unchanged, summary included, if not.
        expect(journeyAfter).toEqual(journeyBefore);
      });
    }
  }

  it("does not list a journey whose only event was refused", async () => {
    await accept("production", envelope("production", { id: "evt_list", journeyId: "jrn_list" }));
    const refused = await post("production", "batch", [
      envelope("production", { id: "evt_list", journeyId: "jrn_list_ghost" })
    ]);
    expect(refusalCode("batch", refused)).toBe("event_id_conflict");

    const listed = await app.inject({
      method: "GET",
      url: "/v1/journeys?since=2026-01-01T00:00:00Z",
      headers: { authorization: `Bearer ${keys.production}` }
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain("jrn_list_ghost");
  });

  /**
   * Inside a batch, a refused event must not shape the journey a later event
   * in the same batch creates: the later event's entity and timestamp are the
   * journey's, as if the refused one had never been sent. The dry run answers
   * the same as the real batch, because it is the same ingestion rolled back.
   */
  for (const route of ["batch", "dry-run"] as const) {
    it(`a refused event does not shape a journey created later in the same ${route}`, async () => {
      const journeyId = `jrn_shape_${route}`;
      await accept(
        "production",
        envelope("production", { id: `evt_shape_${route}`, journeyId: "jrn_shape_owner" + route })
      );

      const response = await post("production", route, [
        envelope("production", {
          id: `evt_shape_${route}`,
          journeyId,
          entity: { type: "ghost", id: "ghost-1" },
          timestamp: "2026-09-15T08:00:00.000Z"
        }),
        envelope("production", {
          id: `evt_shape_real_${route}`,
          journeyId,
          entity: { type: "order", id: "ord-real" },
          timestamp: "2026-09-15T09:00:00.000Z"
        })
      ]);
      const body = JSON.parse(response.body) as {
        data: {
          results: {
            status: string;
            error?: { code: string };
            stored?: { journey: Record<string, unknown> };
          }[];
        };
      };
      expect(body.data.results[0]?.error?.code).toBe("event_id_conflict");
      expect(body.data.results[1]?.status).toBe("accepted");

      const expected = {
        entity: { type: "order", id: "ord-real" },
        eventCount: 1,
        startedAt: "2026-09-15T09:00:00.000Z"
      };

      if (route === "dry-run") {
        expect(body.data.results[1]?.stored?.journey).toMatchObject(expected);
        expect(
          await db("journeys").where({ project_id: projectId, id: journeyId }).first()
        ).toBeUndefined();
        return;
      }

      const read = await app.inject({
        method: "GET",
        url: `/v1/journeys/${journeyId}`,
        headers: { authorization: `Bearer ${keys.production}` }
      });
      expect(read.statusCode, read.body).toBe(200);
      expect((JSON.parse(read.body) as { data: Record<string, unknown> }).data).toMatchObject(
        expected
      );
    });
  }
});
