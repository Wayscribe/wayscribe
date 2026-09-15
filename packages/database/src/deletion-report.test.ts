import { describe, expect, it } from "vitest";
import {
  formatJourneyTable,
  parseIdentifierArgs,
  parseRangeArgs,
  parseTimestamp,
  reportErasure,
  reportErasureStopped,
  reportMatches,
  reportRange
} from "./deletion-report.js";
import type { MatchedJourney } from "./repositories/deletion.js";

const journey = (overrides: Partial<MatchedJourney> = {}): MatchedJourney => ({
  id: "jrn_1",
  environment: "production",
  entityType: "customer",
  eventCount: 3,
  lastEventAt: new Date("2026-09-01T12:34:56.789Z"),
  ...overrides
});

describe("parseTimestamp", () => {
  it("reads a date as midnight UTC and a timestamp with its offset", () => {
    expect(parseTimestamp("--before", "2026-09-01")).toEqual({
      ok: true,
      date: new Date("2026-09-01T00:00:00.000Z")
    });
    expect(parseTimestamp("--before", "2026-09-01T12:00:00+02:00")).toEqual({
      ok: true,
      date: new Date("2026-09-01T10:00:00.000Z")
    });
    expect(parseTimestamp("--after", "2026-09-01T12:00:00.5Z")).toEqual({
      ok: true,
      date: new Date("2026-09-01T12:00:00.500Z")
    });
  });

  it("refuses anything else with a message naming the flag and an example", () => {
    for (const raw of [
      "yesterday",
      "2026-13-01",
      "2026-02-30",
      "1 Sep 2026",
      // A time with no offset would be read in the server's local zone.
      "2026-09-01T12:00:00",
      ""
    ]) {
      const parsed = parseTimestamp("--before", raw);
      expect(parsed.ok, raw).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message).toContain("--before");
        expect(parsed.message).toContain("2026-09-01T00:00:00Z");
      }
    }
  });
});

describe("argument parsing", () => {
  it("reads delete:identifier's positionals and flags", () => {
    expect(
      parseIdentifierArgs(["acme", "cust-42", "--environment", "production", "--dry-run"])
    ).toEqual({
      ok: true,
      projectSlug: "acme",
      value: "cust-42",
      environment: "production",
      dryRun: true
    });
    expect(parseIdentifierArgs(["acme", "cust-42"])).toEqual({
      ok: true,
      projectSlug: "acme",
      value: "cust-42",
      environment: undefined,
      dryRun: false
    });
  });

  it("refuses delete:identifier with a missing value or an unknown flag", () => {
    for (const args of [["acme"], ["acme", "v", "--force"], ["acme", "v", "extra"]]) {
      const parsed = parseIdentifierArgs(args);
      expect(parsed.ok, args.join(" ")).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("Usage: delete:identifier");
    }
  });

  it("reads delete:range and compares its dates", () => {
    expect(
      parseRangeArgs(["acme", "production", "--before", "2026-09-01", "--after", "2026-08-01"])
    ).toEqual({
      ok: true,
      projectSlug: "acme",
      environment: "production",
      before: new Date("2026-09-01T00:00:00Z"),
      after: new Date("2026-08-01T00:00:00Z"),
      dryRun: false
    });

    const inverted = parseRangeArgs([
      "acme",
      "production",
      "--before",
      "2026-08-01",
      "--after",
      "2026-09-01"
    ]);
    expect(inverted).toEqual({
      ok: false,
      message:
        "--after (2026-09-01T00:00:00.000Z) must be earlier than --before (2026-08-01T00:00:00.000Z)."
    });

    const missing = parseRangeArgs(["acme", "production"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("--before is required");
  });
});

describe("formatJourneyTable", () => {
  it("lines columns up under a header", () => {
    const lines = formatJourneyTable([
      journey(),
      journey({ id: "jrn_longer_identifier", environment: "dev", eventCount: 1200 })
    ]);
    expect(lines[0]).toMatch(/^ID\s+ENVIRONMENT\s+ENTITY TYPE\s+EVENTS\s+LAST ACTIVITY$/);
    expect(lines[1]).toMatch(/^jrn_1\s+production\s+customer\s+3\s+2026-09-01 12:34:56$/);
    expect(lines[2]).toMatch(
      /^jrn_longer_identifier\s+dev\s+customer\s+1200\s+2026-09-01 12:34:56$/
    );
    expect(lines[1]?.indexOf("production")).toBe(lines[2]?.indexOf("dev"));
  });
});

describe("reports", () => {
  it("dry run prints the table and total and says nothing was deleted", () => {
    const report = reportMatches(
      { ok: true, journeys: [journey()], total: 1 },
      { projectSlug: "acme", scope: "all environments", command: "delete:identifier" }
    );
    expect(report.code).toBe(0);
    expect(report.stdout.join("\n")).toContain("1 journey matches");
    expect(report.stdout.join("\n")).toContain("Nothing was deleted");
    expect(report.stdout.join("\n")).toContain("jrn_1");
  });

  it("dry run says when the table is cut short", () => {
    const report = reportMatches(
      { ok: true, journeys: [journey()], total: 5000 },
      { projectSlug: "acme", scope: "production", command: "delete:range" }
    );
    expect(report.stdout.join("\n")).toContain("Showing the 1 most recent of 5000");
  });

  it("an unknown environment or empty value exits 1", () => {
    const context = { projectSlug: "acme", scope: "staging", command: "delete:identifier" };
    expect(reportMatches({ ok: false, reason: "environment_not_found" }, context)).toMatchObject({
      code: 1,
      stderr: ['No environment "staging" in project acme.']
    });
    expect(reportErasure({ ok: false, reason: "empty_value" }, context).code).toBe(1);
  });

  it("an erasure prints counts and never the value", () => {
    const report = reportErasure(
      { ok: true, deletedJourneys: 2, deletedEvents: 7, batches: 1, auditId: "a" },
      { projectSlug: "acme", scope: "all environments", command: "delete:identifier" }
    );
    expect(report.code).toBe(0);
    expect(report.stdout[0]).toBe(
      "Deleted 2 journeys and 7 events in acme (all environments). The audit log records the search token, not the value."
    );
  });

  it("an erasure that stopped says to run it again and exits 1", () => {
    const report = reportErasureStopped(
      { batch: 1, deletedJourneys: 500, deletedEvents: 900 },
      new Error("connection terminated")
    );
    expect(report.code).toBe(1);
    expect(report.stderr.join("\n")).toContain("after deleting 500 journeys");
    expect(report.stderr.join("\n")).toContain("Run delete:identifier again");
  });

  it("a range deletion reports a held lock and a lost lock as failures", () => {
    const context = { projectSlug: "acme", scope: "production", command: "delete:range" };
    const held = reportRange({ ok: false, reason: "lock_held" }, context);
    expect(held.code).toBe(1);
    expect(held.stderr.join("\n")).toContain("holds the retention lock");

    const lost = reportRange(
      {
        ok: true,
        environmentId: "e",
        deletedJourneys: 1000,
        deletedEvents: 4000,
        batches: 1,
        auditId: "a",
        lockLost: true
      },
      context
    );
    expect(lost.code).toBe(1);
    expect(lost.stdout[0]).toContain("Deleted 1000 journeys and 4000 events");
    expect(lost.stderr.join("\n")).toContain("lost the retention lock");
    expect(lost.stderr.join("\n")).toContain("run delete:range again");
  });
});
