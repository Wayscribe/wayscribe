import { readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntryPoint, run, type Io } from "./cli.js";

interface Captured {
  out: string[];
  err: string[];
  io: Io;
}

function capture(env: Record<string, string | undefined>, isTty = false): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t), isTty, env } };
}

const JOURNEY = {
  journeyId: "jrn_1",
  entity: { type: "customer", id: "0018Z00002ABC" },
  status: "failed",
  eventCount: 2,
  startedAt: "2026-08-06T10:00:00.000Z",
  lastEventAt: "2026-08-06T10:00:05.000Z",
  completedAt: null,
  // Masked exactly as the API returns it: a listing never carries a full
  // alias value. The first version of this fixture invented `value`, which
  // is why the CLI printed `=undefined` against a real server.
  aliases: [{ type: "salesforceAccountId", displayValue: "SF\u202699" }],
  services: ["integration-api", "sync-worker"]
};

const EVENTS = [
  {
    id: "evt_1",
    operation: "transformed",
    name: "transform-salesforce-account",
    service: "integration-api",
    eventTimestamp: "2026-08-06T10:00:00.000Z",
    durationMs: 4,
    hasInput: true,
    hasOutput: true,
    hasError: false
  },
  {
    id: "evt_2",
    operation: "failed",
    name: "move-message-to-dead-letter",
    service: "sync-worker",
    eventTimestamp: "2026-08-06T10:00:05.000Z",
    durationMs: null,
    hasInput: false,
    hasOutput: false,
    hasError: true
  }
];

