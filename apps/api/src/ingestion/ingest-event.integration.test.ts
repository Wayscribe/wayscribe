import {
  ALIAS_DISPLAY_VALUE_CONSTRAINT,
  createKnexConfig,
  insertReturningId,
  type ApiKeyContext
} from "@wayscribe/database";
import { createKeyring, issueApiKey } from "@wayscribe/payload-security";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";
import { ingestEvent } from "./ingest-event.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");

function envelope(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    protocolVersion: "0.1",
    event: {
      id: "evt_1",
      journeyId: "jrn_1",
      environment: "development",
      service: "job-radar",
      entity: { type: "posting", id: "entity-secret-id" },
      operation: "transformed",
      name: "score-posting",
      timestamp: "2026-09-16T10:00:00.000Z",
      ...overrides
    }
  };
}

interface JourneyColumns {
  label: string | null;
  label_at: Date | null;
  label_event_id: string | null;
  last_step: string | null;
  last_step_at: Date | null;
  last_step_event_id: string | null;
}

interface AliasColumns {
  alias_type: string;
  displayable: boolean;
  display_value: string | null;
}

describe("ingestion stores labels, last steps and plain-text copies", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let projectId: string;
  let context: ApiKeyContext;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    projectId = await insertReturningId(db, "projects", { name: "P", slug: "p" });
    const environmentId = await insertReturningId(db, "environments", {
      project_id: projectId,
      name: "development"
    });
    const generated = issueApiKey(keyring);
    apiKey = generated.apiKey;
    await db("api_keys").insert({
      project_id: projectId,
      environment_id: environmentId,
      name: "k",
      key_prefix: generated.keyPrefix,
      key_hash: generated.verifier,
      key_hash_key_id: generated.keyHashKeyId
    });
    // What authentication resolves for this key; ingestEvent reads the scope
    // and capture policy from it.
    context = {
      id: "key",
      projectId,
      environmentId,
      environmentName: "development",
      keyHash: generated.verifier,
      keyHashKeyId: generated.keyHashKeyId,
      revokedAt: null,
      captureMode: "metadata-only",
      redactionPaths: [],
      captureAllowlist: []
    };

    app = buildApp({
      db,
      keyring,
      adminToken: "admin-token-for-tests-0000000000",
      logLevel: "silent"
    });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  const batch = async (events: unknown[], query = ""): Promise<Record<string, unknown>> => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/events/batch${query}`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { events } as object
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const body: unknown = response.json();
    const typed = body as { data: { results: { status: string }[] } };
    for (const result of typed.data.results) {
      expect(result.status, JSON.stringify(result)).toBe("accepted");
    }
    return body as Record<string, unknown>;
  };

  const journeyColumns = async (journeyId: string): Promise<JourneyColumns | undefined> => {
    const row: unknown = await db("journeys")
      .where({ project_id: projectId, id: journeyId })
      .first(
        "label",
        "label_at",
        "label_event_id",
        "last_step",
        "last_step_at",
        "last_step_event_id"
      );
    return row as JourneyColumns | undefined;
  };

  const aliasColumns = async (journeyId: string): Promise<AliasColumns[]> => {
    const rows: unknown = await db("entity_aliases")
      .where({ project_id: projectId, journey_id: journeyId })
      .orderBy("alias_type")
      .select("alias_type", "displayable", "display_value");
    return rows as AliasColumns[];
  };

  it("keeps the label of the newest event, whatever order a batch holds them in", async () => {
    await batch([
      envelope({
        id: "evt_label_3",
        journeyId: "jrn_label",
        timestamp: "2026-09-16T10:00:03.000Z",
        name: "notify",
        journeyLabel: "Mirantis · Senior SWE, AI Infra"
      }),
      envelope({
        id: "evt_label_1",
        journeyId: "jrn_label",
        timestamp: "2026-09-16T10:00:01.000Z",
        name: "fetch",
        journeyLabel: "untitled posting"
      }),
      envelope({
        id: "evt_label_2",
        journeyId: "jrn_label",
        timestamp: "2026-09-16T10:00:02.000Z",
        name: "score"
      })
    ]);
    expect(await journeyColumns("jrn_label")).toEqual({
      label: "Mirantis · Senior SWE, AI Infra",
      label_at: new Date("2026-09-16T10:00:03.000Z"),
      label_event_id: "evt_label_3",
      last_step: "notify",
      last_step_at: new Date("2026-09-16T10:00:03.000Z"),
      last_step_event_id: "evt_label_3"
    });
  });

  describe("events that share a millisecond", () => {
    // The Node SDK stamps whole milliseconds and names events with random
    // UUIDs, so a quick journey's events tie on the timestamp, and a tie
    // broken by event id alone kept a random one: an earlier label after
    // label() was called again, or any of the steps as the last one. Ties
    // follow the order the server received the events, as the timeline does.
    const TIMESTAMP = "2026-09-16T10:00:00.000Z";

    /** What the SDK sends for label "old", three steps, and label "new" after the first. */
    const quickJourney = (journeyId: string): Record<string, unknown>[] => [
      envelope({
        id: randomUUID(),
        journeyId,
        timestamp: TIMESTAMP,
        name: "first",
        journeyLabel: "old"
      }),
      envelope({
        id: randomUUID(),
        journeyId,
        timestamp: TIMESTAMP,
        name: "second",
        journeyLabel: "new"
      }),
      envelope({
        id: randomUUID(),
        journeyId,
        timestamp: TIMESTAMP,
        name: "third",
        journeyLabel: "new"
      })
    ];

    const listed = async (): Promise<
      Map<string, { label: string | null; lastStep: string | null }>
    > => {
      const rows = new Map<string, { label: string | null; lastStep: string | null }>();
      let cursor: string | undefined;
      do {
        const response = await app.inject({
          method: "GET",
          url: `/v1/journeys?since=2026-09-16T00:00:00Z&limit=100${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
          headers: { authorization: `Bearer ${apiKey}` }
        });
        expect(response.statusCode, response.body).toBe(200);
        const page = response.json().data;
        for (const item of page.items) rows.set(item.journeyId, item);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return rows;
    };

    const timelineLastStep = async (journeyId: string): Promise<string | undefined> => {
      const response = await app.inject({
        method: "GET",
        url: `/v1/journeys/${journeyId}/events?limit=100`,
        headers: { authorization: `Bearer ${apiKey}` }
      });
      expect(response.statusCode, response.body).toBe(200);
      const body: { data: { items: { name: string }[] } } = response.json();
      return body.data.items.at(-1)?.name;
    };

    it.each(["in one batch", "one request at a time"])(
      "end with the later label and the last step received, %s",
      async (how) => {
        const journeys = Array.from(
          { length: 20 },
          (_, i) => `jrn_tie_${how === "in one batch" ? "batch" : "single"}_${String(i)}`
        );
        for (const journeyId of journeys) {
          const events = quickJourney(journeyId);
          if (how === "in one batch") await batch(events);
          else for (const event of events) await batch([event]);
        }
        const rows = await listed();
        for (const journeyId of journeys) {
          expect(rows.get(journeyId), journeyId).toEqual(
            expect.objectContaining({ label: "new", lastStep: "third" })
          );
          expect(await timelineLastStep(journeyId), journeyId).toBe("third");
        }
      }
    );
  });

  it("does not let a duplicate move anything", async () => {
    // The same event again is a duplicate: no summary update at all.
    const before = await journeyColumns("jrn_label");
    await batch([
      envelope({
        id: "evt_label_3",
        journeyId: "jrn_label",
        timestamp: "2026-09-16T10:00:03.000Z",
        name: "notify",
        journeyLabel: "Mirantis · Senior SWE, AI Infra"
      })
    ]);
    expect(await journeyColumns("jrn_label")).toEqual(before);
  });

  it("stores the value as sent for a displayable alias, and nothing for a masked one", async () => {
    await batch([
      envelope({
        id: "evt_alias_1",
        journeyId: "jrn_alias",
        aliases: {
          postingUrl: "https://boards.example/jobs/42",
          email: "person@example.com",
          company: "Mirantis"
        },
        displayableAliases: ["postingUrl", "company"]
      })
    ]);
    expect(await aliasColumns("jrn_alias")).toEqual([
      { alias_type: "company", displayable: true, display_value: "Mirantis" },
      { alias_type: "email", displayable: false, display_value: null },
      {
        alias_type: "postingUrl",
        displayable: true,
        display_value: "https://boards.example/jobs/42"
      }
    ]);

    // A later statement of the company without the flag masks it for good.
    await batch([
      envelope({
        id: "evt_alias_2",
        journeyId: "jrn_alias",
        aliases: { company: "Mirantis", email: "person@example.com" },
        displayableAliases: ["email"]
      })
    ]);
    expect(await aliasColumns("jrn_alias")).toEqual([
      { alias_type: "company", displayable: false, display_value: null },
      { alias_type: "email", displayable: false, display_value: null },
      {
        alias_type: "postingUrl",
        displayable: true,
        display_value: "https://boards.example/jobs/42"
      }
    ]);
  });

  it("accepts a displayable value holding a NUL, stores no copy of it, and keeps the rest", async () => {
    // A text column cannot hold a NUL. The value is stored encrypted, as it
    // was before copies existed, and the journey page shows it; the list and
    // its text filter, which read only the copy, do not.
    const value = `Acme${String.fromCharCode(0)}Corp`;
    await batch([
      envelope({
        id: "evt_nul_1",
        journeyId: "jrn_nul",
        aliases: { company: value, board: "greenhouse:acme" },
        displayableAliases: ["company", "board"]
      })
    ]);
    expect(await aliasColumns("jrn_nul")).toEqual([
      { alias_type: "board", displayable: true, display_value: "greenhouse:acme" },
      { alias_type: "company", displayable: true, display_value: null }
    ]);
    const read = await app.inject({
      method: "GET",
      url: "/v1/journeys/jrn_nul",
      headers: { authorization: `Bearer ${apiKey}` }
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().data.aliases).toContainEqual({
      type: "company",
      displayValue: value,
      displayable: true
    });

    // Stating it again still stores no copy, and masking it works.
    await batch([
      envelope({
        id: "evt_nul_2",
        journeyId: "jrn_nul",
        aliases: { company: value },
        displayableAliases: ["company"]
      })
    ]);
    expect(await aliasColumns("jrn_nul")).toContainEqual({
      alias_type: "company",
      displayable: true,
      display_value: null
    });
    await batch([envelope({ id: "evt_nul_3", journeyId: "jrn_nul", aliases: { company: value } })]);
    expect(await aliasColumns("jrn_nul")).toContainEqual({
      alias_type: "company",
      displayable: false,
      display_value: null
    });
  });

  it("stores a displayable value holding a lone surrogate as the journey page reads it", async () => {
    // PostgreSQL text takes UTF-8, and a lone surrogate has no UTF-8 form, so
    // the driver writes U+FFFD in its place, as the ciphertext's encoding
    // does. The copy and the value the journey page decrypts agree.
    const value = `Acme${String.fromCharCode(0xd800)}Corp`;
    await batch([
      envelope({
        id: "evt_surrogate",
        journeyId: "jrn_surrogate",
        aliases: { company: value },
        displayableAliases: ["company"]
      })
    ]);
    const read = await app.inject({
      method: "GET",
      url: "/v1/journeys/jrn_surrogate",
      headers: { authorization: `Bearer ${apiKey}` }
    });
    const shown = read.json().data.aliases[0]?.displayValue;
    expect(shown).toBe(`Acme${String.fromCharCode(0xfffd)}Corp`);
    expect(await aliasColumns("jrn_surrogate")).toEqual([
      { alias_type: "company", displayable: true, display_value: shown }
    ]);
  });

  it("keeps flag and copy together across rounds of concurrent events on one journey", async () => {
    // Each POST is its own transaction, so these race for real. Migration
    // 018's constraint refuses any row written masked with a copy, so even a
    // moment of disagreement inside a statement fails the event, and the
    // assertion that every event was accepted catches it.
    const found: unknown = await db.raw(
      "select convalidated from pg_constraint where conrelid = 'entity_aliases'::regclass and conname = ?",
      [ALIAS_DISPLAY_VALUE_CONSTRAINT]
    );
    expect((found as { rows: unknown[] }).rows).toEqual([{ convalidated: true }]);
    const rounds = 20;
    const perRound = 10;
    for (let round = 0; round < rounds; round += 1) {
      const journeyId = `jrn_race_${String(round)}`;
      const responses = await Promise.all(
        Array.from({ length: perRound }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/v1/events",
            headers: { authorization: `Bearer ${apiKey}` },
            payload: envelope({
              id: `evt_race_${String(round)}_${String(i)}`,
              journeyId,
              timestamp: new Date(Date.UTC(2026, 8, 16, 10, 0, i)).toISOString(),
              name: `step ${String(i)}`,
              journeyLabel: i % 2 === 0 ? `Label ${String(i)}` : undefined,
              aliases: { always: "shown", mixed: "sometimes", never: "hidden" },
              // "mixed" is masked by exactly one event, a different one each round.
              displayableAliases: i === round % perRound ? ["always"] : ["always", "mixed"]
            })
          })
        )
      );
      for (const response of responses) expect(response.statusCode, response.body).toBe(202);

      expect(await aliasColumns(journeyId), journeyId).toEqual([
        { alias_type: "always", displayable: true, display_value: "shown" },
        { alias_type: "mixed", displayable: false, display_value: null },
        { alias_type: "never", displayable: false, display_value: null }
      ]);
      expect(await journeyColumns(journeyId), journeyId).toMatchObject({
        label: "Label 8",
        label_event_id: `evt_race_${String(round)}_8`,
        last_step: "step 9",
        last_step_event_id: `evt_race_${String(round)}_9`
      });
    }

    const leaked: unknown = await db("entity_aliases")
      .where({ displayable: false })
      .whereNotNull("display_value")
      .count({ n: "*" });
    expect(Number((leaked as { n: string }[])[0]?.n)).toBe(0);
    const missing: unknown = await db("entity_aliases")
      .where({ displayable: true })
      .whereNull("display_value")
      .count({ n: "*" });
    expect(Number((missing as { n: string }[])[0]?.n)).toBe(0);
  });

  describe("a dry run", () => {
    const tables = async (): Promise<Record<string, unknown>> => ({
      journeys: await db("journeys").orderBy(["project_id", "id"]).select("*"),
      entity_aliases: await db("entity_aliases").orderBy("id").select("*"),
      journey_events: await db("journey_events").count({ n: "*" })
    });

    it("writes no label, last step or copy, to a journey that exists or one that does not", async () => {
      await batch([
        envelope({
          id: "evt_dry_seed",
          journeyId: "jrn_dry",
          timestamp: "2026-09-16T10:00:00.000Z",
          journeyLabel: "Before",
          aliases: { company: "Before Co" },
          displayableAliases: ["company"]
        })
      ]);
      const before = await tables();

      const previewed = await batch(
        [
          envelope({
            id: "evt_dry_newer",
            journeyId: "jrn_dry",
            timestamp: "2026-09-16T11:00:00.000Z",
            name: "later step",
            journeyLabel: "After",
            // Masks the existing copy, and adds a new displayable one.
            aliases: { company: "Before Co", site: "careers.example" },
            displayableAliases: ["site"]
          }),
          envelope({
            id: "evt_dry_new_journey",
            journeyId: "jrn_dry_new",
            journeyLabel: "Never stored",
            aliases: { site: "careers.example" },
            displayableAliases: ["site"]
          })
        ],
        "?dryRun=true"
      );
      expect((previewed["data"] as { dryRun: boolean }).dryRun).toBe(true);
      expect(await tables()).toEqual(before);
    });

    it("computes the same values a real send stores", async () => {
      // A dry run is ingestEvent in a transaction that is rolled back
      // (ADR-050), so what it would store is read inside that transaction and
      // compared with what the same events store for real.
      const events = [
        envelope({
          id: "evt_same_2",
          journeyId: "jrn_same",
          timestamp: "2026-09-16T10:00:02.000Z",
          name: "second",
          journeyLabel: "Second"
        }),
        envelope({
          id: "evt_same_1",
          journeyId: "jrn_same",
          timestamp: "2026-09-16T10:00:01.000Z",
          name: "first",
          journeyLabel: "First",
          aliases: { company: "Same Co", email: "x@example.com" },
          displayableAliases: ["company"]
        })
      ];

      const rollback = new Error("roll back");
      let previewed: { journey: JourneyColumns | undefined; aliases: AliasColumns[] } | undefined;
      await expect(
        db.transaction(async (trx) => {
          for (const one of events) {
            const result = await ingestEvent(trx, keyring, context, one);
            expect(result.status, JSON.stringify(result)).toBe("accepted");
          }
          const journey: unknown = await trx("journeys")
            .where({ project_id: projectId, id: "jrn_same" })
            .first(
              "label",
              "label_at",
              "label_event_id",
              "last_step",
              "last_step_at",
              "last_step_event_id"
            );
          const aliases: unknown = await trx("entity_aliases")
            .where({ project_id: projectId, journey_id: "jrn_same" })
            .orderBy("alias_type")
            .select("alias_type", "displayable", "display_value");
          previewed = {
            journey: journey as JourneyColumns | undefined,
            aliases: aliases as AliasColumns[]
          };
          throw rollback;
        })
      ).rejects.toBe(rollback);
      expect(await journeyColumns("jrn_same")).toBeUndefined();

      await batch(events);
      expect(previewed).toEqual({
        journey: await journeyColumns("jrn_same"),
        aliases: await aliasColumns("jrn_same")
      });
      expect(previewed?.journey?.label).toBe("Second");
      expect(previewed?.aliases).toEqual([
        { alias_type: "company", displayable: true, display_value: "Same Co" },
        { alias_type: "email", displayable: false, display_value: null }
      ]);
    });
  });
});
