import { describe, expect, it } from "vitest";
import { seeOther } from "./redirect-url";

describe("seeOther", () => {
  it("is a 303 whose Location is the path alone, with no scheme or host", () => {
    // An absolute Location was built from Host and X-Forwarded-Proto. Behind a
    // TLS-terminating proxy that sends no X-Forwarded-Proto it named http://,
    // the browser followed a downgrade, and `form-action 'self'` blocked the
    // login form's redirect outright. A path resolves against whatever origin
    // the browser is actually on.
    const response = seeOther("/journeys/jrn_1?event=e");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/journeys/jrn_1?event=e");
  });

  it("never names another host, whatever path it is handed", () => {
    for (const path of [
      "//evil.test/phish",
      "/\\evil.test",
      "https://evil.test/",
      "\\\\evil.test",
      "/.//evil.test",
      "/%2e//evil.test",
      "javascript:alert(1)",
      "relative"
    ]) {
      const location = seeOther(path).headers.get("location") ?? "";
      expect(location, path).toBe("/");
      expect(new URL(location, "https://wayscribe.example").origin, path).toBe(
        "https://wayscribe.example"
      );
    }
  });

  it("drops a fragment and keeps an encoded path as it is", () => {
    expect(seeOther("/journeys/jrn%2F1/delete#x").headers.get("location")).toBe(
      "/journeys/jrn%2F1/delete"
    );
  });
});
