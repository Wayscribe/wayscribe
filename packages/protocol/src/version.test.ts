import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, isSupportedProtocolVersion } from "./version.js";

describe("protocol version", () => {
  it("is 0.1", () => {
    expect(PROTOCOL_VERSION).toBe("0.1");
  });

  it("accepts the current version", () => {
    expect(isSupportedProtocolVersion("0.1")).toBe(true);
  });

  it("rejects unknown versions", () => {
    expect(isSupportedProtocolVersion("0.2")).toBe(false);
    expect(isSupportedProtocolVersion("1.0")).toBe(false);
    expect(isSupportedProtocolVersion("")).toBe(false);
  });
});
