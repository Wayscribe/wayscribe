import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Counters } from "./diagnostics.js";
import { createRecorder, type Journey, type Recorder } from "./index.js";

/**
 * One operation, recorded on every journey it touched, in one call.
 *
 * A digest written once for a hundred records is one write, and each record's
 * timeline should show it. Before `across`, a host looped over `record()` and
 * gave up the wrappers: the callback's value, its exact error, and a single
 * timing for all of them.
 */

async function withRecorder(
  run: (recorder: Recorder) => Promise<void> | void
): Promise<{ events: Record<string, unknown>[]; counters: Counters }> {
  const events: Record<string, unknown>[] = [];
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      const parsed = JSON.parse(body) as { events: { event: Record<string, unknown> }[] };
      events.push(...parsed.events.map((entry) => entry.event));
      response.writeHead(202, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: { results: parsed.events.map(() => ({ status: "accepted" })) } })
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const recorder = createRecorder({
      endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      apiKey: "fr_test",
      serviceName: "digest",
      environment: "development"
    });
    await run(recorder);
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    return { events, counters };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const postings = (recorder: Recorder, count: number): Journey[] =>
  Array.from({ length: count }, (_unused, index) =>
    recorder.startJourney({ entity: { type: "posting", id: `p${String(index)}` } })
  );

describe("recorder.across", () => {
  it("records one event per journey, each with its own id, with shared timing", async () => {
    let calls = 0;
    let returned: unknown;
    const { events } = await withRecorder((recorder) => {
      const journeys = postings(recorder, 3);
      returned = recorder.across(journeys).persist("write-digest", { lines: 3 }, () => {
        calls += 1;
        return "digest.md";
      });
    });

    expect(returned).toBe("digest.md");
    expect(calls).toBe(1);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event["id"])).size).toBe(3);
    expect(new Set(events.map((event) => event["journeyId"])).size).toBe(3);
    expect(events.map((event) => (event["entity"] as { id: string }).id).sort()).toEqual([
      "p0",
      "p1",
      "p2"
    ]);
    expect(new Set(events.map((event) => event["timestamp"])).size).toBe(1);
    expect(new Set(events.map((event) => event["durationMs"])).size).toBe(1);
    for (const event of events) {
      expect(event).toMatchObject({
        operation: "persisted",
        name: "write-digest",
        input: { lines: 3 },
        output: "digest.md"
      });
    }
  });

  it("stays synchronous for a synchronous callback and rethrows its exact error", async () => {
    const thrown = new Error("disk full");
    const { events } = await withRecorder((recorder) => {
      const group = recorder.across(postings(recorder, 2));
      expect(() =>
        group.deliver("write", {}, () => {
          throw thrown;
        })
      ).toThrow(thrown);
    });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event["error"]).toMatchObject({ message: "disk full" });
    }
  });

  it("resolves to the callback's value, and rejects with its exact error", async () => {
    const thrown = new Error("remote down");
    await withRecorder(async (recorder) => {
      const group = recorder.across(postings(recorder, 2));
      await expect(group.publish("p", {}, () => Promise.resolve(42))).resolves.toBe(42);
      await expect(group.transform("t", {}, () => Promise.reject(thrown))).rejects.toBe(thrown);
    });
  });

  it("records a journey named twice once", async () => {
    const { events } = await withRecorder((recorder) => {
      const [first, second] = postings(recorder, 2);
      if (first === undefined || second === undefined) throw new Error("setup");
      recorder.across([first, second, first, first.context()]).record({
        operation: "delivered",
        name: "notify"
      });
    });
    expect(events).toHaveLength(2);
  });

  it("runs the callback and records nothing for an empty group", async () => {
    let ran = false;
    const { events, counters } = await withRecorder((recorder) => {
      expect(
        recorder.across([]).persist("write", {}, () => {
          ran = true;
          return 1;
        })
      ).toBe(1);
    });
    expect(ran).toBe(true);
    expect(events).toEqual([]);
    expect(counters.sent).toBe(0);
  });

  it("gives each journey's projection its own context", async () => {
    const lines: Record<string, string> = { p0: "line zero", p1: "line one" };
    const { events } = await withRecorder((recorder) => {
      recorder.across(postings(recorder, 2)).persist("write-digest", "whole digest", () => true, {
        captureInput: (_input, journey) => lines[journey.entity.id]
      });
    });
    const byEntity = Object.fromEntries(
      events.map((event) => [(event["entity"] as { id: string }).id, event["input"]])
    );
    expect(byEntity).toEqual({ p0: "line zero", p1: "line one" });
  });

  it("fans out record, fail and finish, with one timestamp each", async () => {
    const { events } = await withRecorder((recorder) => {
      const group = recorder.across(postings(recorder, 2));
      group.record({ operation: "validated", name: "check", metadata: { rule: "r1" } });
      group.fail("run-failed", new Error("the sweep died"));
      group.finish({ status: "completed" });
    });
    expect(events).toHaveLength(6);
    for (const name of ["check", "run-failed", "finish"]) {
      const named = events.filter((event) => event["name"] === name);
      expect(named).toHaveLength(2);
      expect(new Set(named.map((event) => event["timestamp"])).size).toBe(1);
    }
    expect(events.filter((event) => event["operation"] === "failed")).toHaveLength(2);
    expect(events.filter((event) => event["operation"] === "completed")).toHaveLength(2);
  });

  it("lists the journeys it records on", () => {
    const recorder = createRecorder({
      endpoint: "http://127.0.0.1:1",
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development"
    });
    const journeys = postings(recorder, 2);
    expect(recorder.across(journeys).journeys()).toEqual(journeys.map((one) => one.context()));
  });

  it("does not break the host when handed something that is not a journey", () => {
    const recorder = createRecorder({
      endpoint: "http://127.0.0.1:1",
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development"
    });
    const group = recorder.across([null, 7, {}] as unknown as []);
    expect(group.transform("t", {}, () => "still runs")).toBe("still runs");
    expect(recorder.diagnostics().captureErrors).toBeGreaterThan(0);
  });
});
