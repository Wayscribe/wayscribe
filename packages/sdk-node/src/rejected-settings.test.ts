import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRequiredSettingWarnings } from "./config.js";
import { createDiagnostics, type Counters, type Diagnostic } from "./diagnostics.js";
import { forgetSecretWarning } from "./journey-id.js";
import { createRecorder, type Recorder, type RecorderConfig } from "./index.js";

/**
 * What `counters()` says the SDK refused, and when (F-031, F-038, ADR-062).
 *
 * `rejectedSettings` named the setting and not the part of it, so "sent
 * without one field" and "not sent at all" read alike; and every call that
 * passed something odd appended to it long after the recorder was built, so a
 * correctly configured process could end its last log line with a setting
 * problem it never had.
 */

const base = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "wsk_test",
  serviceName: "svc",
  environment: "development"
};

const SECRET = "a secret of at least thirty-two bytes, for tests";

beforeEach(() => {
  // Every rejected setting prints one line per process; keep them off the
  // test output, and let each test see its own.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  forgetRequiredSettingWarnings();
  forgetSecretWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings refused at creation and options refused on a call (F-038)", () => {
  it("keeps a correctly configured recorder's settings list empty, whatever calls do", () => {
    const recorder = createRecorder(base);
    expect(recorder.counters()).toMatchObject({
      rejectedSettings: [],
      rejectedOptions: [],
      configurationErrors: 0
    });

    recorder.continueJourney({ journeyId: 7 as never, entity: { type: "lead", id: "1" } });
    expect(recorder.counters()).toMatchObject({
      rejectedSettings: [],
      rejectedOptions: ["journeyId"],
      configurationErrors: 1
    });

    recorder.continueJourney({ context: {} as never, entity: { type: "lead", id: "1" } });
    expect(recorder.counters()).toMatchObject({
      rejectedSettings: [],
      rejectedOptions: ["journeyId", "context"],
      configurationErrors: 2
    });
  });

  it("puts what createRecorder refused in the settings list, and never grows it after", () => {
    const recorder = createRecorder({ ...base, batchSize: "5" as never });
    expect(recorder.counters().rejectedSettings).toEqual(["batchSize"]);
    recorder.startJourney({ entity: { type: "", id: "" } });
    recorder.continueJourney({ entityFallback: { type: "t", id: "1" } } as never);
    recorder
      .startJourney({ entity: { type: "t", id: "1" } })
      .identify({ a: "1" }, { displayable: ["a"] } as never);
    const counters = recorder.counters();
    expect(counters.rejectedSettings).toEqual(["batchSize"]);
    expect(counters.rejectedOptions).toEqual(["entity", "entityFallback", "displayable"]);
  });

  it("names a missing secret as an option, when a call needed it", () => {
    const recorder = createRecorder(base);
    recorder.journeyIdFor({ type: "t", id: "1" });
    recorder.journeyIdFor({ type: "t", id: "2" });
    const counters = recorder.counters();
    expect(counters.rejectedSettings).toEqual([]);
    expect(counters.rejectedOptions).toEqual(["journeyIdSecret"]);
    expect(counters.configurationErrors).toBe(2);
  });

  it("names an unusable secret as a setting at creation, and as an option when a call needs it", () => {
    const recorder = createRecorder({ ...base, journeyIdSecret: "too short" });
    expect(recorder.counters().rejectedSettings).toEqual(["journeyIdSecret"]);
    expect(recorder.counters().rejectedOptions).toEqual([]);
    recorder.journeyIdFor({ type: "t", id: "1" });
    expect(recorder.counters().rejectedSettings).toEqual(["journeyIdSecret"]);
    expect(recorder.counters().rejectedOptions).toEqual(["journeyIdSecret"]);
  });

  it("names the entity journeyIdFor could not derive from", () => {
    const diagnostics: Diagnostic[] = [];
    const recorder = createRecorder({
      ...base,
      journeyIdSecret: SECRET,
      onDiagnostic: (d) => diagnostics.push(d)
    });
    expect(recorder.journeyIdFor(null as never)).toMatch(/^jrn_/);
    expect(diagnostics.map((d) => [d.code, d.detail])).toEqual([
      ["entity_invalid", { setting: "entity" }]
    ]);
    expect(recorder.counters().rejectedOptions).toEqual(["entity"]);
  });

  it.each([
    ["an empty type", { type: "", id: "1" }],
    ["an empty id", { type: "t", id: "" }]
  ])("does not derive from an entity with %s, as the rule says", (_what, entity) => {
    const diagnostics: Diagnostic[] = [];
    const recorder = createRecorder({
      ...base,
      journeyIdSecret: SECRET,
      onDiagnostic: (d) => diagnostics.push(d)
    });
    const first = recorder.journeyIdFor(entity);
    const second = recorder.journeyIdFor(entity);
    // A random id each time: an empty type or id is not an entity the server
    // accepts, and ConfigurationErrorDiagnostic says non-empty strings.
    expect(first).not.toBe(second);
    expect(diagnostics.map((d) => d.code)).toEqual(["entity_invalid", "entity_invalid"]);
  });

  it("returns fresh copies of both lists", () => {
    const recorder = createRecorder({ ...base, batchSize: "5" as never });
    recorder.journeyIdFor({ type: "t", id: "1" });
    const first = recorder.counters();
    const second = recorder.counters();
    expect(first.rejectedSettings).not.toBe(second.rejectedSettings);
    expect(first.rejectedOptions).not.toBe(second.rejectedOptions);
    (first.rejectedOptions as string[]).push("changed");
    expect(recorder.counters().rejectedOptions).toEqual(["journeyIdSecret"]);
  });
});

