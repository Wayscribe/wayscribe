import { JOURNEY_OPERATIONS } from "@flight-recorder/protocol";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "./operations.js";

describe("the operation union", () => {
  it("matches the protocol exactly", () => {
    // The SDK cannot import the protocol package at runtime — it is private and
    // unpublished — so the list is copied. This is what stops the copy drifting
    // into a verb the server will refuse.
    expect([...OPERATIONS].sort()).toEqual([...JOURNEY_OPERATIONS].sort());
  });

  it("contains the verbs the wrappers emit", () => {
    for (const operation of ["transformed", "persisted", "published", "delivered", "retried"]) {
      expect(OPERATIONS).toContain(operation);
    }
  });
});
