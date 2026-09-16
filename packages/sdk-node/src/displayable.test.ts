import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createRecorder, type Recorder } from "./index.js";

/**
 * Marking aliases as displayable (ADR-053).
 *
 * Every alias is masked when read, because a reader may not be entitled to see
 * other identifiers. Instrumenting code can list the alias types that are safe
 * to show in full; the list travels on the event beside the aliases.
 */

async function sent(run: (recorder: Recorder) => void): Promise<Record<string, unknown>[]> {
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
      serviceName: "svc",
      environment: "development"
    });
    run(recorder);
    await recorder.shutdown({ timeoutMs: 5_000 });
    return events;
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const entity = { type: "job_posting", id: "greenhouse:4567" };
const aliases = { postingId: "greenhouse:4567", recruiterEmail: "someone@example.com" };

describe("displayable aliases", () => {
  it("identify sends the types it was told may be shown", async () => {
    const events = await sent((recorder) => {
      recorder.startJourney({ entity }).identify(aliases, { displayableAliases: ["postingId"] });
    });
    expect(events[0]).toMatchObject({
      operation: "identified",
      aliases,
      displayableAliases: ["postingId"]
    });
  });

  it("sends nothing extra by default, so every alias stays masked", async () => {
    const events = await sent((recorder) => {
      recorder.startJourney({ entity }).identify(aliases);
    });
    expect(events[0]).not.toHaveProperty("displayableAliases");
  });

  it("startJourney passes the list to the identify it makes", async () => {
    const events = await sent((recorder) => {
      recorder.startJourney({ entity, aliases, displayableAliases: ["postingId"] });
    });
    expect(events[0]).toMatchObject({ aliases, displayableAliases: ["postingId"] });
  });

  it("record carries the wire field as it is", async () => {
    const events = await sent((recorder) => {
      recorder.startJourney({ entity }).record({
        operation: "received",
        name: "fetch",
        aliases,
        displayableAliases: ["postingId"]
      });
    });
    expect(events[0]).toMatchObject({ displayableAliases: ["postingId"] });
  });

  it("copies the list, so a later change to the caller's array is not recorded", async () => {
    const events = await sent((recorder) => {
      const displayable = ["postingId"];
      recorder.startJourney({ entity }).identify(aliases, { displayableAliases: displayable });
      displayable.push("recruiterEmail");
    });
    expect(events[0]?.["displayableAliases"]).toEqual(["postingId"]);
  });

  it("drops what cannot be a list of alias types rather than losing the event", async () => {
    const events = await sent((recorder) => {
      const journey = recorder.startJourney({ entity });
      journey.identify(aliases, { displayableAliases: "postingId" as unknown as string[] });
      journey.identify(aliases, { displayableAliases: ["postingId", 7 as unknown as string] });
    });
    expect(events).toHaveLength(2);
    expect(events[0]).not.toHaveProperty("displayableAliases");
    expect(events[1]?.["displayableAliases"]).toEqual(["postingId"]);
  });
});
