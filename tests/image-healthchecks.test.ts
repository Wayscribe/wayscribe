import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `docker compose up -d --wait` returns when every container it waits on is
 * either healthy or, for a container with no health check, merely started. The
 * two labels are not the same evidence (F-022), and a health check without
 * `--start-interval` is only probed on its full interval even while the server
 * is already answering (F-017). Both are properties of the images, so they are
 * checked here rather than in a Compose file that may override them.
 */

const repositoryRoot = new URL("../", import.meta.url);

const dockerfile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, repositoryRoot)), "utf8");

/**
 * The HEALTHCHECK instruction on one line.
 *
 * Comments are dropped first: a Dockerfile may carry one between an
 * instruction's continued lines, and joining the continuations without
 * removing it would leave the rest of the instruction commented out here.
 */
const healthcheckOf = (contents: string): string | undefined => {
  const joined = contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n/g, " ");
  return joined.split("\n").find((line) => line.startsWith("HEALTHCHECK"));
};

const runtimeImages = [
  ["the API image", "apps/api/Dockerfile"],
  ["the web image", "apps/web/Dockerfile"]
] as const;

describe.each(runtimeImages)("%s", (_name, path) => {
  const contents = dockerfile(path);

  it("declares a HEALTHCHECK, so `up --wait` waits on a served request and not on a started process", () => {
    expect(healthcheckOf(contents)).toBeDefined();
  });

  it("sets --start-interval, so the first probe lands seconds after the container starts", () => {
    const healthcheck = healthcheckOf(contents) ?? "";
    const startInterval = /--start-interval=(\d+)s/.exec(healthcheck);
    expect(startInterval, healthcheck).not.toBeNull();
    expect(Number(startInterval?.[1] ?? "0")).toBeLessThanOrEqual(5);
  });

  it("gives the probe a start period to fail within", () => {
    expect(healthcheckOf(contents) ?? "").toMatch(/--start-period=\d+s/);
  });

  it("probes 127.0.0.1, which the server binds, rather than a name resolving to ::1 first", () => {
    expect(healthcheckOf(contents) ?? "").toContain("http://127.0.0.1:");
  });
});

/**
 * F-030: the web image's probe was /login, a page that reads no configuration,
 * so a web app that could not sign anyone in was reported healthy. The probe
 * has to reach a route that loads the configuration, or "healthy" says nothing
 * about whether the app is configured.
 */
describe("the web image's health check", () => {
  const healthcheck = healthcheckOf(dockerfile("apps/web/Dockerfile")) ?? "";
  const probed = /http:\/\/127\.0\.0\.1:3000(\/[^\s|]*)/.exec(healthcheck)?.[1] ?? "";

  it("probes a route handler, not a page", () => {
    expect(probed, healthcheck).toMatch(/^\/[a-z-]+$/);
    expect(() => dockerfile(`apps/web/app${probed}/route.ts`), probed).not.toThrow();
  });

  it("probes a route that loads the configuration and fails when it does not load", () => {
    const route = dockerfile(`apps/web/app${probed}/route.ts`);
    expect(route).toMatch(/\bwebConfig\(\)|\bloadWebConfig\(/);
    expect(route).toContain("status: 503");
  });
});
