import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import knex, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDoctor } from "./doctor.js";
import { insertReturningId } from "./insert.js";
import { createKnexConfig } from "./knex-config.js";
import { sampleSecretNames, secretNamesCheck } from "./secret-names.js";

/**
 * Doctor's secret-name check against real stored payloads (ADR-055): what it
 * reads, what it leaves out, that it never returns a value, and that its sample
 * is bounded and its statement cancelled.
 */

// Distinctive, so an assertion that output does not contain them cannot pass by
// accident.
const AUTH_VALUE = "stored-auth-value-4be1c07d";
const SESSION_VALUE = "stored-session-value-93a2e6f5";
const OLD_VALUE = "stored-old-value-1c55ab30";

describe("doctor's secret-name sample", () => {
  let container: StartedPostgreSqlContainer;
  let db: Knex;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    db = knex(createKnexConfig(container.getConnectionUri()));
    await db.migrate.latest();

    const projectId = await insertReturningId(db, "projects", { name: "S", slug: "s" });
    const environments: Record<string, string> = {};
    for (const name of ["production", "staging"]) {
      environments[name] = await insertReturningId(db, "environments", {
        project_id: projectId,
        name
      });
    }

    let journeyNumber = 0;
    const journey = async (environment: string, minutesAgo: number): Promise<string> => {
      journeyNumber += 1;
      const id = `jrn_${String(journeyNumber)}`;
      await db("journeys").insert({
        id,
        project_id: projectId,
        environment_id: environments[environment],
        entity_type: "customer",
        primary_entity_id_hash: `hash-${id}`,
        status: "active",
        started_at: db.raw(`now() - interval '${String(minutesAgo)} minutes'`),
        last_event_at: db.raw(`now() - interval '${String(minutesAgo)} minutes'`),
        event_count: 1
      });
      return id;
    };
    let eventNumber = 0;
    const event = (
      journeyId: string,
      environment: string,
      minutesAgo: number,
      payloads: { input?: unknown; output?: unknown; metadata?: unknown; error?: unknown }
    ): Record<string, unknown> => {
      eventNumber += 1;
      const id = `evt_${String(eventNumber)}`;
      return {
        id,
        project_id: projectId,
        environment_id: environments[environment],
        journey_id: journeyId,
        protocol_version: "0.1",
        content_hash: id,
        operation: "received",
        name: "step",
        service: "svc",
        event_timestamp: db.raw(`now() - interval '${String(minutesAgo)} minutes'`),
        input_payload: payloads.input === undefined ? null : JSON.stringify(payloads.input),
        output_payload: payloads.output === undefined ? null : JSON.stringify(payloads.output),
        custom_metadata: payloads.metadata === undefined ? null : JSON.stringify(payloads.metadata),
        error: payloads.error === undefined ? null : JSON.stringify(payloads.error)
      };
    };

    const production = await journey("production", 1);
    const staging = await journey("staging", 2);
    await db("journey_events").insert([
      event(production, "production", 1, {
        input: {
          authToken: AUTH_VALUE,
          password: "[REDACTED]",
          "x-auth-token": "",
          apiToken: { value: "kept-inside" },
          hasPassword: true,
          pinned: "yes",
          tokenCount: 7,
          nextPageToken: "page-2",
          lines: [{ settings: { sessionCredential: SESSION_VALUE } }]
        },
        metadata: { authToken: AUTH_VALUE }
      }),
      event(production, "production", 2, { output: { authToken: AUTH_VALUE, cardPin: 1234 } }),
      // Not read: `error` is not a payload a sender names keys in.
      event(staging, "staging", 2, { error: { message: "x", accessKeySecret: "e" } })
    ]);

    // One journey with more events than are sampled from it, where only the
    // oldest carry a secret-looking name.
    const busy = await journey("production", 3);
    const busyEvents = Array.from({ length: 25 }, (_unused, index) =>
      event(busy, "production", 100 - index, {
        input: index < 5 ? { staleSecret: OLD_VALUE } : { orderId: index }
      })
    );
    await db("journey_events").insert(busyEvents);
  });

  afterAll(async () => {
    await db.destroy();
    await container.stop();
  });

  it("returns candidate names with counts, and no value", async () => {
    const sample = await sampleSecretNames(db);
    // Two events in the first journey, one in the second, twenty of the busy one.
    expect(sample.events).toBe(23);
    const byName = Object.fromEntries(sample.names.map(({ name, events }) => [name, events]));
    expect(byName).toEqual({
      authToken: 2,
      sessionCredential: 1,
      cardPin: 1,
      // Candidates by their last three characters only (`secretvalue`,
      // `token`); the heuristic rejects both.
      nextPageToken: 1,
      value: 1
    });
    const text = JSON.stringify(sample);
    for (const value of [AUTH_VALUE, SESSION_VALUE, OLD_VALUE, "kept-inside"]) {
      expect(text).not.toContain(value);
    }
  });

  it("warns about the names the heuristic accepts, and prints no value", async () => {
    const result = await secretNamesCheck(db);
    expect(result.status).toBe("WARN");
    expect(result.detail).toBe(
      "3 key names that look like secrets hold plain values in the 23 most recent events sampled: authToken (in 2), cardPin (in 1), sessionCredential (in 1)."
    );
    const printed = formatDoctor([result]).join("\n");
    for (const value of [AUTH_VALUE, SESSION_VALUE, OLD_VALUE]) {
      expect(printed).not.toContain(value);
    }
  });

  it("warns, rather than fails or waits, when the sample is cancelled", async () => {
    const holder = knex(createKnexConfig(container.getConnectionUri()));
    try {
      await holder.transaction(async (trx) => {
        await trx.raw("lock table journey_events in access exclusive mode");
        const started = Date.now();
        const result = await secretNamesCheck(db);
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(result).toMatchObject({
          status: "WARN",
          detail: "The sample did not finish within 5 seconds, so it was not checked."
        });
      });
    } finally {
      await holder.destroy();
    }
  });
});
