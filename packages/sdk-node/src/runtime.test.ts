import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { journeyEventSchema, runtimeSchema } from "@wayscribe/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRecorder, type Recorder, type RecorderConfig } from "./index.js";
import { readRuntime } from "./runtime.js";

/**
 * Every event names the SDK that recorded it (F-046, ADR-063 decision 1):
 * `runtime.language`, `runtime.version`, and `runtime.sdk` with the version and
 * commit baked in when the bundle is built. Run from source, as these tests
 * run, nothing is baked in, so the version is `0.0.0-development` and there is
 * no commit. `bundle-identity.test.ts` checks a built bundle.
 */

const base = {
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "development"
};

async function capture(
  run: (recorder: Recorder) => Promise<void> | void,
  extra: Partial<RecorderConfig> = {}
): Promise<Record<string, unknown>[]> {
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
  const recorder = createRecorder({
    ...base,
    endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
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
  return events;
}

const FROM_SOURCE = {
  language: "node",
  version: process.versions.node,
  sdk: { name: "@wayscribe/node", version: "0.0.0-development" }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtime", () => {
  it("is on every event, and the server's schema accepts it", async () => {
    const events = await capture((recorder) => {
      const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
      journey.record({ operation: "received", name: "r" });
      journey.transform("t", 1, () => 2);
      journey.identify({ crmId: "c1" });
      journey.fail("f", new Error("boom"));
    });
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event["runtime"]).toEqual(FROM_SOURCE);
      expect(journeyEventSchema.safeParse(event).success).toBe(true);
      expect(runtimeSchema.parse(event["runtime"])).toEqual(FROM_SOURCE);
    }
  });

  it("sends no hostname and no process id", async () => {
    const [event] = await capture((recorder) => {
      recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
        operation: "received",
        name: "r"
      });
    });
    expect(Object.keys(event?.["runtime"] as object).sort()).toEqual([
      "language",
      "sdk",
      "version"
    ]);
  });

  it("takes nothing from the host's settings or environment", async () => {
    // What a bundler or a CI job might set in the host process. None of it is
    // read at run time: the version and commit are constants of the build.
    vi.stubEnv("WAYSCRIBE_BUILD_COMMIT", "1111111111111111111111111111111111111111");
    vi.stubEnv("CI_COMMIT_SHA", "2222222222222222222222222222222222222222");
    vi.stubEnv("npm_package_version", "9.9.9");
    vi.stubEnv("npm_package_name", "@host/app");
    const [event] = await capture(
      (recorder) => {
        recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
          operation: "received",
          name: "r"
        });
      },
      {
        deployment: { version: "4.5.6", gitCommit: "3333333" },
        // Not a setting: reported as unknown, never sent.
        ...({ runtime: { sdk: { name: "spoofed", version: "1" } } } as object)
      }
    );
    expect(event?.["runtime"]).toEqual(FROM_SOURCE);
    expect(event?.["deployment"]).toEqual({ version: "4.5.6", gitCommit: "3333333" });
  });

  it("is read once, when the recorder is created, and frozen", () => {
    const runtime = readRuntime();
    expect(runtime).toEqual(FROM_SOURCE);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.sdk)).toBe(true);
  });

  it("reads nothing while recording: it was read when the recorder was created", async () => {
    const recorder = createRecorder({
      ...base,
      endpoint: "http://127.0.0.1:1",
      flushIntervalMs: 3_600_000
    });
    const journey = recorder.startJourney({ entity: { type: "customer", id: "1" } });
    const reads = watchVersions();
    try {
      for (let i = 0; i < 3; i += 1) journey.record({ operation: "received", name: "r" });
    } finally {
      reads.restore();
    }
    expect(reads.count()).toBe(0);
    await recorder.shutdown({ timeoutMs: 100 });
  });

  it("leaves out a Node version it cannot read, and still records", async () => {
    const hostile = watchVersions(() => {
      throw new Error("hostile");
    });
    let runtime: unknown;
    let events: Record<string, unknown>[] = [];
    try {
      runtime = readRuntime();
      events = await capture((recorder) => {
        recorder.startJourney({ entity: { type: "customer", id: "1" } }).record({
          operation: "received",
          name: "r"
        });
      });
    } finally {
      hostile.restore();
    }
    const withoutVersion = {
      language: "node",
      sdk: { name: "@wayscribe/node", version: "0.0.0-development" }
    };
    expect(runtime).toEqual(withoutVersion);
    expect(events.map((event) => event["runtime"])).toEqual([withoutVersion]);
  });
});

/**
 * Replaces `process.versions` with a getter that counts its reads and returns
 * what `read` gives, the real value by default, until `restore()`.
 */
function watchVersions(read?: () => unknown): { count: () => number; restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(process, "versions");
  if (original === undefined) throw new Error("process.versions has no descriptor");
  let reads = 0;
  Object.defineProperty(process, "versions", {
    configurable: true,
    enumerable: true,
    get: () => {
      reads += 1;
      return read === undefined ? (original.value as unknown) : read();
    }
  });
  return {
    count: () => reads,
    restore: () => {
      Object.defineProperty(process, "versions", original);
    }
  };
}
