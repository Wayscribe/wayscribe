import { errorSchema } from "@flight-recorder/protocol";
import { describe, expect, it } from "vitest";
import { MAX_ERROR_MESSAGE_LENGTH, MAX_ERROR_STACK_LENGTH } from "./recorder.js";

describe("the error text limits", () => {
  it("match the protocol exactly", () => {
    // Copied, like the operation list, because the SDK cannot import the
    // private protocol package at runtime. A limit above the protocol's sends
    // text the server refuses; one below it throws away text it would store.
    const accepts = (message: number, stack: number): boolean =>
      errorSchema.safeParse({ message: "m".repeat(message), stack: "s".repeat(stack) }).success;

    expect(accepts(MAX_ERROR_MESSAGE_LENGTH, MAX_ERROR_STACK_LENGTH)).toBe(true);
    expect(accepts(MAX_ERROR_MESSAGE_LENGTH + 1, 1)).toBe(false);
    expect(accepts(1, MAX_ERROR_STACK_LENGTH + 1)).toBe(false);
  });
});
