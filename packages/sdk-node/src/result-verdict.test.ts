import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder, type Journey, type Recorder, type RecorderConfig } from "./index.js";

/**
 * What a wrapper records about a result: metadata computed from it, and the
 * reason a result that did not throw is a failure (F-003, F-004, ADR-060).
 *
 * `metadata` is copied when the wrapper is called, before the callback runs, so
 * an HTTP status or a `Retry-After` could not be metadata at all; and a result
 * `isFailure` refused always recorded the same generic error, so a 429 and a
 * 400 with a validation message read alike on the timeline.
 */

const base = {
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "development"
};

async function capture(
  run: (recorder: Recorder) => Promise<void> | void,
  extra: Partial<RecorderConfig> = {}
): Promise<{ events: Record<string, unknown>[]; diagnostics: Diagnostic[] }> {
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
  const diagnostics: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    onDiagnostic: (d) => diagnostics.push(d),
    ...extra
  });
  try {
    await run(recorder);
    await recorder.shutdown({ timeoutMs: 5_000 });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  return { events, diagnostics };
}

const journeyIn = (recorder: Recorder): Journey =>
  recorder.startJourney({ entity: { type: "customer", id: "1" } });

describe("metadataFrom", () => {
  it("records metadata computed from the result, over the static metadata", async () => {
    const { events } = await capture(async (recorder) => {
      await journeyIn(recorder).deliver(
        "push-crm",
        { id: "1" },
        () => Promise.resolve({ status: 429, headers: { "retry-after": "30" } }),
        {
          metadata: { host: "api.hubapi.com", status: "unknown" },
          metadataFrom: (result) => ({
            status: result.status,
            retryAfter: result.headers["retry-after"]
          })
        }
      );
    });
    // `attempt` is there because static metadata was given, exactly as before.
    expect(events[0]?.["metadata"]).toEqual({
      host: "api.hubapi.com",
      attempt: 1,
      status: 429,
      retryAfter: "30"
    });
  });

  it("is the only metadata when none was given, and receives the journey", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).transform("map", 1, () => 2, {
        metadataFrom: (result, journey) => ({ doubled: result, entity: journey.entity.type })
      });
    });
    expect(events[0]?.["metadata"]).toEqual({ doubled: 2, entity: "customer" });
  });

  it("keeps the attempt a retry records", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).transform("map", 1, () => 2, {
        attempt: 2,
        metadataFrom: () => ({ from: "result" })
      });
    });
    expect(events[0]?.["metadata"]).toEqual({ attempt: 2, from: "result" });
    expect(events[0]?.["operation"]).toBe("retried");
  });

  it("does not run when the callback throws, and the step is still recorded", async () => {
    let ran = 0;
    const { events } = await capture((recorder) => {
      expect(() =>
        journeyIn(recorder).transform(
          "map",
          1,
          () => {
            throw new Error("boom");
          },
          {
            metadata: { host: "h" },
            metadataFrom: () => {
              ran += 1;
              return { from: "result" };
            }
          }
        )
      ).toThrow("boom");
    });
    expect(ran).toBe(0);
    expect(events[0]?.["metadata"]).toEqual({ host: "h", attempt: 1 });
    expect(events[0]?.["error"]).toMatchObject({ message: "boom" });
  });

  it("cannot break the call when it throws: the step keeps its static metadata", async () => {
    const value = { id: 7 };
    let returned: unknown;
    const { events, diagnostics } = await capture((recorder) => {
      expect(() => {
        returned = journeyIn(recorder).transform("map", 1, () => value, {
          metadata: { host: "h" },
          metadataFrom: () => {
            throw new Error("projection failed");
          }
        });
      }).not.toThrow();
    });
    // The host's call is untouched: its value comes back and its step is sent.
    expect(returned).toBe(value);
    expect(events).toHaveLength(1);
    expect(events[0]?.["metadata"]).toEqual({ host: "h", attempt: 1 });
    expect(
      diagnostics.filter((d) => d.kind === "payload_omitted").map((d) => [d.code, d.detail.field])
    ).toEqual([["projection_failed", "metadata"]]);
    // The projection's own error can quote the payload, so it is never the reason.
    expect(
      diagnostics.find((d) => d.kind === "payload_omitted")?.reason.includes("projection failed")
    ).toBe(false);
  });

  it("is reported, and left off, when it returns a promise or something that is not an object", async () => {
    const { events, diagnostics } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      journey.transform("a", 1, () => 2, {
        metadataFrom: () => Promise.resolve({ a: 1 }) as never
      });
      journey.transform("b", 1, () => 2, { metadataFrom: () => 7 as never });
    });
    expect(events.every((event) => !("metadata" in event))).toBe(true);
    expect(diagnostics.filter((d) => d.kind === "payload_omitted")).toHaveLength(2);
  });

  it("runs once per journey in a group, with that journey's context", async () => {
    const { events } = await capture((recorder) => {
      const one = recorder.startJourney({ entity: { type: "customer", id: "1" } });
      const two = recorder.startJourney({ entity: { type: "customer", id: "2" } });
      recorder.across([one, two]).persist("write-digest", {}, () => "ok", {
        metadataFrom: (result, journey) => ({ result, for: journey.entity.id })
      });
    });
    expect(events.map((event) => event["metadata"])).toEqual([
      { result: "ok", for: "1" },
      { result: "ok", for: "2" }
    ]);
  });
});

