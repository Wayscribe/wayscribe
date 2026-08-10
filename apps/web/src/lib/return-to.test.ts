import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./return-to";

/**
 * The project picker carries a destination through a form field, so the value
 * arrives from the client and cannot be trusted. Anything that is not plainly a
 * path inside this application has to fall back rather than be followed.
 */
describe("safeReturnTo", () => {
  it("keeps an ordinary path, query and all", () => {
    expect(safeReturnTo("/?q=0018Z00002ABC")).toBe("/?q=0018Z00002ABC");
    expect(safeReturnTo("/journeys/jrn_1")).toBe("/journeys/jrn_1");
    expect(safeReturnTo("/journeys/jrn_1?event=evt_2")).toBe("/journeys/jrn_1?event=evt_2");
  });

  it("refuses another origin", () => {
    // The whole reason this function exists. A picker that followed this would
    // be an open redirect on an authenticated page.
    for (const hostile of [
      "https://evil.test/steal",
      "http://evil.test",
      "//evil.test",
      "//evil.test/path",
      "/\\evil.test",
      "/\t/evil.test",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>"
    ]) {
      expect(safeReturnTo(hostile), hostile).toBe("/");
    }
  });

  it("refuses anything that is not a path at all", () => {
    for (const value of [undefined, "", "   ", "relative/path", "?q=only-a-query"]) {
      expect(safeReturnTo(value)).toBe("/");
    }
  });

  it("refuses a path that would send the picker back to itself", () => {
    // Returning to /projects after choosing a project is a loop with no exit.
    expect(safeReturnTo("/projects")).toBe("/");
    expect(safeReturnTo("/projects?next=/projects")).toBe("/");
  });

  it("strips a fragment rather than carrying it", () => {
    // A fragment never reaches the server, so preserving it is theatre; more to
    // the point it is a place to hide a second scheme.
    expect(safeReturnTo("/journeys/jrn_1#/../../evil")).toBe("/journeys/jrn_1");
  });
});