describe("the command line", () => {
  let server: Server;
  let url: string;
  let seen: string[];
  let seenProject: (string | undefined)[];
  let respond: (path: string) => { status: number; body: unknown };

  beforeEach(async () => {
    seen = [];
    seenProject = [];
    respond = () => ({ status: 200, body: { data: { items: [] } } });
    server = createServer((request, response) => {
      seen.push(`${request.headers.authorization ?? "none"} ${request.url ?? ""}`);
      seenProject.push(request.headers["x-wayscribe-project-id"] as string | undefined);
      const { status, body } = respond(request.url ?? "");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const env = (): Record<string, string | undefined> => ({
    WAYSCRIBE_URL: url,
    WAYSCRIBE_TOKEN: "admin-token"
  });

  it("prints usage and fails when given no command", async () => {
    const { out, io } = capture({});
    expect(await run([], io)).toBe(2);
    expect(out.join("\n")).toContain("wayscribe search");
  });

  it("succeeds for an explicit --help", async () => {
    // The control on the case above: usage on request is not an error.
    const { io } = capture({});
    expect(await run(["--help"], io)).toBe(0);
  });

  it("prints the version from its own package.json for --version", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version: string };
    for (const argv of [["--version"], ["projects", "--version"]]) {
      const { out, err, io } = capture({});
      expect(await run(argv, io)).toBe(0);
      expect(out).toEqual([manifest.version]);
      expect(err).toEqual([]);
    }
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("lists --version in its usage", async () => {
    const { out, io } = capture({});
    await run(["--help"], io);
    expect(out.join("\n")).toContain("--version");
  });

  it("says what to do when no token is configured", async () => {
    const { err, io } = capture({ WAYSCRIBE_URL: url });
    expect(await run(["projects"], io)).toBe(1);
    expect(err.join("\n")).toContain("WAYSCRIBE_TOKEN");
  });

  it("renders a journey timeline in order, across services", async () => {
    respond = (path) =>
      path.startsWith("/v1/journeys/jrn_1/events")
        ? { status: 200, body: { data: { items: EVENTS, nextCursor: null } } }
        : { status: 200, body: { data: JOURNEY } };

    const { out, io } = capture(env());
    expect(await run(["journey", "jrn_1"], io)).toBe(0);

    const text = out.join("\n");
    expect(text).toContain("customer:0018Z00002ABC");
    expect(text).toContain("transform-salesforce-account");
    expect(text).toContain("sync-worker");
    // Order is the product: a timeline that sorted wrongly would be worse than
    // none, because it would read as a sequence that never happened.
    expect(text.indexOf("transform-salesforce-account")).toBeLessThan(
      text.indexOf("move-message-to-dead-letter")
    );
    expect(text).toContain("salesforceAccountId=SF\u202699");
  });

  it("follows cursors so a long timeline is not silently truncated", async () => {
    let page = 0;
    respond = (path) => {
      if (!path.startsWith("/v1/journeys/jrn_1/events")) {
        return { status: 200, body: { data: JOURNEY } };
      }
      page += 1;
      return page === 1
        ? { status: 200, body: { data: { items: [EVENTS[0]], nextCursor: "c1" } } }
        : { status: 200, body: { data: { items: [EVENTS[1]], nextCursor: null } } };
    };

    const { out, io } = capture(env());
    await run(["journey", "jrn_1"], io);
    // The failure at the end is exactly what truncation would have hidden.
    expect(out.join("\n")).toContain("move-message-to-dead-letter");
  });

  it("shows the changed field with --diff", async () => {
    respond = () => ({
      status: 200,
      body: {
        data: {
          ...EVENTS[0],
          journeyId: "jrn_1",
          payloadDiff: {
            changes: [
              { kind: "removed", path: "Phone", before: "+1 919 555 1234" },
              { kind: "added", path: "phone", after: null }
            ]
          }
        }
      }
    });

    const { out, io } = capture(env());
    expect(await run(["event", "evt_1", "--diff"], io)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Phone");
    expect(text).toContain("+1 919 555 1234");
  });

  it("emits raw JSON with --json, and no escape codes", async () => {
    respond = () => ({
      status: 200,
      body: { data: { items: [{ id: "p1", slug: "demo", name: "Demo" }] } }
    });

    const { out, io } = capture(env(), true);
    expect(await run(["projects", "--json"], io)).toBe(0);
    const text = out.join("\n");
    expect(JSON.parse(text)).toEqual([{ id: "p1", slug: "demo", name: "Demo" }]);
    // A TTY would otherwise get colour, which would make the JSON unparseable.
    expect(text).not.toContain("\u001b");
  });

  it("sends the project header when one is configured", async () => {
    const { io } = capture({ ...env(), WAYSCRIBE_PROJECT: "proj-1" });
    await run(["projects"], io);
    expect(seenProject[0]).toBe("proj-1");
  });

  it("omits the project header when none is configured", async () => {
    // The control: an API key names its own project, and an empty header would
    // read as a request for a project called "".
    const { io } = capture(env());
    await run(["projects"], io);
    expect(seenProject[0]).toBeUndefined();
  });

  it("explains an unauthorized answer instead of repeating it", async () => {
    respond = () => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "An admin token is required." } }
    });

    const { err, io } = capture(env());
    expect(await run(["projects"], io)).toBe(1);
    expect(err.join("\n")).toContain("WAYSCRIBE_TOKEN");
  });

  it("names the fix when an admin token has not chosen a project", async () => {
    respond = () => ({
      status: 400,
      body: { error: { code: "project_required", message: "x-wayscribe-project-id is required." } }
    });

    const { err, io } = capture(env());
    await run(["search", "anything"], io);
    expect(err.join("\n")).toContain("--project");
  });

  it("says the server is unreachable rather than 'fetch failed'", async () => {
    // Port 1 refuses connections everywhere we care about.
    const { err, io } = capture({
      WAYSCRIBE_URL: "http://127.0.0.1:1",
      WAYSCRIBE_TOKEN: "t"
    });
    expect(await run(["projects"], io)).toBe(1);
    expect(err.join("\n")).toContain("Cannot reach");
  });

  it.each(["zero", "5abc", "2.5", "0", "-1", " 5", "1e2", ""])(
    "rejects --limit %j rather than sending it",
    async (value) => {
      // parseInt read "5abc" as 5 and sent it: the same defect F-029 found in
      // the API's own reading of limit.
      const { err, io } = capture(env());
      // The `=` form, which parseArgs accepts for a value starting with "-".
      expect(await run(["search", "x", `--limit=${value}`], io)).toBe(2);
      expect(err.join("\n")).toContain(
        `--limit must be a whole number of at least 1, not "${value}".`
      );
      expect(seen).toHaveLength(0);
    }
  );

  it("says in its help that the server reads a --limit above 100 as 100", async () => {
    const { out, io } = capture(env());
    expect(await run(["--help"], io)).toBe(0);
    expect(out.join("\n")).toContain(
      "--limit <n>        search only, default 20; above 100 the server reads it as 100"
    );
  });

  it("rejects an unknown command", async () => {
    const { err, io } = capture(env());
    expect(await run(["delete", "everything"], io)).toBe(2);
    expect(err.join("\n")).toContain("Unknown command");
  });
});

it("does not execute CLI commands when imported by another entry point", () => {
  expect(isEntryPoint("/tmp/test-runner.js", new URL("./cli.ts", import.meta.url).href)).toBe(
    false
  );
});

it("recognizes the declared executable through a bin symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayscribe-bin-"));
  try {
    const bin = join(directory, "wayscribe");
    const moduleUrl = new URL("./cli.ts", import.meta.url).href;
    symlinkSync(fileURLToPath(moduleUrl), bin);
    expect(isEntryPoint(bin, moduleUrl)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