describe("the two lists, in the diagnostics they are kept by", () => {
  const unusable = (setting: string): Diagnostic => ({
    kind: "configuration_error",
    code: "setting_unusable",
    reason: "r",
    detail: { setting }
  });

  it("splits by when a report arrives: before endCreation a setting, after it an option", () => {
    const diagnostics = createDiagnostics();
    diagnostics.report(unusable("batchSize"));
    diagnostics.endCreation();
    diagnostics.report(unusable("journeyId"));
    diagnostics.report(unusable("batchSize"));
    const counters = diagnostics.counters();
    expect(counters.rejectedSettings).toEqual(["batchSize"]);
    expect(counters.rejectedOptions).toEqual(["journeyId", "batchSize"]);
    expect(counters.configurationErrors).toBe(3);
  });

  it("keeps each list to 50 names, once each, in the order first seen", () => {
    const diagnostics = createDiagnostics();
    for (let i = 0; i < 60; i += 1) diagnostics.report(unusable(`s${String(i)}`));
    diagnostics.report(unusable("s0"));
    diagnostics.endCreation();
    for (let i = 0; i < 60; i += 1) diagnostics.report(unusable(`o${String(i)}`));
    const counters = diagnostics.counters();
    expect(counters.rejectedSettings).toHaveLength(50);
    expect(counters.rejectedSettings[0]).toBe("s0");
    expect(counters.rejectedSettings[49]).toBe("s49");
    expect(counters.rejectedOptions).toHaveLength(50);
    expect(counters.rejectedOptions[49]).toBe("o49");
    expect(counters.configurationErrors).toBe(121);
  });
});

