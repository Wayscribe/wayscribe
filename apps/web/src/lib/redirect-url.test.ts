import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { redirectTarget } from "./redirect-url";

const request = (headers: Record<string, string> = { host: "localhost:3000" }): NextRequest =>
  new NextRequest("http://0.0.0.0:3000/api/anything", { method: "POST", headers });

describe("redirectTarget", () => {
  it("builds the target on the host the client asked for", () => {
    expect(redirectTarget(request(), "/journeys/jrn_1?event=e").toString()).toBe(
      "http://localhost:3000/journeys/jrn_1?event=e"
    );
  });

  it("never leaves that host, whatever path it is handed", () => {
    // The last line of defence behind safeReturnTo: a caller that passes an
    // unchecked path still cannot produce a redirect to another host.
    for (const path of [
      "//evil.test/phish",
      "/\\evil.test",
      "https://evil.test/",
      "\\\\evil.test"
    ]) {
      const target = redirectTarget(request(), path);
      expect(target.host, path).toBe("localhost:3000");
      expect(target.pathname, path).toBe("/");
    }
  });
});
