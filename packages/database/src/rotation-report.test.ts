import { describe, expect, it } from "vitest";
import type {
  ApiKeyNotCurrent,
  RotationStatus,
  TableReencryption
} from "./repositories/rotation.js";
import {
  formatReencryptStart,
  formatReencryption,
  formatRotationStatus
} from "./rotation-report.js";

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
  apiKeys: { current: 2, notCurrent: [], notRecorded: [], unknownKey: [] },
  rowsRemaining: 0,
  complete: true,
  ...overrides
});

describe("formatReencryption", () => {
  it("prints one line per table, beginning with its name, counts in a fixed order", () => {
    const lines = formatReencryption("rotate", [
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
    const lines = formatReencryption("rotate", [tableResult("journeys", { alreadyCurrent: 9 })]);
    expect(lines).toContain(
      "Nothing to rewrite: every readable value was already under the current key."
    );
  });

  it("asks for another run when rows changed underneath it", () => {
    const lines = formatReencryption("rotate", [tableResult("journeys", { changedDuringRun: 1 })]);
    expect(lines).toContain(
      "1 row changed while this ran and was left alone. Run rotate:reencrypt again."
    );
  });
});

describe("formatReencryptStart", () => {
  it("names the mode that ran", () => {
    expect(formatReencryptStart("bbbbbbbbbbbb", null)).toBe(
      "Upgrading legacy values under key bbbbbbbbbbbb. ENCRYPTION_KEY_PREVIOUS is not set, so nothing is rotated."
    );
    expect(formatReencryptStart("bbbbbbbbbbbb", "aaaaaaaaaaaa")).toBe(
      "Re-encrypting under key bbbbbbbbbbbb, reading values under aaaaaaaaaaaa and legacy values."
    );
  });

  it("says when an upgrade had nothing to do", () => {
    const lines = formatReencryption("upgrade", [tableResult("journeys", { alreadyCurrent: 3 })]);
    expect(lines).toContain(
      "Nothing to upgrade: no legacy value the current key can read was left."
    );
  });
});

describe("formatRotationStatus", () => {
  it("tells the operator the previous key can go once everything is current", () => {
    const lines = formatRotationStatus(cleanStatus());
    expect(lines).toContain("Previous key: aaaaaaaaaaaa");
    expect(lines.at(-1)).toBe(
      // Recreate, not restart: `docker compose restart` keeps the environment the
      // container was created with, so the key would still be there.
      "Complete: every row and API key is under the current key. Remove ENCRYPTION_KEY_PREVIOUS and recreate the API containers (docs/OPERATIONS.md §6)."
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
        notRecorded: [],
        unknownKey: [],
        notCurrent: [
          {
            keyPrefix: "wsk_abcdefgh",
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
    expect(lines.find((line) => line.startsWith("wsk_abcdefgh"))).toMatch(
      /^wsk_abcdefgh\s+acme\/production\s+worker\s+not recorded\s+never$/
    );
    expect(lines.at(-1)).toBe("Not complete: 2 rows and 1 API key are not under the current key.");
  });

  it("warns that rows with no value stop matching search once the previous key is removed", () => {
    const status = cleanStatus();
    const [journeys, aliases, destinations] = status.tables;
    if (journeys === undefined || aliases === undefined || destinations === undefined) {
      throw new Error("fixture");
    }
    journeys.noValue = 2;
    destinations.noValue = 5;

    const lines = formatRotationStatus(status);
    expect(lines).toContain(
      "journeys has 2 rows with no stored value. Their search tokens stay under the previous key, " +
        "so they will stop matching search once ENCRYPTION_KEY_PREVIOUS is removed."
    );
    // Replay destinations have no search token; no headers is just no headers.
    expect(lines.join("\n")).not.toContain("replay_destinations has");
    expect(lines.at(-1)).toMatch(/^Complete:/);

    expect(formatRotationStatus({ ...status, previousKeyId: null }).join("\n")).not.toContain(
      "stop matching search"
    );
  });

  it("lists keys with no recorded id apart when no rotation is under way, without holding status open", () => {
    // An install from before key ids were stored, with no previous key: the
    // key is under the only key there is, and records its id when next used.
    const unrecorded = {
      keyPrefix: "wsk_abcdefgh",
      name: "worker",
      projectSlug: "acme",
      environmentName: "production",
      keyHashKeyId: null,
      lastUsedAt: null
    };
    const lines = formatRotationStatus(
      cleanStatus({
        previousKeyId: null,
        complete: true,
        apiKeys: { current: 1, notCurrent: [], notRecorded: [unrecorded], unknownKey: [] }
      })
    );

    expect(lines).toContain("API keys not yet under the current key: 0");
    expect(lines).toContain("API keys with key id not recorded yet; recorded on next use: 1");
    expect(lines.find((line) => line.startsWith("wsk_abcdefgh"))).toMatch(
      /^wsk_abcdefgh\s+acme\/production\s+worker\s+not recorded\s+never$/
    );
    expect(lines.join("\n")).not.toContain("Each moves to the current key");
    expect(lines.at(-1)).toBe("Complete: every row and API key is under the current key.");
  });

  it("does not promise that a key under an unconfigured key will move, and says how to let it authenticate", () => {
    const key = (keyPrefix: string, keyHashKeyId: string): ApiKeyNotCurrent => ({
      keyPrefix,
      name: "worker",
      projectSlug: "acme",
      environmentName: "production",
      keyHashKeyId,
      lastUsedAt: null
    });
    const lines = formatRotationStatus(
      cleanStatus({
        complete: false,
        apiKeys: {
          current: 0,
          notCurrent: [key("wsk_previous", "aaaaaaaaaaaa")],
          notRecorded: [],
          unknownKey: [key("wsk_orphan01", "cccccccccccc"), key("wsk_orphan02", "cccccccccccc")]
        }
      })
    );
    const text = lines.join("\n");

    expect(lines).toContain("API keys not yet under the current key: 1");
    expect(lines).toContain("API keys under a key that is not configured: 2");
    expect(text).toContain(
      "These are under cccccccccccc, which is not configured. Set ENCRYPTION_KEY_PREVIOUS to that key to let them authenticate."
    );
    // The promise to move on use belongs to the previous key's section alone.
    const promise = lines.findIndex((line) => line.startsWith("Each moves to the current key"));
    const unknownSection = lines.indexOf("API keys under a key that is not configured: 2");
    expect(promise).toBeGreaterThan(-1);
    expect(promise).toBeLessThan(unknownSection);
    expect(lines.filter((line) => line.startsWith("Each moves"))).toHaveLength(1);
    expect(lines.at(-1)).toBe("Not complete: 0 rows and 3 API keys are not under the current key.");
  });
});
