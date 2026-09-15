import { describe, expect, it } from "vitest";
import type { RotationStatus, TableReencryption } from "./repositories/rotation.js";
import { formatReencryption, formatRotationStatus } from "./rotation-report.js";

const tableResult = (
  table: TableReencryption["table"],
  counts: Partial<TableReencryption> = {}
): TableReencryption => ({
  table,
  rewritten: 0,
  alreadyCurrent: 0,
  unrecoverable: 0,
  noValue: 0,
  duplicatesRemoved: 0,
  changedDuringRun: 0,
  batches: 0,
  ...counts
});

const cleanStatus = (overrides: Partial<RotationStatus> = {}): RotationStatus => ({
  currentKeyId: "bbbbbbbbbbbb",
  previousKeyId: "aaaaaaaaaaaa",
  tables: (["journeys", "entity_aliases", "replay_destinations"] as const).map((table) => ({
    table,
    current: 3,
    previous: 0,
    legacy: 0,
    unknownKey: 0,
    malformed: 0,
    noValue: 0,
    unknownKeyIds: []
  })),
  apiKeys: { current: 2, notCurrent: [] },
  rowsRemaining: 0,
  complete: true,
  ...overrides
});

describe("formatReencryption", () => {
  it("prints one line per table, beginning with its name, counts in a fixed order", () => {
    const lines = formatReencryption([
      tableResult("journeys", { rewritten: 1200, alreadyCurrent: 4, noValue: 2 }),
      tableResult("entity_aliases", { rewritten: 7, duplicatesRemoved: 1, unrecoverable: 3 }),
      tableResult("replay_destinations")
    ]);

    expect(lines).toContain(
      "journeys                   1200                4              0         2                   -"
    );
    expect(lines.find((line) => line.startsWith("entity_aliases"))).toMatch(
      /^entity_aliases\s+7\s+0\s+3\s+0\s+1$/
    );
    expect(lines).toContain("Rewrote 1207 values and removed 1 duplicate alias row.");
    expect(lines.join("\n")).toContain("3 values could not be read");
  });

  it("says so when there was nothing to rewrite", () => {
    const lines = formatReencryption([tableResult("journeys", { alreadyCurrent: 9 })]);
    expect(lines).toContain(
      "Nothing to rewrite: every readable value was already under the current key."
    );
  });

  it("asks for another run when rows changed underneath it", () => {
    const lines = formatReencryption([tableResult("journeys", { changedDuringRun: 1 })]);
    expect(lines).toContain(
      "1 row changed while this ran and was left alone. Run rotate:reencrypt again."
    );
  });
});

describe("formatRotationStatus", () => {
  it("tells the operator the previous key can go once everything is current", () => {
    const lines = formatRotationStatus(cleanStatus());
    expect(lines).toContain("Previous key: aaaaaaaaaaaa");
    expect(lines.at(-1)).toBe(
      "Complete: every row and API key is under the current key. Remove ENCRYPTION_KEY_PREVIOUS and restart."
    );
  });

  it("lists API keys still under another key, and names removed keys", () => {
    const status = cleanStatus({
      complete: false,
      rowsRemaining: 2,
      tables: [
        {
          table: "journeys",
          current: 1,
          previous: 0,
          legacy: 0,
          unknownKey: 2,
          malformed: 0,
          noValue: 0,
          unknownKeyIds: ["cccccccccccc"]
        }
      ],
      apiKeys: {
        current: 0,
        notCurrent: [
          {
            keyPrefix: "fr_abcdefghi",
            name: "worker",
            projectSlug: "acme",
            environmentName: "production",
            keyHashKeyId: null,
            lastUsedAt: null
          }
        ]
      }
    });

    const lines = formatRotationStatus(status);
    expect(lines).toContain(
      "journeys                      1          0          0            2          0         0"
    );
    expect(lines.join("\n")).toContain(
      "journeys has rows under cccccccccccc, which is not configured."
    );
    expect(lines.find((line) => line.startsWith("fr_abcdefghi"))).toMatch(
      /^fr_abcdefghi\s+acme\/production\s+worker\s+unrecorded\s+never$/
    );
    expect(lines.at(-1)).toBe("Not complete: 2 rows and 1 API key are not under the current key.");
  });
});
