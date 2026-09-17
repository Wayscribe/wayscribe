import { maskSecretsInText } from "@wayscribe/payload-security/redaction";
import { errorSchema } from "@wayscribe/protocol";
import { describe, expect, it } from "vitest";
import { MAX_ERROR_MESSAGE_LENGTH, MAX_ERROR_STACK_LENGTH, boundedMaskedText } from "./recorder.js";

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

describe("bounded, masked error text", () => {
  // The server masks what the SDK sends a second time. A cut can leave text the
  // masker reads differently from the whole, `cookie: session` becoming
  // `cookie: session[TRUNCATED]`, which no longer reads as prose; if the SDK
  // sent that, the server would rewrite a message the SDK had already masked.
  const pieces = [
    "cookie: ",
    "set-cookie: ",
    "session ",
    "expired",
    "password=",
    "DB_PASSWORD: ",
    "pass: '",
    "Bearer ",
    "abcdefgh12",
    "postgres://app:",
    "hunter2x",
    "@db",
    "sk_" + "live_0123456789",
    "[REDACTED]",
    '"',
    "'",
    " ",
    "=",
    ":",
    "/",
    ".",
    "x",
    "\n"
  ];

  for (const limit of [64, 256, MAX_ERROR_MESSAGE_LENGTH]) {
    it(`never produces text the server's pass would change, at a limit of ${String(limit)}`, () => {
      const random = seeded(limit);
      const failures: string[] = [];
      const runs = limit === MAX_ERROR_MESSAGE_LENGTH ? 500 : 10_000;

      for (let run = 0; run < runs; run += 1) {
        // A filler that ends near the limit, then pieces that straddle it.
        const filler = "y".repeat(Math.max(0, limit - 40 + Math.floor(random() * 30)));
        let text = filler;
        const count = 1 + Math.floor(random() * 12);
        for (let index = 0; index < count; index += 1) {
          text += pieces[Math.floor(random() * pieces.length)] ?? "";
        }

        const sent = boundedMaskedText(text, limit);
        if (sent.length > limit || maskSecretsInText(sent) !== sent) failures.push(text.slice(-60));
      }

      expect(failures.slice(0, 3)).toEqual([]);
    });
  }
});

/** mulberry32: a small, fast generator whose sequence is fixed by its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
