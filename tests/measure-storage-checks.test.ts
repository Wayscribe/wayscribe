import { describe, expect, it } from "vitest";
import { expectCompleteSweep, vacuumStatement } from "../scripts/measure-storage-checks.mjs";

describe("vacuumStatement", () => {
  const tables = ["journeys", "journey_events", "entity_aliases"];

  it.each([
    [[], "vacuum ??, ??, ??"],
    [["analyze"], "vacuum (analyze) ??, ??, ??"],
    [["full"], "vacuum (full) ??, ??, ??"]
  ] as const)("names every measured table, schema-qualified, with options %j", (options, sql) => {
    expect(vacuumStatement(options, "measure_storage_metadata_only", tables)).toEqual({
      sql,
      bindings: [
        "measure_storage_metadata_only.journeys",
        "measure_storage_metadata_only.journey_events",
        "measure_storage_metadata_only.entity_aliases"
      ]
    });
  });

  // A bare VACUUM processes every table in the database, and VACUUM FULL
  // rewrites each under an exclusive lock: run with --force against a real
  // installation, that stopped its ingestion. No input may produce one.
  it("refuses to build a statement without tables", () => {
    expect(() => vacuumStatement(["full"], "measure_storage_x", [])).toThrow(/every table/);
  });

  it.each(["", "public", "measure_storage_", "other_schema"])(
    "refuses a schema that is not a measurement schema: %j",
    (schema) => {
      expect(() => vacuumStatement([], schema, tables)).toThrow(/measurement schema/);
    }
  );
});

describe("expectCompleteSweep", () => {
  const complete = {
    ran: true,
    journeysDeleted: 5_000,
    batches: 5,
    environmentsExamined: 1,
    stoppedEarly: false
  };

  it("accepts a sweep that deleted exactly the expired journeys", () => {
    expect(() => {
      expectCompleteSweep(complete, 5_000);
    }).not.toThrow();
  });

  // The retention lock is database-wide. A sweep another process holds makes
  // this one skip or stop, and the size "after retention" would then be
  // measured over data retention never touched.
  it("fails when another process held the retention lock", () => {
    expect(() => {
      expectCompleteSweep({ ...complete, ran: false, journeysDeleted: 0 }, 5_000);
    }).toThrow(/did not run/);
  });

  it("fails when the sweep stopped early", () => {
    expect(() => {
      expectCompleteSweep({ ...complete, stoppedEarly: true, journeysDeleted: 3_000 }, 5_000);
    }).toThrow(/stopped early/);
  });

  it.each([4_999, 5_001, 0])("fails when it deleted %i rather than 5,000", (deleted) => {
    expect(() => {
      expectCompleteSweep({ ...complete, journeysDeleted: deleted }, 5_000);
    }).toThrow(/expected 5,000/);
  });
});
