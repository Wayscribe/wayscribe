import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createKnexConfig, insertReturningId, issueKey } from "@wayscribe/database";
import { createKeyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { buildApp } from "../app.js";

const keyring = createKeyring("0123456789abcdef0123456789abcdef");
const ADMIN_TOKEN = "admin-token-for-tests-0000000000";

interface Alias {
  type: string;
  displayValue: string | null;
  displayable: boolean;
}

/**
 * F-042: `GET /v1/events/:id` for an `identified` event returned no alias of
 * any kind, so the one thing that operation exists to record was the one thing
 * its own detail did not show. Aliases were stored per journey, with nothing
 * saying which event stated them.
 *
 * An event now carries the aliases it stated, masked exactly as the journey
 * detail masks them (ADR-053): the same objects, from the same rows.
 */
describe("the aliases an event stated", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;
  let app: FastifyInstance;
  let apiKey: string;
  let otherKey: string;

  const event = (id: string, journeyId: string, extra: Record<string, unknown> = {}) => ({
    id,
    journeyId,
    environment: "development",
    service: "crm-sync",
    entity: { type: "lead", id: `${journeyId}-lead` },
    operation: "identified",
    name: "identify-crm",
    timestamp: "2026-09-18T10:00:00.000Z",
    ...extra
  });

  const ingest = async (body: Record<string, unknown>, key = apiKey): Promise<void> => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${key}` },
      payload: { protocolVersion: "0.1", event: body } as object
    });
    expect(response.statusCode, response.body).toBe(202);
  };

  const read = async (url: string, key = apiKey) => {
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${key}` }
    });
    return response;
  };

  const eventAliases = async (id: string): Promise<Alias[] | null> => {
    const response = await read(`/v1/events/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data as { aliases?: Alias[] | null };
    expect(data, "the event read has no aliases field").toHaveProperty("aliases");
    return data.aliases ?? null;
  };

  const journeyAliases = async (journeyId: string): Promise<Alias[]> => {
    const response = await read(`/v1/journeys/${journeyId}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().data.aliases as Alias[];
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(inject("postgresImage")).start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    await insertReturningId(db, "projects", { name: "Acme", slug: "acme" });
    apiKey = (
      await issueKey(db, keyring, {
        projectSlug: "acme",
        environmentName: "development",
        name: "d"
      })
    ).apiKey;
    otherKey = (
      await issueKey(db, keyring, { projectSlug: "acme", environmentName: "production", name: "p" })
    ).apiKey;

    app = buildApp({ db, keyring, adminToken: ADMIN_TOKEN, logLevel: "silent" });
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
    await container.stop();
  });

  it("shows what an identified event identified, masked as the journey shows it", async () => {
    await ingest(event("evt_start", "jrn_a", { operation: "received", name: "receive-form" }));
    await ingest(
      event("evt_identify", "jrn_a", {
        aliases: { crmContactId: "C-000123456", email: "person@example.test" },
        displayableAliases: ["crmContactId"]
      })
    );

    const stated = await eventAliases("evt_identify");
    expect(stated).toEqual([
      { type: "crmContactId", displayValue: "C-000123456", displayable: true },
      { type: "email", displayValue: expect.stringContaining("…"), displayable: false }
    ]);
    // Exactly the journey's objects for the same aliases, masking included.
    expect(stated).toEqual(await journeyAliases("jrn_a"));
    expect(JSON.stringify(stated)).not.toContain("person@example.test");
  });

  it("is empty for an event that stated no alias", async () => {
    expect(await eventAliases("evt_start")).toEqual([]);
  });

  it("lists only what this event stated, not every alias of its journey", async () => {
    await ingest(event("evt_b1", "jrn_b", { aliases: { email: "first@example.test" } }));
    await ingest(
      event("evt_b2", "jrn_b", {
        aliases: { crmContactId: "C-000999999" },
        displayableAliases: ["crmContactId"],
        timestamp: "2026-09-18T10:01:00.000Z"
      })
    );
    expect((await eventAliases("evt_b1"))?.map((alias) => alias.type)).toEqual(["email"]);
    expect(await eventAliases("evt_b2")).toEqual([
      { type: "crmContactId", displayValue: "C-000999999", displayable: true }
    ]);
    expect(await journeyAliases("jrn_b")).toHaveLength(2);
  });

  it("tells two values of one alias type apart", async () => {
    // A journey can hold two values of one type, stated by different events.
    // Matching on the type would give each event both.
    await ingest(
      event("evt_c1", "jrn_c", {
        aliases: { postingId: "greenhouse:1111" },
        displayableAliases: ["postingId"]
      })
    );
    await ingest(
      event("evt_c2", "jrn_c", {
        aliases: { postingId: "greenhouse:2222" },
        displayableAliases: ["postingId"],
        timestamp: "2026-09-18T10:01:00.000Z"
      })
    );
    expect(await eventAliases("evt_c1")).toEqual([
      { type: "postingId", displayValue: "greenhouse:1111", displayable: true }
    ]);
    expect(await eventAliases("evt_c2")).toEqual([
      { type: "postingId", displayValue: "greenhouse:2222", displayable: true }
    ]);
  });

  it("follows the journey when a later event masks the alias", async () => {
    // ADR-053: displayable only while every statement says so. The event that
    // marked it displayable must not keep showing it in full once another
    // statement masked it, or the event read would unmask what the journey
    // read masks.
    await ingest(
      event("evt_d1", "jrn_d", {
        aliases: { crmContactId: "C-000555555" },
        displayableAliases: ["crmContactId"]
      })
    );
    expect((await eventAliases("evt_d1"))?.[0]?.displayValue).toBe("C-000555555");
    await ingest(
      event("evt_d2", "jrn_d", {
        aliases: { crmContactId: "C-000555555" },
        timestamp: "2026-09-18T10:01:00.000Z"
      })
    );
    const masked = [{ type: "crmContactId", displayValue: "C-00…555", displayable: false }];
    expect(await journeyAliases("jrn_d")).toEqual(masked);
    expect(await eventAliases("evt_d1")).toEqual(masked);
    expect(await eventAliases("evt_d2")).toEqual(masked);
  });

  it("answers the same for a resent event, which is a duplicate", async () => {
    const body = event("evt_e1", "jrn_e", { aliases: { email: "again@example.test" } });
    await ingest(body);
    const first = await eventAliases("evt_e1");
    await ingest(body);
    expect(await eventAliases("evt_e1")).toEqual(first);
    expect(first).toHaveLength(1);
  });

  it("is null for an event stored before the server recorded what events stated", async () => {
    // What an older build wrote, and what the previous API writes during a
    // rolling upgrade: an event row with no record of its aliases. Null says
    // "not recorded", which an empty list would deny.
    await ingest(event("evt_old", "jrn_old", { aliases: { email: "old@example.test" } }));
    await db("journey_events").where({ id: "evt_old" }).update({ stated_alias_ids: null });
    expect(await eventAliases("evt_old")).toBeNull();
    // The journey still has the alias.
    expect(await journeyAliases("jrn_old")).toHaveLength(1);
  });

  it("previews the aliases in a dry run, as the read would show them", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/events/batch?dryRun=true",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        events: [
          {
            protocolVersion: "0.1",
            event: event("evt_dry", "jrn_dry", {
              aliases: { crmContactId: "C-000777777" },
              displayableAliases: ["crmContactId"]
            })
          }
        ]
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    const stored = response.json().data.results[0].stored;
    expect(stored.event.aliases).toEqual([
      { type: "crmContactId", displayValue: "C-000777777", displayable: true }
    ]);
    expect(stored.event.aliases).toEqual(stored.journey.aliases);
  });

  it("stores events of one journey that list the same aliases in opposite orders at once", async () => {
    // The aliases are written before the event now. Two events of one
    // journey that listed the same aliases in opposite orders would take
    // their row locks in opposite orders and deadlock, but for the journey
    // row lock each takes first, which serializes them.
    const bodies = Array.from({ length: 40 }, (_, index) => {
      const pairs: [string, string][] = [
        ["alpha", `alpha-${String(index % 3)}`],
        ["bravo", `bravo-${String(index % 3)}`],
        ["charlie", `charlie-${String(index % 3)}`]
      ];
      return event(`evt_race_${String(index)}`, "jrn_race", {
        aliases: Object.fromEntries(index % 2 === 0 ? pairs : [...pairs].reverse()),
        timestamp: `2026-09-18T10:${String(index).padStart(2, "0")}:00.000Z`
      });
    });
    const responses = await Promise.all(
      bodies.map((body) =>
        app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { authorization: `Bearer ${apiKey}` },
          payload: { protocolVersion: "0.1", event: body } as object
        })
      )
    );
    expect(responses.map((response) => response.statusCode)).toEqual(bodies.map(() => 202));
    expect((await eventAliases("evt_race_1"))?.map((alias) => alias.type)).toEqual([
      "alpha",
      "bravo",
      "charlie"
    ]);
  });

  it("races a dry run of several events of one journey against real events for it", async () => {
    // A dry run stores its whole batch in one transaction and rolls it back,
    // so it holds the locks of its first event while it stores the second.
    // With alias rows locked before the journey row, a real event held a new
    // alias row and waited on the journey row the dry run's first event
    // held, while the dry run's second event waited on that alias row:
    // PostgreSQL broke the deadlock by failing one of them, a 500 for the
    // real event or a refused dry-run result. Taking the journey row first,
    // as every writer does, serializes them.
    const aliases = { alpha: "alpha-1", bravo: "bravo-1", charlie: "charlie-1" };
    await ingest(event("evt_dry_race_seed", "jrn_dry_race", { aliases }));
    for (let round = 0; round < 15; round += 1) {
      const dryRun = app.inject({
        method: "POST",
        url: "/v1/events/batch?dryRun=true",
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          events: [0, 1, 2].map((index) => ({
            protocolVersion: "0.1",
            event: event(`evt_dry_race_${String(round)}_${String(index)}`, "jrn_dry_race", {
              // One alias per event, new each round, which a real event
              // states too: the dry run's first event holds the journey row
              // while a real event holds the alias its second event needs.
              aliases: { step: `step-${String(round)}-${String(index)}` },
              timestamp: `2026-09-18T11:${String(round).padStart(2, "0")}:0${String(index)}.000Z`
            })
          }))
        }
      });
      const real = [0, 1, 2, 3].map((index) =>
        app.inject({
          method: "POST",
          url: "/v1/events",
          headers: { authorization: `Bearer ${apiKey}` },
          payload: {
            protocolVersion: "0.1",
            event: event(`evt_real_race_${String(round)}_${String(index)}`, "jrn_dry_race", {
              aliases: { step: `step-${String(round)}-${String(3 - index)}` },
              timestamp: `2026-09-18T12:${String(round).padStart(2, "0")}:0${String(index)}.000Z`
            })
          } as object
        })
      );
      const [dry, ...reals] = await Promise.all([dryRun, ...real]);
      expect(
        reals.map((response) => response.statusCode),
        `round ${String(round)}`
      ).toEqual([202, 202, 202, 202]);
      expect(dry.statusCode, dry.body).toBe(200);
      expect(
        (dry.json().data.results as { status: string }[]).map((result) => result.status),
        dry.body
      ).toEqual(["accepted", "accepted", "accepted"]);
    }
  });

  it("is read within the caller's scope, as the event is", async () => {
    await ingest(
      event("evt_prod", "jrn_prod", {
        environment: "production",
        aliases: { email: "p@example.test" }
      }),
      otherKey
    );
    expect((await read("/v1/events/evt_prod", apiKey)).statusCode).toBe(404);
    const own = await read("/v1/events/evt_prod", otherKey);
    expect(own.json().data.aliases).toHaveLength(1);
  });
});
