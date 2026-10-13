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

  describe("likely causes (ADR-072)", () => {
    const CAUSE = {
      field: "phone",
      reportedBy: "evt_deliver",
      eventId: "evt_transform",
      step: "transform-salesforce-account",
      change: {
        kind: "renamed-changed",
        lost: true,
        path: "phone",
        from: "Phone",
        before: "+1 919 555 1234",
        after: null
      },
      alsoChangedAt: [{ eventId: "evt_normalize", step: "normalize-phone" }]
    };
    const row = (
      id: string,
      operation: string,
      name: string,
      at: string,
      extra: Record<string, unknown> = {}
    ): Record<string, unknown> => ({
      id,
      operation,
      name,
      service: "sync-worker",
      eventTimestamp: `2026-08-06T10:00:0${at}.000Z`,
      durationMs: null,
      hasInput: false,
      hasOutput: false,
      hasError: false,
      ...extra
    });
    const TIMELINE = [
      row("evt_transform", "transformed", "transform-salesforce-account", "0"),
      row("evt_deliver", "delivered", "deliver-customer-to-target", "2", {
        hasError: true,
        likelyCauses: [CAUSE]
      }),
      row("evt_dead_letter", "failed", "move-message-to-dead-letter", "5", {
        hasError: true,
        likelyCauses: [CAUSE]
      })
    ];
    const failedEvent = (causes: unknown[]): unknown => ({
      ...row("evt_dead_letter", "failed", "move-message-to-dead-letter", "5", {
        hasError: true,
        likelyCauses: causes
      }),
      journeyId: "jrn_1",
      error: { message: "The target refused the customer." }
    });

    it("prints the journey's likely cause under the step that failed it, and nowhere else", async () => {
      respond = (path) =>
        path.startsWith("/v1/journeys/jrn_1/events")
          ? { status: 200, body: { data: { items: TIMELINE, nextCursor: null } } }
          : {
              status: 200,
              body: {
                data: {
                  ...JOURNEY,
                  eventCount: 3,
                  failedStep: "move-message-to-dead-letter",
                  likelyCauses: [CAUSE]
                }
              }
            };
      const { out, io } = capture(env());
      expect(await run(["journey", "jrn_1"], io)).toBe(0);
      const lines = out.join("\n").split("\n");
      const failed = lines.findIndex((line) => line.includes("move-message-to-dead-letter"));
      expect(lines.slice(failed + 1, failed + 3)).toEqual([
        "  Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by deliver-customer-to-target",
        "  Also changed earlier at: normalize-phone"
      ]);
      expect(lines.filter((line) => line.includes("Likely cause:"))).toHaveLength(1);
    });

    it("prints a failed event's likely cause", async () => {
      respond = () => ({ status: 200, body: { data: failedEvent([CAUSE]) } });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_dead_letter"], io)).toBe(0);
      const lines = out.join("\n").split("\n");
      expect(lines).toContain(
        "  Likely cause: phone lost at transform-salesforce-account (was +1 919 555 1234), reported by evt_deliver"
      );
      expect(lines).toContain("  Also changed earlier at: normalize-phone");
    });

    it("names the changed path and the field it sits in when the change is below the field", async () => {
      const below = {
        ...CAUSE,
        field: "Address",
        reportedBy: "evt_dead_letter",
        change: {
          kind: "changed",
          lost: false,
          path: "address.postal_code",
          before: "27601",
          after: "2760"
        },
        alsoChangedAt: []
      };
      // The field itself, matched across a rename: not below it.
      const atField = {
        ...CAUSE,
        field: "Status__c",
        reportedBy: "evt_dead_letter",
        change: {
          kind: "renamed-changed",
          lost: false,
          path: "status",
          from: "Status__c",
          before: "Former Customer",
          after: "former customer"
        },
        alsoChangedAt: [],
        incomplete: true
      };
      respond = () => ({ status: 200, body: { data: failedEvent([below, atField]) } });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_dead_letter"], io)).toBe(0);
      const lines = out.join("\n").split("\n");
      expect(lines.filter((line) => line.startsWith("  "))).toEqual([
        "  Likely cause: address.postal_code (in Address) changed at transform-salesforce-account (was 27601, now 2760)",
        "  Likely cause: Status__c changed at transform-salesforce-account (was Former Customer, now former customer)",
        "  Some earlier steps' changes were too large to check."
      ]);
    });

    it("puts the line under the last failing step of that name, not an earlier attempt", async () => {
      const attempts = [
        row("evt_transform", "transformed", "transform-salesforce-account", "0"),
        row("evt_attempt_1", "delivered", "deliver-customer-to-target", "2", {
          hasError: true,
          likelyCauses: [CAUSE]
        }),
        row("evt_attempt_2", "delivered", "deliver-customer-to-target", "4", {
          hasError: true,
          likelyCauses: [CAUSE]
        })
      ];
      respond = (path) =>
        path.startsWith("/v1/journeys/jrn_1/events")
          ? { status: 200, body: { data: { items: attempts, nextCursor: null } } }
          : {
              status: 200,
              body: {
                data: {
                  ...JOURNEY,
                  eventCount: 3,
                  failedStep: "deliver-customer-to-target",
                  likelyCauses: [CAUSE]
                }
              }
            };
      const { out, io } = capture(env());
      expect(await run(["journey", "jrn_1"], io)).toBe(0);
      const lines = out.join("\n").split("\n");
      const steps = lines.flatMap((line, index) =>
        line.includes("deliver-customer-to-target") && !line.includes("Likely cause:")
          ? [index]
          : []
      );
      expect(steps).toHaveLength(2);
      const cause = lines.findIndex((line) => line.includes("Likely cause:"));
      expect(cause).toBe((steps[1] ?? -1) + 1);
      expect(lines.filter((line) => line.includes("Likely cause:"))).toHaveLength(1);
    });

    it("bounds a long value as the web app does", async () => {
      const long = {
        ...CAUSE,
        reportedBy: "evt_dead_letter",
        change: { ...CAUSE.change, before: "9".repeat(400) },
        alsoChangedAt: []
      };
      respond = () => ({ status: 200, body: { data: failedEvent([long]) } });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_dead_letter"], io)).toBe(0);
      expect(out.join("\n").split("\n")).toContain(
        `  Likely cause: phone lost at transform-salesforce-account (was ${"9".repeat(300)}…)`
      );
    });

    it("prints no likely-cause line when a failure has none", async () => {
      respond = () => ({ status: 200, body: { data: failedEvent([]) } });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_dead_letter"], io)).toBe(0);
      expect(out.join("\n")).not.toContain("Likely cause");
    });
  });

  describe("server strings with control characters", () => {
    // An ESC sequence that clears the screen, a newline that breaks the
    // indented layout, a C1 CSI and a right-to-left override.
    const HOSTILE = "x\u001b[2J\ny\u009b\u202e";
    const SHOWN = "x\\x1b[2J\\ny\\u{9b}\\u{202e}";
    // What must never reach the terminal from a server string. Lines are
    // checked one by one, so the joining newlines are not counted.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    const UNSAFE = /[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/u;
    const safeLines = (lines: string[]): string[] => {
      const split = lines.join("\n").split("\n");
      expect(split.filter((line) => UNSAFE.test(line))).toEqual([]);
      return split;
    };
    const hostileEvent = {
      id: `evt_${HOSTILE}`,
      operation: "failed",
      name: `step-${HOSTILE}`,
      service: `svc-${HOSTILE}`,
      eventTimestamp: "2026-08-06T10:00:05.000Z",
      durationMs: null,
      hasInput: true,
      hasOutput: false,
      hasError: true
    };
    const hostileCause = {
      field: "phone",
      reportedBy: hostileEvent.id,
      eventId: "evt_transform",
      step: HOSTILE,
      change: { kind: "changed", lost: false, path: "phone", before: HOSTILE, after: HOSTILE },
      alsoChangedAt: [{ eventId: "evt_other", step: HOSTILE }]
    };

    it("escapes them in an event's error, step name and likely-cause values", async () => {
      respond = () => ({
        status: 200,
        body: {
          data: {
            ...hostileEvent,
            journeyId: "jrn_1",
            error: { message: HOSTILE, code: HOSTILE },
            likelyCauses: [hostileCause],
            inputPayload: { note: "a\u001bb", c1: "c\u009bd" }
          }
        }
      });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_1"], io)).toBe(0);
      const lines = safeLines(out);
      expect(lines[0]).toBe(`failed  step-${SHOWN}`);
      expect(lines[1]).toContain(`evt_${SHOWN}  ·  svc-${SHOWN}  ·`);
      expect(lines).toContain(`error  ${SHOWN}`);
      expect(lines).toContain(
        `  Likely cause: phone changed at ${SHOWN} (was ${SHOWN}, now ${SHOWN})`
      );
      expect(lines).toContain(`  Also changed earlier at: ${SHOWN}`);
      // JSON already escaped the C0 character; it is not escaped twice.
      expect(lines).toContain('  "note": "a\\u001bb",');
      expect(lines).toContain('  "c1": "c\\u009bd"');
    });

    it("escapes them in a journey timeline, keeping one line per step", async () => {
      respond = (path) =>
        path.startsWith("/v1/journeys/")
          ? path.includes("/events")
            ? { status: 200, body: { data: { items: [hostileEvent], nextCursor: null } } }
            : {
                status: 200,
                body: {
                  data: {
                    ...JOURNEY,
                    journeyId: HOSTILE,
                    entity: { type: HOSTILE, id: HOSTILE },
                    aliases: [{ type: HOSTILE, displayValue: HOSTILE }],
                    services: [HOSTILE],
                    failedStep: hostileEvent.name,
                    likelyCauses: [hostileCause]
                  }
                }
              }
          : { status: 404, body: {} };
      const { out, io } = capture(env());
      expect(await run(["journey", "jrn_1"], io)).toBe(0);
      const lines = safeLines(out);
      expect(lines[0]).toBe(`${SHOWN}:${SHOWN}`);
      expect(lines[1]).toContain(`${SHOWN}  ·  failed  ·  1 events  ·  ${SHOWN}`);
      expect(lines[2]).toBe(`also known as  ${SHOWN}=${SHOWN}`);
      const steps = lines.filter(
        (line) => line.includes(`step-${SHOWN}`) && !line.includes("Likely cause:")
      );
      expect(steps).toHaveLength(1);
      expect(steps[0]).toContain(`svc-${SHOWN}`);
      // The reporter is named by its step, matched on the raw id.
      expect(lines).toContain(
        `  Likely cause: phone changed at ${SHOWN} (was ${SHOWN}, now ${SHOWN}), reported by step-${SHOWN}`
      );
    });

    it("escapes them in search results and the project list", async () => {
      respond = (path) =>
        path.startsWith("/v1/search")
          ? {
              status: 200,
              body: {
                data: {
                  items: [
                    {
                      ...JOURNEY,
                      journeyId: HOSTILE,
                      entity: { type: "c", id: HOSTILE },
                      status: HOSTILE
                    }
                  ]
                }
              }
            }
          : {
              status: 200,
              body: { data: { items: [{ id: HOSTILE, slug: HOSTILE, name: HOSTILE }] } }
            };
      const search = capture(env());
      expect(await run(["search", "x"], search.io)).toBe(0);
      const found = safeLines(search.out);
      expect(found).toHaveLength(2);
      expect(found[1]).toContain(SHOWN);

      const projects = capture(env());
      expect(await run(["projects"], projects.io)).toBe(0);
      const listed = safeLines(projects.out);
      expect(listed).toHaveLength(2);
      expect(listed[1]).toBe(`${SHOWN}  ${SHOWN.padEnd(28)}${SHOWN}`);
    });

    it("escapes them in a diff and in an API error", async () => {
      respond = (path) =>
        path.startsWith("/v1/events/")
          ? {
              status: 200,
              body: {
                data: {
                  ...hostileEvent,
                  journeyId: "jrn_1",
                  payloadDiff: {
                    changes: [{ kind: "changed", path: HOSTILE, before: HOSTILE, after: "ok" }]
                  }
                }
              }
            }
          : { status: 400, body: { error: { code: "bad_request", message: HOSTILE } } };
      const diff = capture(env());
      expect(await run(["event", "evt_1", "--diff"], diff.io)).toBe(0);
      const lines = safeLines(diff.out);
      expect(lines.some((line) => line.startsWith(`${SHOWN}  `))).toBe(true);

      const failed = capture(env());
      expect(await run(["search", "x"], failed.io)).toBe(1);
      expect(safeLines(failed.err).join("\n")).toContain(SHOWN);
    });

    it("emits --json that parses to the same value, with no raw C1 or bidi characters", async () => {
      const data = {
        ...hostileEvent,
        journeyId: "jrn_1",
        name: "a\u007fb\u009bc\u202ed\u061ce\u200ef\u2066g",
        "k\u200f": "東京 🚀"
      };
      respond = () => ({ status: 200, body: { data } });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_1", "--json"], io)).toBe(0);
      safeLines(out);
      expect(out.join("\n")).toContain('"a\\u007fb\\u009bc\\u202ed\\u061ce\\u200ef\\u2066g"');
      expect(JSON.parse(out.join("\n"))).toEqual(data);
    });

    it("escapes a journey's status and its steps' operations, and aligns by what is shown", async () => {
      const steps = [
        {
          ...hostileEvent,
          operation: "o\u001b\u001b\u001b\u001b",
          name: "n\u001b\u001b\u001b",
          service: "svc-a"
        },
        { ...hostileEvent, id: "evt_2", operation: "plain", name: "named", service: "svc-b" }
      ];
      respond = (path) =>
        path.includes("/events")
          ? { status: 200, body: { data: { items: steps, nextCursor: null } } }
          : { status: 200, body: { data: { ...JOURNEY, status: HOSTILE } } };
      const { out, io } = capture(env());
      expect(await run(["journey", "jrn_1"], io)).toBe(0);
      const lines = safeLines(out);
      expect(lines[1]).toContain(`jrn_1  ·  ${SHOWN}  ·  2 events`);
      const first = lines.find((line) => line.includes("svc-a")) ?? "";
      const second = lines.find((line) => line.includes("svc-b")) ?? "";
      expect(first).toContain("o\\x1b\\x1b\\x1b\\x1b");
      expect(first.indexOf("n\\x1b")).toBe(second.indexOf("named"));
      expect(first.indexOf("svc-a")).toBe(second.indexOf("svc-b"));
    });

    it("escapes a likely cause's field, and the path below it", async () => {
      const field = `a${HOSTILE}`;
      const below = {
        ...hostileCause,
        field,
        change: { ...hostileCause.change, path: `${field}.zip` }
      };
      const atField = { ...hostileCause, field: HOSTILE };
      respond = () => ({
        status: 200,
        body: { data: { ...hostileEvent, journeyId: "jrn_1", likelyCauses: [below, atField] } }
      });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_1"], io)).toBe(0);
      const lines = safeLines(out);
      expect(lines).toContain(
        `  Likely cause: a${SHOWN}.zip (in a${SHOWN}) changed at ${SHOWN} (was ${SHOWN}, now ${SHOWN})`
      );
      expect(lines).toContain(
        `  Likely cause: ${SHOWN} changed at ${SHOWN} (was ${SHOWN}, now ${SHOWN})`
      );
    });

    it("aligns a diff by the escaped width of its paths", async () => {
      respond = () => ({
        status: 200,
        body: {
          data: {
            ...hostileEvent,
            journeyId: "jrn_1",
            payloadDiff: {
              changes: [
                { kind: "changed", path: "p\u001b\u001b\u001b", before: "v1", after: "w1" },
                { kind: "changed", path: "plain-path", before: "v2", after: "w2" }
              ]
            }
          }
        }
      });
      const { out, io } = capture(env());
      expect(await run(["event", "evt_1", "--diff"], io)).toBe(0);
      const lines = safeLines(out);
      const rows = lines.filter((line) => line.includes('"v'));
      expect(rows).toHaveLength(2);
      expect(rows[0]?.indexOf('"v1"')).toBe(rows[1]?.indexOf('"v2"'));
    });

    it("bounds a search entity by its escaped width without cutting an escape", async () => {
      respond = () => ({
        status: 200,
        body: {
          data: {
            items: [
              { ...JOURNEY, journeyId: "jrn_1", entity: { type: "c", id: "\u001b".repeat(10) } }
            ]
          }
        }
      });
      const { out, io } = capture(env());
      expect(await run(["search", "x"], io)).toBe(0);
      const row = safeLines(out)[1] ?? "";
      expect(row.slice(44, 70)).toBe(`c:${"\\x1b".repeat(5)}…`.padEnd(26));
      expect(row.slice(70, 80)).toBe("failed    ");
    });
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
