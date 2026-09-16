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

  describe.each(cases.map((one) => [one.id, one] as const))("%s", (id, one) => {
    const applicable = appliesTo(one, LANGUAGE);

    it.runIf(applicable)("puts the expected event on the wire", () => {
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
  });

  it("splits more events than the batch ceiling across more than one request", () => {
    const result = captured.get("sdk/hundred-and-one-events");
    expect(result?.events.length).toBe(101);
    // The SDK half of wire/batch-of-101: a recorder never puts more than the
    // ceiling in one request, so this is two requests rather than a refusal.
    expect(result?.requests).toBeGreaterThan(1);
  });
});