async function recordWith(
  deployment: unknown
): Promise<{ sent: unknown; counters: Counters; diagnostics: Diagnostic[] }> {
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
  try {
    const recorder: Recorder = createRecorder({
      ...base,
      endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      onDiagnostic: (d) => diagnostics.push(d),
      deployment: deployment as RecorderConfig["deployment"]
    });
    recorder
      .startJourney({ entity: { type: "customer", id: "1" } })
      .record({ operation: "received", name: "r" });
    const counters = await recorder.shutdown({ timeoutMs: 5_000 });
    expect(events).toHaveLength(1);
    return { sent: events[0]?.["deployment"], counters, diagnostics };
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const COMMIT = "a".repeat(40);

describe("deployment, reported by field (F-031)", () => {
  // ADR-062's table, one row per case, with what is sent.
  it.each<[string, unknown, string[], unknown]>([
    ["a commit alone", { gitCommit: COMMIT }, [], { gitCommit: COMMIT }],
    [
      "a commit and an over-long version",
      { gitCommit: COMMIT, version: "v".repeat(129) },
      ["deployment.version"],
      { gitCommit: COMMIT }
    ],
    [
      "a commit and a key the protocol does not have",
      { gitCommit: COMMIT, branch: "main" },
      ["deployment.*"],
      { gitCommit: COMMIT }
    ],
    [
      "a commit and a key named like a prototype member",
      { gitCommit: COMMIT, constructor: "x" },
      ["deployment.*"],
      { gitCommit: COMMIT }
    ],
    [
      "an over-long commit",
      { gitCommit: "a".repeat(129) },
      ["deployment.gitCommit", "deployment"],
      undefined
    ],
    ["an empty commit", { gitCommit: "" }, ["deployment.gitCommit", "deployment"], undefined],
    [
      "a whitespace-only commit",
      { gitCommit: "   " },
      ["deployment.gitCommit", "deployment"],
      undefined
    ],
    ["an empty object", {}, ["deployment"], undefined],
    ["an unset environment variable", { gitCommit: undefined }, ["deployment"], undefined],
    ["null", null, ["deployment"], undefined],
    ["an array", [COMMIT], ["deployment"], undefined],
    ["a string", COMMIT, ["deployment"], undefined],
    [
      "every field refused, and an unknown key, in the stated order",
      { image: "i".repeat(513), extra: 1, version: 7, gitCommit: "\t" },
      [
        "deployment.gitCommit",
        "deployment.version",
        "deployment.image",
        "deployment.*",
        "deployment"
      ],
      undefined
    ],
    [
      "a value with text around it, sent as given",
      { version: " 1.4.2 " },
      [],
      { version: " 1.4.2 " }
    ]
  ])("%s", async (_what, deployment, rejected, sent) => {
    const result = await recordWith(deployment);
    expect(result.counters.rejectedSettings).toEqual(rejected);
    expect(result.counters.rejectedOptions).toEqual([]);
    // One report per entry, each `setting_unusable`.
    expect(result.counters.configurationErrors).toBe(rejected.length);
    expect(
      result.diagnostics.filter((d) => d.kind === "configuration_error").map((d) => d.code)
    ).toEqual(rejected.map(() => "setting_unusable"));
    expect(result.sent).toEqual(sent);
  });

  it("never names the host's key, or quotes a value", async () => {
    const { diagnostics } = await recordWith({
      gitCommit: COMMIT,
      theirSecretKeyName: "hunter2hunter2"
    });
    const text = JSON.stringify(diagnostics);
    expect(text).not.toContain("theirSecretKeyName");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(COMMIT);
  });

  it("refuses a field whose getter throws, and sends the rest", async () => {
    const deployment = Object.defineProperty({ gitCommit: COMMIT }, "version", {
      get: () => {
        throw new Error("version getter");
      },
      enumerable: true
    });
    const { counters, sent } = await recordWith(deployment);
    expect(counters.rejectedSettings).toEqual(["deployment.version"]);
    expect(sent).toEqual({ gitCommit: COMMIT });
  });

  it("reports keys it cannot list, and still sends the fields it can read", async () => {
    const deployment = new Proxy(
      { gitCommit: COMMIT },
      {
        ownKeys: () => {
          throw new Error("no keys");
        }
      }
    );
    const { counters, sent } = await recordWith(deployment);
    expect(counters.rejectedSettings).toEqual(["deployment.*"]);
    expect(sent).toEqual({ gitCommit: COMMIT });
  });

  it("reports a revoked Proxy as a deployment it could not read, without throwing", async () => {
    // `Array.isArray` throws for one, and that used to escape createRecorder.
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const { counters, sent } = await recordWith(revoked.proxy);
    expect(counters.rejectedSettings).toEqual(["deployment"]);
    expect(sent).toBeUndefined();
  });

  it("refuses each field of a Proxy whose every read throws", async () => {
    const throwing = (): never => {
      throw new Error("no");
    };
    const { counters, sent } = await recordWith(
      new Proxy({}, { get: throwing, ownKeys: throwing })
    );
    expect(counters.rejectedSettings).toEqual([
      "deployment.gitCommit",
      "deployment.version",
      "deployment.image",
      "deployment.*",
      "deployment"
    ]);
    expect(sent).toBeUndefined();
  });

  it("reports a deployment setting that cannot be read at all", async () => {
    const events: unknown[] = [];
    const config = Object.defineProperty({ ...base }, "deployment", {
      get: () => {
        throw new Error("deployment getter");
      },
      enumerable: true
    }) as RecorderConfig;
    const recorder = createRecorder(config);
    expect(recorder.counters().rejectedSettings).toEqual(["deployment"]);
    expect(events).toEqual([]);
    await recorder.shutdown({ timeoutMs: 100 });
  });
});

describe("a list setting whose reads throw (SDK-6)", () => {
  const throwing = (): never => {
    throw new Error("trap");
  };
  // Iterating it throws, and so does iterating what its `map` returns, which
  // is how the knownSafeNames copy used to reach `new Set` outside any try.
  const hostileIterable = (): object => ({
    length: 1,
    [Symbol.iterator]: throwing,
    map: () => ({ length: 1, [Symbol.iterator]: throwing })
  });
  function hostileSpecies(): object {
    return hostileIterable();
  }
  const lists = (): [string, () => unknown][] => [
    [
      "a revoked Proxy",
      () => {
        const revoked = Proxy.revocable([], {});
        revoked.revoke();
        return revoked.proxy;
      }
    ],
    ["an array Proxy whose reads throw", () => new Proxy(["a"], { get: throwing })],
    // What the SDK does with the list must be its own code too: each of these
    // hands back an object whose iteration throws, from a method the SDK used
    // to call on the host's array.
    [
      "an array whose constructor has a Symbol.species",
      () => {
        const list: unknown[] = ["a"];
        Object.defineProperty(list, "constructor", {
          value: { [Symbol.species]: hostileSpecies }
        });
        return list;
      }
    ],
    [
      "an Array subclass that overrides filter",
      () => {
        class Hostile extends Array<unknown> {
          override filter(): never {
            return hostileIterable() as never;
          }
        }
        return Hostile.from(["a"]);
      }
    ],
    [
      "an array Proxy whose filter returns a custom iterable",
      () =>
        new Proxy(["a"], {
          get: (target, key, receiver) =>
            key === "filter"
              ? () => hostileIterable()
              : (Reflect.get(target, key, receiver) as unknown)
        })
    ],
    [
      "an array Proxy whose length is a trillion",
      () =>
        new Proxy([], {
          get: (target, key, receiver) =>
            key === "length" ? 1e12 : (Reflect.get(target, key, receiver) as unknown)
        })
    ]
  ];

  it.each(["redact", "knownSafeNames"])(
    "never throws out of createRecorder for %s, and never hangs",
    async (setting) => {
      for (const [what, make] of lists()) {
        forgetRequiredSettingWarnings();
        let recorder: Recorder | undefined;
        expect(() => {
          recorder = createRecorder({ ...base, [setting]: make() });
        }, what).not.toThrow();
        expect(recorder, what).toBeDefined();
        // Recording still works, and nothing the host's list does reaches it.
        recorder
          ?.startJourney({ entity: { type: "t", id: "1" } })
          .record({ operation: "received", name: "r", input: { a: 1 } });
        await recorder?.shutdown({ timeoutMs: 100 });
      }
    }
  );

  it.each(["redact", "knownSafeNames"])(
    "reports %s when it cannot be read, or holds more entries than it keeps",
    async (setting) => {
      const revoked = Proxy.revocable([], {});
      revoked.revoke();
      const huge = new Proxy([], {
        get: (target, key, receiver) =>
          key === "length" ? 1e12 : (Reflect.get(target, key, receiver) as unknown)
      });
      for (const value of [revoked.proxy, huge, Array.from({ length: 1_001 }, () => "a")]) {
        forgetRequiredSettingWarnings();
        const recorder = createRecorder({ ...base, [setting]: value });
        expect(recorder.counters().rejectedSettings).toEqual([setting]);
        await recorder.shutdown({ timeoutMs: 100 });
      }
    }
  );

  it("keeps the entries of an array whose own methods are hostile", () => {
    const list = ["sessionId"];
    Object.defineProperty(list, "constructor", {
      value: { [Symbol.species]: hostileSpecies }
    });
    const recorder = createRecorder({ ...base, knownSafeNames: list, redact: list });
    expect(recorder.counters().rejectedSettings).toEqual([]);
  });

  it("still redacts the built-in secret names when redact cannot be read", async () => {
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
        ...base,
        endpoint: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        redact: new Proxy(["**.custom"], { get: throwing })
      });
      recorder
        .startJourney({ entity: { type: "customer", id: "1" } })
        .record({ operation: "received", name: "r", input: { password: "hunter2hunter2" } });
      await recorder.shutdown({ timeoutMs: 5_000 });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    expect(JSON.stringify(events[0]?.["input"])).not.toContain("hunter2");
  });
});
