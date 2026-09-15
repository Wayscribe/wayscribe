import { describe, expect, it } from "vitest";
import { echoScrubber, MIN_SCRUBBED_LENGTH } from "./echo-scrub.js";

const SECRET = "dev-token-5c1f9a";

describe("echoScrubber", () => {
  it("replaces a value inside a longer string", () => {
    expect(echoScrubber([SECRET]).text(`authorization: Bearer ${SECRET}\nx: y`)).toBe(
      "authorization: Bearer [REDACTED]\nx: y"
    );
  });

  it("walks parsed JSON, replacing within strings, keys, and arrays", () => {
    const scrubbed = echoScrubber([SECRET]).value({
      headers: { "x-dev-token": SECRET, authorization: `Bearer ${SECRET}` },
      list: [SECRET, 1, true, null],
      [SECRET]: "as a key"
    });
    expect(scrubbed).toEqual({
      headers: { "x-dev-token": "[REDACTED]", authorization: "Bearer [REDACTED]" },
      list: ["[REDACTED]", 1, true, null],
      "[REDACTED]": "as a key"
    });
  });

  it("replaces the JSON-escaped form in text", () => {
    const quoted = 'pa"ss\\word-123';
    const body = JSON.stringify({ echoed: quoted });
    expect(body).not.toContain(quoted);
    expect(echoScrubber([quoted]).text(body)).toBe('{"echoed":"[REDACTED]"}');
  });

  it("does not replace a value shorter than the minimum", () => {
    const short = "a".repeat(MIN_SCRUBBED_LENGTH - 1);
    expect(echoScrubber([short]).text(`value ${short}`)).toBe(`value ${short}`);
    expect(echoScrubber(["12345678"]).text("id 12345678")).toBe("id [REDACTED]");
  });

  it("replaces a longer value whole when it contains a shorter one", () => {
    const shorter = "token-abcdef";
    const longer = `${shorter}-and-more`;
    expect(echoScrubber([shorter, longer]).text(`${longer} ${shorter}`)).toBe(
      "[REDACTED] [REDACTED]"
    );
  });

  it("cannot see a fragment a size cap cut off", () => {
    // Documented limit: the cap can end a body part way through a value.
    const cut = SECRET.slice(0, 10);
    expect(echoScrubber([SECRET]).text(`Bearer ${cut}`)).toBe(`Bearer ${cut}`);
  });

  it("keeps a __proto__ key as an own key", () => {
    const parsed = JSON.parse(`{"__proto__": "${SECRET}"}`) as unknown;
    const scrubbed = echoScrubber([SECRET]).value(parsed) as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(scrubbed, "__proto__")?.value).toBe("[REDACTED]");
  });

  it("leaves everything alone when there is nothing to replace", () => {
    const body = { a: "b" };
    expect(echoScrubber([]).value(body)).toBe(body);
  });
});
