import { describe, expect, it } from "vitest";
import { DRY_RUN_JOURNEY_LOCK, dryRunJourneyLockKey, dryRunJourneyLockKeys } from "./events.js";

const PROJECT = "00000000-0000-0000-0000-000000000000";

const element = (journeyId: unknown): unknown => ({ protocolVersion: "0.1", event: { journeyId } });

describe("the advisory lock keys a dry run takes (ADR-063)", () => {
  it("uses an int4 constant for the first key", () => {
    expect(Number.isInteger(DRY_RUN_JOURNEY_LOCK)).toBe(true);
    expect(DRY_RUN_JOURNEY_LOCK).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(DRY_RUN_JOURNEY_LOCK).toBeLessThan(2 ** 31);
  });

  it("reads the first four bytes of SHA-256 over project id, NUL, journey id as a signed big-endian int", () => {
    // sha256("00000000-0000-0000-0000-000000000000\0jrn_01") begins 12d878c5,
    // and "...\0jrn_06" begins 8bff663a, whose top bit makes it negative.
    expect(dryRunJourneyLockKey(PROJECT, "jrn_01")).toBe(0x12d878c5);
    expect(dryRunJourneyLockKey(PROJECT, "jrn_06")).toBe(0x8bff663a - 2 ** 32);
    expect(dryRunJourneyLockKey(PROJECT, "jrn_06")).toBe(-1_946_196_422);
  });

  it("depends on the project, so one project's dry runs never wait on another's", () => {
    expect(dryRunJourneyLockKey("11111111-1111-1111-1111-111111111111", "jrn_01")).not.toBe(
      dryRunJourneyLockKey(PROJECT, "jrn_01")
    );
  });

  it("deduplicates and sorts ascending, numerically rather than as text", () => {
    const keys = dryRunJourneyLockKeys(PROJECT, [
      element("jrn_01"),
      element("jrn_06"),
      element("jrn_10"),
      element("jrn_01"),
      element("jrn_08")
    ]);
    expect(keys).toEqual([-1_946_196_422, -1_475_547_605, -77_164_018, 316_176_581]);
  });

  it("adds nothing for an element with no journey id it can read", () => {
    expect(
      dryRunJourneyLockKeys(PROJECT, [
        null,
        "text",
        42,
        [],
        {},
        { event: null },
        { event: "jrn_01" },
        element(undefined),
        element(7),
        element({ id: "jrn_01" })
      ])
    ).toEqual([]);
  });

  it("does not check the id's shape: both SDK shapes and anything else are locked as given", () => {
    expect(
      dryRunJourneyLockKeys(PROJECT, [
        element("jrn_dd37c205-7ea6-4e14-bc8f-c07022f96696"),
        element("jrn_5f93deccb9b599e792d560765761bec6"),
        element("")
      ])
    ).toHaveLength(3);
  });
});