describe("a reason on a failed result", () => {
  it("puts an object's message and code on the recorded error", async () => {
    const { events } = await capture(async (recorder) => {
      await journeyIn(recorder).deliver("push-crm", {}, () => Promise.resolve({ status: 429 }), {
        isFailure: (result) =>
          result.status >= 400 ? { message: "HubSpot rate limited", code: "http_429" } : false
      });
    });
    expect(events[0]?.["error"]).toEqual({
      message: "HubSpot rate limited",
      code: "http_429"
    });
  });

  it("takes a string as the message, keeping the generic code", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).transform("check", 1, () => 2, {
        isFailure: () => "the ledger did not balance"
      });
    });
    expect(events[0]?.["error"]).toEqual({
      message: "the ledger did not balance",
      code: "result_failed"
    });
  });

  it("keeps today's generic text for true, and records nothing for false", async () => {
    const { events } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      journey.transform("yes", 1, () => 2, { isFailure: () => true });
      journey.transform("no", 1, () => 2, { isFailure: () => false });
    });
    expect(events[0]?.["error"]).toEqual({
      message: "yes reported a failed result.",
      code: "result_failed"
    });
    expect(events[1]).not.toHaveProperty("error");
  });

  it("falls back to the generic text for a reason it cannot use", async () => {
    const { events } = await capture((recorder) => {
      const journey = journeyIn(recorder);
      journey.transform("a", 1, () => 2, { isFailure: () => ({ code: "http_429" }) });
      journey.transform("b", 1, () => 2, { isFailure: () => ({ message: 7 }) as never });
    });
    expect(events[0]?.["error"]).toEqual({
      message: "a reported a failed result.",
      code: "http_429"
    });
    expect(events[1]?.["error"]).toEqual({
      message: "b reported a failed result.",
      code: "result_failed"
    });
  });

  it("masks and bounds a reason, as it does any error the host gives", async () => {
    const { events } = await capture((recorder) => {
      journeyIn(recorder).transform("t", 1, () => 2, {
        isFailure: () => ({ message: "refused for postgres://app:hunter2@db/app" })
      });
    });
    expect(JSON.stringify(events[0]?.["error"])).not.toContain("hunter2");
  });

  it("cannot break the call when isFailure throws, and still records the step", async () => {
    const value = { id: 7 };
    let returned: unknown;
    const { events, diagnostics } = await capture((recorder) => {
      expect(() => {
        returned = journeyIn(recorder).transform("t", 1, () => value, {
          isFailure: () => {
            throw new Error("verdict failed");
          }
        });
      }).not.toThrow();
    });
    expect(returned).toBe(value);
    // The step is recorded as a success: the SDK cannot know it failed.
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("error");
    expect(diagnostics.filter((d) => d.kind === "capture_error").map((d) => d.code)).toContain(
      "unexpected_error"
    );
  });
});
