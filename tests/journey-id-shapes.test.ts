import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { journeyEventSchema } from "../packages/protocol/src/event.js";
import { deriveJourneyId } from "../packages/sdk-node/src/journey-id.js";
import { findSection, read } from "./docs-helpers.js";

/**
 * EVENT_PROTOCOL.md section 4 states the two journey id shapes the Node SDK
 * makes (ADR-063, F-049), and that nothing may check them. This holds the
 * text to the code that makes and accepts them.
 */
describe("the journey id shapes in EVENT_PROTOCOL.md section 4", () => {
  const journeyId = (): string => {
    const fields = findSection(read("docs/EVENT_PROTOCOL.md"), "4. Required field semantics");
    return /### `journeyId`\n([\s\S]*?)\n### /.exec(fields ?? "")?.[1] ?? "";
  };

  const RANDOM = "jrn_dd37c205-7ea6-4e14-bc8f-c07022f96696";
  const DERIVED = "jrn_5f93deccb9b599e792d560765761bec6";

  it("gives both shapes with ADR-063's examples, and forbids parsing them", () => {
    const text = journeyId();
    expect(text).toContain(RANDOM);
    expect(text).toContain(DERIVED);
    expect(text).toContain("40 characters");
    expect(text).toContain("36 characters");
    expect(text).toContain("opaque string of 1 to 128 characters");
    expect(text).toContain("must not parse or");
    // The one character the database refuses, and what the reads answer.
    expect(text).toContain("contains a NUL is refused `unstorable_payload`");
    expect(text).toContain("answer `404` for such an id");
    // The recommendation neither shape matched is gone.
    expect(text).not.toContain("uuidv7");
  });

  it("describes the random shape the recorder makes", () => {
    const shape = /^jrn_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(read("packages/sdk-node/src/recorder.ts")).toContain("`jrn_${randomUUID()}`");
    const made = `jrn_${randomUUID()}`;
    expect(made).toMatch(shape);
    expect(made).toHaveLength(40);
    expect(RANDOM).toMatch(shape);
    expect(RANDOM).toHaveLength(40);
  });

  it("describes the derived shape SDK-55 computes", () => {
    const made = deriveJourneyId("s".repeat(32), "production", { type: "lead", id: "42" });
    expect(made).toMatch(/^jrn_[0-9a-f]{32}$/);
    expect(made).toHaveLength(36);
    expect(DERIVED).toMatch(/^jrn_[0-9a-f]{32}$/);
  });

  it("matches what the server accepts: any string of 1 to 128 characters, of any shape", () => {
    const accepts = (id: string): boolean =>
      journeyEventSchema.shape.journeyId.safeParse(id).success;
    expect(accepts(RANDOM)).toBe(true);
    expect(accepts(DERIVED)).toBe(true);
    expect(accepts("order 1001, not a prefix in sight")).toBe(true);
    expect(accepts("x".repeat(128))).toBe(true);
    expect(accepts("x".repeat(129))).toBe(false);
    expect(accepts("")).toBe(false);
  });
});
