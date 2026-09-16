import { fileURLToPath } from "node:url";
import {
  appliesTo,
  compareExpectation,
  expand,
  expectedCaseIds,
  loadConformanceCases
} from "@flight-recorder/protocol/conformance";
import { beforeAll, describe, expect, it } from "vitest";
import { captureCase, type CapturedCase } from "./conformance-harness.js";

/**
 * Every applicable `sdk` conformance case, driven against a stub endpoint.
 *
 * The recorder is the real one, and what is compared is the request body it
 * actually sent. That body is the only thing a second SDK in another language
 * has to reproduce, and `apps/api` takes the same bytes and sends them to the
 * dry run, which is the procedure any implementation follows: record, capture
 * what your SDK sent, send those bytes to the dry run, compare. The SDK never
 * calls the dry run itself.
 */
const sdkDirectory = fileURLToPath(new URL("../../protocol/conformance/sdk", import.meta.url));

/** A diagnostic's detail as text, whatever it holds. */
function printed(detail: unknown): string {
  try {
    return JSON.stringify(detail, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value
    );
  } catch {
    return String(detail);
  }
}

/** This harness's language, for `languages` on a case that needs a host value. */
const LANGUAGE = "node";

describe("sdk conformance cases", () => {
  const cases = loadConformanceCases(sdkDirectory);
  const captured = new Map<string, CapturedCase>();

  beforeAll(async () => {
    for (const one of cases.filter((candidate) => appliesTo(candidate, LANGUAGE))) {
      captured.set(one.id, await captureCase(one, "fixture"));
    }
  });

  it("runs exactly the cases the manifest lists", () => {
    // Compared by id rather than by count: a count guard with slack in it lets
    // a case file be deleted without failing anything.
    expect(cases.map((one) => one.id)).toEqual(expectedCaseIds(sdkDirectory, "sdk"));
    expect(cases.every((one) => one.layer === "sdk")).toBe(true);
  });

  it("reports the cases this harness cannot express, rather than passing them silently", () => {
    // A skip that nobody sees is a case that quietly stopped running. These are
    // the ones whose values need a host language feature; every other harness
    // has to report its own list the same way.
    const skipped = cases.filter((one) => !appliesTo(one, LANGUAGE)).map((one) => one.id);
    expect(skipped).toEqual([]);
  });

  // Generated only for what a case asserts. A test registered for every case
  // and skipped where the case has no such expectation reported 72 skips on
  // every run, and a skip count nobody reads is how a real skip hides.
  const applicable = cases.filter((one) => appliesTo(one, LANGUAGE));
  describe.each(applicable.map((one) => [one.id, one] as const))("%s", (id, one) => {
    it("puts the expected event on the wire", () => {
      const result = captured.get(id);
      expect(result, "the case was never captured").toBeDefined();
      if (result === undefined) return;

      if (one.expect.wire === undefined) {
        // A case with no wire expectation is about how many events arrive, not
        // about what one of them holds.
        expect(result.events.length).toBe((one.expect.results ?? []).length);
        return;
      }

      // One event per expected result, which is what a group case is about.
      expect(result.events.length).toBe((one.expect.results ?? []).length);
      const first = result.events[0];
      expect(first, "the recorder sent nothing").toBeDefined();
      expect(
        compareExpectation(first, expand(one.expect.wire, { run: "fixture" }), "wire")
      ).toEqual([]);
    });

    const absent = one.expect.absentFromDiagnostics;
    if (absent !== undefined) {
      it("puts none of the listed text in any diagnostic", () => {
        const reported = captured.get(id)?.diagnostics ?? [];
        expect(reported.length, "the case reported nothing, so it checks nothing").toBeGreaterThan(
          0
        );
        const text = reported
          .map((entry) => `${entry.reason}\n${printed(entry.detail)}`)
          .join("\n");
        for (const listed of absent) {
          expect(text, `a diagnostic contains ${listed}`).not.toContain(listed);
        }
      });
    }

    const expected = one.expect.diagnostics;
    if (expected !== undefined) {
      it("reports the expected diagnostics", () => {
        const result = captured.get(id);
        // Only the kinds the case names are compared, so a diagnostic of
        // another kind an implementation adds does not fail the case.
        const kinds = new Set(expected.map((entry) => entry.kind));
        const reported = (result?.diagnostics ?? []).filter((entry) => kinds.has(entry.kind));
        expect(reported.map((entry) => entry.kind)).toEqual(expected.map((entry) => entry.kind));
        expected.forEach((entry, index) => {
          if (entry.detail === undefined) return;
          expect(
            compareExpectation(
              reported[index]?.detail,
              entry.detail,
              `diagnostics[${String(index)}]`
            )
          ).toEqual([]);
        });
      });
    }
  });

  it("splits more events than the batch ceiling across more than one request", () => {
    const result = captured.get("sdk/hundred-and-one-events");
    expect(result?.events.length).toBe(101);
    // The SDK half of wire/batch-of-101: a recorder never puts more than the
    // ceiling in one request, so this is two requests rather than a refusal.
    expect(result?.requests).toBeGreaterThan(1);
  });
});
