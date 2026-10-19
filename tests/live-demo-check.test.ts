import { describe, expect, it } from "vitest";
import { read } from "./docs-helpers.js";

/**
 * The live check of the public demo (ADR-073): its alert, and the line between
 * it and the end-to-end suite, which must never reach production.
 */

describe("the live check and the end-to-end suite", () => {
  it("keeps pnpm test:e2e on apps/web/e2e and away from the public demo", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts["test:e2e"]).toBe("playwright test");
    expect(scripts["test:live"]).toBe("playwright test --config playwright.live.config.ts");
    const e2e = read("playwright.config.ts");
    expect(e2e).toContain('testDir: "./apps/web/e2e"');
    expect(e2e).not.toContain("demo.wayscribe.dev");
  });

  it("points the live config at the public demo, under the smoke check's user agent", () => {
    const live = read("playwright.live.config.ts");
    expect(live).toContain('testDir: "./apps/web/e2e-live"');
    expect(live).toContain('process.env["LIVE_URL"] ?? "https://demo.wayscribe.dev"');
    // deploy/demo/visit-notifier skips this prefix, so a check is not a visit.
    expect(read("deploy/demo/visit-notifier/notifier.ts")).toContain(
      'SMOKE_USER_AGENT_PREFIX = "wayscribe-smoke/"'
    );
    expect(live).toContain('userAgent: "wayscribe-smoke/live-demo"');
  });

  it("only reads: the live spec sends no request but a page load", () => {
    const spec = read("apps/web/e2e-live/demo.spec.ts");
    expect(spec).not.toMatch(/\b(request|fetch)\s*[.(]/);
    expect(spec).not.toMatch(/method:/);
    expect(spec).not.toMatch(
      /\.(click|dblclick|tap|fill|press|pressSequentially|type|check|uncheck|selectOption|setInputFiles|dispatchEvent)\(|\.submit\(/
    );
  });
});
