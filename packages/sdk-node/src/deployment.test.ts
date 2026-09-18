import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { journeyEventSchema } from "@wayscribe/protocol";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder, type Recorder, type RecorderConfig } from "./index.js";

/**
 * The deployment a service is running, on every event it records (F-002,
 * ADR-060).
 *
 * The wire protocol has carried `deployment` since the first release and the
 * API stores it as `deployment_metadata`, but no Node service could set it, so
 * "which build did this?" could not be answered from a timeline.
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

describe("deployment", () => {
  it("is on every event the recorder sends, and the server's schema accepts it", async () => {
    const { events } = await capture(
      (recorder) => {
        const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
        journey.record({ operation: "received", name: "r" });
        journey.transform("t", 1, () => 2);
        journey.identify({ crmId: "c1" });
        journey.finish();
      },
      { deployment: { version: "1.4.2", gitCommit: "27f4d64" } }
    );
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event["deployment"]).toEqual({ version: "1.4.2", gitCommit: "27f4d64" });
      expect(journeyEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("is absent when it is not configured", async () => {
    const { events } = await capture((recorder) => {
      recorder
        .startJourney({ entity: { type: "customer", id: "1" } })
        .record({ operation: "received", name: "r" });
    });
    expect(events[0]).not.toHaveProperty("deployment");
  });

  it("carries only the fields the protocol has, and reports the rest", async () => {
    const { events, diagnostics } = await capture(
      (recorder) => {
        recorder
          .startJourney({ entity: { type: "customer", id: "1" } })
          .record({ operation: "received", name: "r" });
      },
      {
        deployment: {
          image: "registry.example/app:1.4.2",
          release: "canary"
        } as RecorderConfig["deployment"]
      }
    );
    expect(events[0]?.["deployment"]).toEqual({ image: "registry.example/app:1.4.2" });
    expect(
      diagnostics.filter((d) => d.kind === "configuration_error").map((d) => d.detail)
    ).toEqual([{ setting: "deployment" }]);
  });

  it("is left off, and reported, when a field is not a usable string", async () => {
    const { events, diagnostics } = await capture(
      (recorder) => {
        recorder
          .startJourney({ entity: { type: "customer", id: "1" } })
          .record({ operation: "received", name: "r" });
      },
      { deployment: { version: 7 as unknown as string, gitCommit: "a".repeat(200) } }
    );
    expect(events[0]).not.toHaveProperty("deployment");
    const reported = diagnostics.filter((d) => d.kind === "configuration_error");
    expect(reported.map((d) => d.detail)).toEqual([{ setting: "deployment" }]);
    // The value is never quoted back.
    expect(JSON.stringify(reported)).not.toContain("aaaa");
  });

  it("never throws out of createRecorder, whatever it is given", async () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error("no");
        }
      }
    ) as RecorderConfig["deployment"];
    const { events, diagnostics } = await capture(
      (recorder) => {
        recorder
          .startJourney({ entity: { type: "customer", id: "1" } })
          .record({ operation: "received", name: "r" });
      },
      { deployment: hostile }
    );
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("deployment");
    expect(
      diagnostics.some((d) => d.kind === "configuration_error" && d.detail.setting === "deployment")
    ).toBe(true);
  });

  it("is a copy, so changing the object afterwards changes no event", async () => {
    const deployment = { version: "1.0.0" };
    const { events } = await capture(
      (recorder) => {
        deployment.version = "2.0.0";
        recorder
          .startJourney({ entity: { type: "customer", id: "1" } })
          .record({ operation: "received", name: "r" });
      },
      { deployment }
    );
    expect(events[0]?.["deployment"]).toEqual({ version: "1.0.0" });
  });
});
