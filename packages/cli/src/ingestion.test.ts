import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, truncate } from "node:fs/promises";
import { createServer, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchResponseSchema, parseEnvelope } from "@wayscribe/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { run, type Io } from "./cli.js";
import { resolveIngestionConfig } from "./ingestion-config.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

type StoredResult = NonNullable<
  ReturnType<typeof batchResponseSchema.parse>["data"]["results"][number]
> & {
  stored: NonNullable<
    ReturnType<typeof batchResponseSchema.parse>["data"]["results"][number]["stored"]
  >;
};
let server: Server;
let url: string;
let directory: string;
let file: string;
let requests: { url: string; authorization: string | undefined; raw: Buffer }[];
let respond: (response: ServerResponse) => void;
let readyResponse: (response: ServerResponse) => void;
const accepted = { data: { dryRun: true, results: [{ eventId: "evt_1", status: "accepted" }] } };
function capture(env: Io["env"] = {}): {
  io: Io;
  out: string[];
  err: string[];
  output: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    isTty: false,
    env: { WAYSCRIBE_API_KEY: "ingest-sentinel", WAYSCRIBE_TOKEN: "admin-sentinel", ...env }
  };
  return { io, out, err, output: () => [...out, ...err].join("\n") };
}
const check = (): string[] => [
  "check",
  "--url",
  url,
  "--environment",
  "development",
  "--service",
  "setup-check"
];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "wayscribe-preview-"));
  file = join(directory, "batch.json");
  await writeFile(file, '{ "events": [null] }\n');
  requests = [];
  respond = (res) => res.end(JSON.stringify(accepted));
  readyResponse = (res) => res.end('{"status":"ready"}');
  server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      requests.push({
        url: req.url ?? "",
        authorization: req.headers.authorization,
        raw: Buffer.concat(chunks)
      });
      if (req.url?.endsWith("/ready")) readyResponse(res);
      else respond(res);
    })().catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/proxy`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    })
  );
  await rm(directory, { recursive: true, force: true });
});

it("checks readiness without credentials and validates a fresh synthetic public envelope using only the ingestion key", async () => {
  const c = capture();
  expect(await run(check(), c.io)).toBe(0);
  expect(requests.map((r) => [r.url, r.authorization])).toEqual([
    ["/proxy/ready", undefined],
    ["/proxy/v1/events/batch?dryRun=true", "Bearer ingest-sentinel"]
  ]);
  const envelope = (
    JSON.parse(required(requests[1]).raw.toString()) as { events: { event: { id: string } }[] }
  ).events[0];
  expect(parseEnvelope(envelope).ok).toBe(true);
  expect(required(envelope).event).toMatchObject({
    environment: "development",
    service: "setup-check"
  });
  expect(await run(check(), c.io)).toBe(0);
  expect(
    (JSON.parse(required(requests[3]).raw.toString()) as { events: { event: { id: string } }[] })
      .events[0]?.event.id
  ).not.toBe(required(envelope).event.id);
  expect(c.output()).not.toMatch(/ingest-sentinel|admin-sentinel/);
});

it("handles help without reading credentials", async () => {
  const c = capture();
  c.io.env = new Proxy(
    {},
    {
      get() {
        throw new Error("credential access");
      }
    }
  );
  expect(await run(["check", "--help"], c.io)).toBe(0);
  expect(c.output()).toContain("dry-run");
  expect(requests).toHaveLength(0);
});

it.each([
  ["--token", "ingest-sentinel"],
  ["--project", "ingest-sentinel"],
  ["--diff"],
  ["--limit", "3"],
  ["--unknown-ingest-sentinel"],
  ["--url", "ingest-sentinel"],
  ["extra"],
  ["--api-key-env", "BAD-NAME"],
  ["--api-key-env", "WAYSCRIBE_TOKEN"],
  ["--api-key-env", "ADMIN_TOKEN"],
  ["--json", "--json"]
])("refuses invalid check arguments safely: %j", async (...extra) => {
  const c = capture();
  expect(await run([...check(), ...extra], c.io)).not.toBe(0);
  expect(requests).toHaveLength(0);
  expect(c.output()).not.toContain("ingest-sentinel");
});

it.each([
  "http://ingest-sentinel@localhost",
  "http://localhost/?key=ingest-sentinel",
  "http://localhost/#ingest-sentinel",
  "file:///ingest-sentinel"
])("refuses unsafe URL without echo: %s", async (target) => {
  const c = capture();
  expect(
    await run(["check", "--url", target, "--environment", "dev", "--service", "check"], c.io)
  ).not.toBe(0);
  expect(c.output()).not.toContain("ingest-sentinel");
});

it("requires explicit check settings and never falls back to admin credentials", async () => {
  for (const args of [
    ["check"],
    ["check", "--url", url],
    ["check", "--url", url, "--environment", "dev"]
  ]) {
    expect(await run(args, capture().io)).not.toBe(0);
  }
  expect(
    await run(check(), capture({ WAYSCRIBE_API_KEY: undefined, ADMIN_TOKEN: "admin-sentinel" }).io)
  ).not.toBe(0);
  expect(requests).toHaveLength(0);
  const c = capture({
    WAYSCRIBE_URL: url,
    WAYSCRIBE_ENVIRONMENT: "dev",
    WAYSCRIBE_SERVICE: "check",
    OTHER_KEY: "alternate-sentinel"
  });
  expect(await run(["check", "--api-key-env", "OTHER_KEY"], c.io)).toBe(0);
  expect(requests.at(-1)?.authorization).toBe("Bearer alternate-sentinel");
});

it("preserves exact preview bytes and lets the server refuse invalid event positions", async () => {
  const raw = '{\n "events" : [null], "extension": 2\n}\n';
  await writeFile(file, raw);
  respond = (res) =>
    res.end(
      JSON.stringify({
        data: {
          dryRun: true,
          results: [
            {
              eventId: null,
              status: "rejected",
              error: { code: "invalid_event", message: "Invalid event", httpStatus: 400 }
            }
          ]
        }
      })
    );
  const c = capture();
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.raw).toEqual(Buffer.from(raw));
  expect(JSON.parse(c.out.join(""))).toMatchObject({
    dryRun: true,
    results: [{ status: "rejected" }]
  });
});

it.each(["{", '{"events":{}}', JSON.stringify({ events: Array(101).fill(null) }), "{}", '"x"'])(
  "refuses invalid outer batches locally",
  async (raw) => {
    await writeFile(file, raw);
    expect(await run(["preview", file, "--url", url], capture().io)).not.toBe(0);
    expect(requests).toHaveLength(0);
  }
);

it("refuses invalid UTF-8, large files, directories, FIFO and preview overrides without network", async () => {
  await writeFile(file, Buffer.from([0xff]));
  expect(await run(["preview", file, "--url", url], capture().io)).not.toBe(0);
  await truncate(file, 26_279_937);
  expect(await run(["preview", file, "--url", url], capture().io)).not.toBe(0);
  expect(await run(["preview", directory, "--url", url], capture().io)).not.toBe(0);
  const fifo = join(directory, "pipe");
  execFileSync("mkfifo", [fifo]);
  expect(await run(["preview", fifo, "--url", url], capture().io)).not.toBe(0);
  for (const extra of [["--service", "x"], ["--environment", "x"], ["extra"]]) {
    expect(await run(["preview", file, "--url", url, ...extra], capture().io)).not.toBe(0);
  }
  expect(requests).toHaveLength(0);
});

it.each([
  { data: { results: [{ eventId: "evt_1", status: "accepted" }] } },
  { data: { dryRun: false, results: [{ eventId: "evt_1", status: "accepted" }] } },
  { data: { dryRun: true, results: [] } },
  { data: { dryRun: true, results: [null] } }
])("refuses an unconfirmed or malformed dry-run response without fallback", async (body) => {
  respond = (res) => res.end(JSON.stringify(body));
  const c = capture();
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
  expect(requests.map((r) => r.url)).toEqual(["/proxy/v1/events/batch?dryRun=true"]);
  expect(JSON.parse(c.out.join(""))).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
});

it("refuses redirects, secret-bearing HTTP errors and oversized chunked responses safely", async () => {
  for (const mode of ["redirect", "error", "large"]) {
    respond = (res) => {
      if (mode === "redirect") {
        res.writeHead(307, { location: `${url}/live?secret=ingest-sentinel` });
        res.end();
      } else if (mode === "error") {
        res.statusCode = 401;
        res.end("Bearer ingest-sentinel admin-sentinel");
      } else {
        res.write(" ".repeat(4 * 1024 * 1024));
        res.end(" ");
      }
    };
    const c = capture();
    expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
    expect(c.output()).not.toMatch(/ingest-sentinel|admin-sentinel/);
    expect(JSON.parse(c.out.join(""))).toHaveProperty("error.code");
  }
  expect(requests).toHaveLength(3);
});

it("includes a stalled response body in the overall deadline", async () => {
  respond = (res) => {
    res.writeHead(200);
    res.write('{"data":');
  };
  const c = capture();
  const start = performance.now();
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
  expect(performance.now() - start).toBeLessThan(6500);
  expect(JSON.parse(c.out.join(""))).toMatchObject({ error: { code: "REQUEST_FAILED" } });
}, 8000);

it("finds command boundaries without mistaking read values or flags for ingestion commands", async () => {
  respond = (res) => res.end('{"data":{"items":[]}}');
  expect(await run(["search", "check", "--url", url, "--token", "read-token"], capture().io)).toBe(
    0
  );
  expect(requests[0]?.authorization).toBe("Bearer read-token");
  const c = capture();
  expect(await run(["--unknown-ingest-sentinel", "check", "--url", url], c.io)).not.toBe(0);
  expect(c.output()).not.toContain("ingest-sentinel");
  expect(await run(["search", "check", "--service", "x"], capture().io)).not.toBe(0);
});

function storedResult(
  input: unknown = { value: "before" },
  output: unknown = { value: "after" }
): StoredResult {
  return {
    eventId: "evt_1",
    status: "accepted",
    duplicate: false,
    stored: {
      event: {
        id: "evt_1",
        journeyId: "jrn_1",
        parentEventId: null,
        protocolVersion: "0.1",
        operation: "transformed",
        name: "normalize",
        service: "worker",
        eventTimestamp: "2026-09-20T10:00:00.000Z",
        durationMs: null,
        traceId: null,
        spanId: null,
        messageId: null,
        correlationId: null,
        hasInput: true,
        hasOutput: true,
        hasError: false,
        inputPayload: input,
        outputPayload: output,
        payloadDiff: { changes: [] },
        error: null,
        runtimeMetadata: null,
        deploymentMetadata: null,
        customMetadata: null,
        aliases: []
      },
      journey: {
        journeyId: "jrn_1",
        environment: "development",
        entity: { type: "order", id: "42" },
        status: "active",
        label: null,
        lastStep: "normalize",
        failedStep: null,
        aliases: [],
        services: ["worker"],
        eventCount: 1,
        startedAt: "2026-09-20T10:00:00.000Z",
        completedAt: null,
        lastEventAt: "2026-09-20T10:00:00.000Z"
      }
    }
  };
}

it("guards selected stored fields and keys, strips terminal controls and masks diagnostic secrets in both output modes", async () => {
  const input = JSON.parse(
    '{"ingest-sentinel":"ingest-sentinel", "__proto__":{"value":"visible"}, "safe":"\\u001b[31mvisible\\u001b[0m", "password":"server-secret-42"}'
  ) as unknown;
  const result = storedResult(input);
  respond = (res) =>
    res.end(
      JSON.stringify({ data: { dryRun: true, results: [result] }, unknown: "unselected-value" })
    );
  for (const json of [[], ["--json"]]) {
    const c = capture();
    expect(await run(["preview", file, "--url", url, ...json], c.io)).toBe(0);
    expect(c.output()).not.toMatch(/ingest-sentinel|server-secret-42|unselected-value/);
    expect(c.output()).not.toContain(String.fromCharCode(27));
    const displayed = JSON.parse(c.out.join("")) as {
      results: { stored: { event: { inputPayload: Record<string, unknown> } } }[];
    };
    expect(displayed.results[0]?.stored.event.inputPayload).toMatchObject({
      "[REDACTED]": "[REDACTED]",
      safe: "visible",
      password: "[REDACTED]"
    });
    expect(
      Object.hasOwn(required(displayed.results[0]).stored.event.inputPayload, "__proto__")
    ).toBe(true);
  }
  respond = (res) =>
    res.end(
      JSON.stringify({
        data: {
          dryRun: true,
          results: [
            {
              eventId: null,
              status: "rejected",
              error: {
                code: "invalid_event",
                message: "password=secret-42 Bearer abc123XYZ890 ingest-sentinel\u001b[31m",
                httpStatus: 400,
                details: [{ path: "ingest-sentinel", message: "token=secret-99" }]
              }
            }
          ]
        }
      })
    );
  const c = capture();
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
  expect(c.output()).not.toMatch(/secret-42|secret-99|abc123XYZ890|ingest-sentinel/);
});

it("preserves duplicate and unavailable distinctions without claiming policy omission", async () => {
  for (const result of [
    { eventId: "evt_1", status: "accepted", duplicate: true },
    { eventId: "evt_1", status: "accepted" }
  ]) {
    respond = (res) => res.end(JSON.stringify({ data: { dryRun: true, results: [result] } }));
    const c = capture();
    expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.out.join(""))).toMatchObject({
      results: [{ preview: "duplicate" in result ? "duplicate" : "unavailable" }]
    });
  }
});

it.each([
  "string",
  "depth",
  "nodes",
  "ignored-schema-work",
  "escaped-output",
  "key-collision",
  "mask-growth"
])("fails closed with bounded valid JSON for %s limits", async (mode) => {
  let payload: unknown;
  if (mode === "string") payload = "x".repeat(262_145);
  else if (mode === "mask-growth") payload = Array(15).fill("abcdefgh".repeat(30_000));
  else if (mode === "nodes") payload = Array(10_001).fill(0);
  else if (mode === "ignored-schema-work") payload = 0;
  else if (mode === "escaped-output") payload = Array(20).fill('"'.repeat(120_000));
  else if (mode === "key-collision") payload = { "ingest-sentinel": 1, "[REDACTED]": 2 };
  else {
    payload = 0;
    for (let i = 0; i < 35; i++) payload = [payload];
  }
  const result = storedResult(payload);
  if (mode === "ignored-schema-work") result.stored.event.runtimeMetadata = Array(10_001).fill(0);
  respond = (res) => res.end(JSON.stringify({ data: { dryRun: true, results: [result] } }));
  const c = capture(mode === "mask-growth" ? { WAYSCRIBE_API_KEY: "abcdefgh" } : {});
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
  expect(JSON.parse(c.out.join(""))).toHaveProperty("error.code");
  expect(Buffer.byteLength(c.out.join(""))).toBeLessThan(4_194_304);
});

it("keeps exact-key masking safe even when the key is part of the redaction marker", async () => {
  respond = (res) =>
    res.end(
      JSON.stringify({ data: { dryRun: true, results: [storedResult({ value: "REDACTED" })] } })
    );
  const c = capture({ WAYSCRIBE_API_KEY: "REDACTED" });
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(0);
  expect(c.output()).not.toContain("REDACTED");
});

it("fails closed if an exact numeric ingestion key survives JSON scalar serialization", async () => {
  respond = (res) =>
    res.end(
      JSON.stringify({ data: { dryRun: true, results: [storedResult({ value: 12345678 })] } })
    );
  const c = capture({ WAYSCRIBE_API_KEY: "12345678" });
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
  expect(c.output()).not.toContain("12345678");
  expect(JSON.parse(c.out.join(""))).toHaveProperty("error.code");
});

it.each(["n", "short", "invalid key", 'invalid"key', "éééééééé"])(
  "refuses unusable Bearer keys locally without echoing",
  async (key) => {
    const c = capture({ WAYSCRIBE_API_KEY: key });
    expect(await run(check(), c.io)).toBe(1);
    expect(requests).toHaveLength(0);
    expect(c.output()).toContain("INVALID_CONFIG");
  }
);

it("keeps malformed ingestion arguments in the guarded JSON error path", async () => {
  const c = capture();
  expect(await run(["check", "--json", "--url"], c.io)).toBe(2);
  expect(JSON.parse(c.out.join(""))).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  expect(c.err).toEqual([]);
  expect(requests).toHaveLength(0);
});

it("handles leading options and positional terminators without overriding preview events", async () => {
  const c = capture();
  expect(
    await run(["--url", url, "--environment", "dev", "--service", "setup", "check"], c.io)
  ).toBe(0);
  const preview = capture({
    WAYSCRIBE_URL: url,
    WAYSCRIBE_SERVICE: "unused",
    WAYSCRIBE_ENVIRONMENT: "unused"
  });
  expect(await run(["preview", "--", file], preview.io)).toBe(0);
  expect(requests.at(-1)?.raw).toEqual(Buffer.from('{ "events": [null] }\n'));
});

it.each([202, 204])(
  "requires HTTP 200 even when a dry-run marker is present: %s",
  async (status) => {
    respond = (res) => {
      res.statusCode = status;
      res.end(JSON.stringify(accepted));
    };
    expect(await run(["preview", file, "--url", url], capture().io)).toBe(1);
    expect(requests).toHaveLength(1);
  }
);

it("refuses inconsistent results and extra result positions", async () => {
  for (const results of [
    [storedResult(), storedResult()],
    [{ ...storedResult(), status: "rejected" }],
    [{ ...storedResult(), duplicate: true }],
    [{ ...storedResult(), error: { code: "x", message: "refused", httpStatus: 400 } }]
  ]) {
    respond = (res) => res.end(JSON.stringify({ data: { dryRun: true, results } }));
    const c = capture();
    expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
    expect(JSON.parse(c.out.join(""))).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
  }
});

it("applies secret-name masking after terminal controls are removed from property names", async () => {
  respond = (res) =>
    res.end(
      JSON.stringify({
        data: { dryRun: true, results: [storedResult({ "pa\u0000ssword": "concealed-secret-42" })] }
      })
    );
  const c = capture();
  expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(0);
  expect(c.output()).not.toContain("concealed-secret-42");
  expect(JSON.parse(c.out.join(""))).toMatchObject({
    results: [{ stored: { event: { inputPayload: { password: "[REDACTED]" } } } }]
  });
});

it("stops after readiness refusal without sending an ingestion key", async () => {
  readyResponse = (res) => res.end('{"status":"not_ready"}');
  const c = capture();
  expect(await run([...check(), "--json"], c.io)).toBe(1);
  expect(requests.map((r) => [r.url, r.authorization])).toEqual([["/proxy/ready", undefined]]);
  expect(JSON.parse(c.out.join(""))).toMatchObject({ error: { code: "NOT_READY" } });
});

it("refuses malformed and invalid UTF-8 responses and wrong Content-Length without raw output", async () => {
  for (const mode of ["json", "utf8", "length"]) {
    respond = (res) => {
      if (mode === "json") res.end("invalid ingest-sentinel");
      else if (mode === "utf8") res.end(Buffer.from([0xff]));
      else {
        res.setHeader("Content-Length", "1");
        res.end(JSON.stringify(accepted));
      }
    };
    const c = capture();
    expect(await run(["preview", file, "--url", url, "--json"], c.io)).toBe(1);
    expect(c.output()).not.toContain("ingest-sentinel");
    expect(JSON.parse(c.out.join(""))).toHaveProperty("error.code");
  }
  expect(requests).toHaveLength(3);
});

it("refuses empty URL userinfo before networking", async () => {
  for (const authority of ["@", ":@"]) {
    const c = capture();
    expect(
      await run(
        [
          "check",
          "--url",
          url.replace("http://", `http://${authority}`),
          "--environment",
          "dev",
          "--service",
          "check",
          "--json"
        ],
        c.io
      )
    ).toBe(1);
    expect(JSON.parse(c.out.join(""))).toMatchObject({ error: { code: "INVALID_CONFIG" } });
  }
  expect(requests).toHaveLength(0);
});

it.each([
  "http://wayscribe.example.com",
  "http://10.0.0.5:3000",
  "http://128.0.0.1",
  "http://localhost.example.com",
  "http://[::ffff:127.0.0.1]",
  "http://[2001:db8::1]"
])("refuses to send the ingestion key over plain http to non-loopback %s", async (target) => {
  const c = capture();
  expect(
    await run(
      ["check", "--url", target, "--environment", "dev", "--service", "check", "--json"],
      c.io
    )
  ).toBe(1);
  expect(JSON.parse(c.out.join(""))).toMatchObject({
    error: {
      code: "INVALID_CONFIG",
      message:
        "Ingestion URL must use https unless the host is loopback (localhost, 127.0.0.0/8, ::1)."
    }
  });
  expect(requests).toHaveLength(0);
});

it.each([
  "http://localhost:3000",
  "http://LOCALHOST",
  "http://127.0.0.1:3000",
  "http://127.1.2.3",
  "http://[::1]:3000",
  "https://wayscribe.example.com"
])("allows %s", (target) => {
  expect(
    resolveIngestionConfig("preview", { url: target }, { WAYSCRIBE_API_KEY: "wsk_valid_key" }).url
  ).toBe(new URL(target).origin);
});
