import type { ApiKeyContext } from "@wayscribe/database";
import { captureCase } from "@wayscribe/node/conformance-harness";
import { createKeyring } from "@wayscribe/payload-security";
import type { ConformanceCase } from "@wayscribe/protocol/conformance";
import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { ingestEvent } from "./ingest-event.js";

/**
 * The SDK and ingestion agree about limits, checked by running the same inputs
 * through both.
 *
 * Each input goes through the real recorder, which fits it, and the envelope
 * it put on the wire goes through `ingestEvent`. Nothing may be refused by a
 * limit. Before ADR-051 the recorder applied its own reading of the limits, and
 * a 70,000 character string, two payloads that fit alone, or a payload 31 levels
 * deep all left the SDK and were refused here, losing the event.
 *
 * `ingestEvent` checks limits and validates before it touches the database, so
 * a database that throws a sentinel on first use marks the point where an
 * event has passed every check this test is about.
 */

class PassedChecks extends Error {}

const database = {
  transaction: () => Promise.reject(new PassedChecks("passed the limit and validation checks"))
} as unknown as Knex;

const keyring = createKeyring("a".repeat(64));

const context: ApiKeyContext = {
  id: "key",
  projectId: "project",
  environmentId: "environment",
  environmentName: "conformance",
  keyHash: "hash",
  keyHashKeyId: null,
  revokedAt: null,
  captureMode: "redacted-payload",
  redactionPaths: [],
  captureAllowlist: []
};

const nest = (depth: number, leaf: unknown = "leaf"): unknown => {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) value = { n: value };
  return value;
};
const wide = (keys: number): Record<string, number> =>
  Object.fromEntries(
    Array.from({ length: keys }, (_unused, index) => [`k${String(index)}`, index])
  );
const repeat = (text: string, count: number): string => text.repeat(count);

/** Record arguments that break at least one limit as they stand. */
const HOSTILE: Record<string, Record<string, unknown>> = {
  "a string at the limit": { input: repeat("a", 65_536) },
  "a string one over": { input: repeat("a", 65_537) },
  "a 70,000 character string": { input: { note: repeat("a", 70_000) } },
  "a megabyte string": { output: repeat("m", 1_000_000) },
  "an emoji split by the cut": { input: `${repeat("a", 65_499)}${repeat("😀", 5_000)}` },
  "two-byte characters": { input: { t: repeat("é", 70_000) } },
  "four long strings": { input: Array.from({ length: 4 }, () => repeat("f", 70_000)) },
  "five long strings": { input: Array.from({ length: 5 }, () => repeat("f", 70_000)) },
  "a thousand short strings over the budget": {
    input: Array.from({ length: 1_000 }, () => repeat("s", 300))
  },
  "depth 30": { input: nest(30) },
  "depth 31": { input: nest(31) },
  "depth 31 in output": { output: nest(31) },
  "depth 31 in metadata": { metadata: { deep: nest(30) } },
  "a thousand keys": { input: wide(1_000) },
  "a thousand and one keys": { input: wide(1_001) },
  "a thousand and one metadata keys": { metadata: wide(1_001) },
  "two payloads that fit alone": {
    input: { a: repeat("i", 60_000), b: repeat("i", 60_000), c: repeat("i", 25_000) },
    output: { a: repeat("o", 60_000), b: repeat("o", 60_000) }
  },
  "three payloads that fit alone": {
    input: { a: repeat("i", 60_000), b: repeat("i", 30_000) },
    output: { a: repeat("o", 60_000), b: repeat("o", 30_000) },
    metadata: { a: repeat("m", 60_000), b: repeat("m", 30_000) }
  },
  "a long string beside a long header block": {
    input: {
      header: `GET / HTTP/1.1\r\nauthorization: Bearer ${repeat("t", 70_000)}\r\n\r\n`,
      body: repeat("b", 70_000)
    }
  },
  "a long string inside a Map": { input: { $map: { note: repeat("q", 70_000) } } }
};

function caseFor(name: string, args: Record<string, unknown>, recorder: unknown): ConformanceCase {
  return {
    id: `agreement/${name}`,
    title: name,
    source: "ADR-051",
    layer: "sdk",
    languages: ["*"],
    recorder: recorder as Record<string, unknown>,
    calls: [{ call: "record", args: { operation: "received", name: "hostile", ...args } }],
    expect: { results: [] }
  };
}

describe("the SDK sends only what ingestion's limits accept", () => {
  describe.each([262_144, 20_000])("with a budget of %i bytes", (budget) => {
    it.each(Object.entries(HOSTILE))("%s", async (name, args) => {
      const captured = await captureCase(
        caseFor(name, args, { maxEventBytes: budget }),
        "agreement"
      );
      expect(captured.events).toHaveLength(1);

      const body = { protocolVersion: "0.1", event: captured.events[0] };
      const verdict = await ingestEvent(database, keyring, context, body, budget).then(
        (result) => result,
        (error: unknown) => (error instanceof PassedChecks ? "passed" : error)
      );
      expect(verdict).toBe("passed");
    });
  });

  it("uses inputs that the server refuses as they stand", async () => {
    // The control: inputs that were never hostile would make the test above
    // pass against any SDK at all.
    let refused = 0;
    for (const [name, args] of Object.entries(HOSTILE)) {
      if (name === "a string at the limit" || name === "depth 30" || name === "a thousand keys") {
        continue;
      }
      if (name === "a long string inside a Map") {
        refused += 1;
        continue;
      }
      const body = {
        protocolVersion: "0.1",
        event: {
          id: "evt_raw",
          journeyId: "jrn_raw",
          environment: "conformance",
          service: "svc",
          entity: { type: "customer", id: "1" },
          operation: "received",
          name: "hostile",
          timestamp: "2026-09-16T00:00:00.000Z",
          ...args
        }
      };
      const result = await ingestEvent(database, keyring, context, body).catch(() => undefined);
      if (result?.status === "rejected") refused += 1;
      else throw new Error(`${name} is not refused as it stands`);
    }
    expect(refused).toBe(Object.keys(HOSTILE).length - 3);
  });
});
