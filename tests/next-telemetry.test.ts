import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * `next build`, `next dev` and `next start` send anonymous usage data to Vercel
 * unless NEXT_TELEMETRY_DISABLED is set. The README's "Try it" builds the web
 * image on the evaluator's own machine, so an unset variable there is a request
 * to telemetry.nextjs.org from every first run. Nothing in the repository set
 * it until this test was written.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

const DISABLED = /^ENV\s+NEXT_TELEMETRY_DISABLED=1\s*$/m;

/** The Dockerfile split into its stages, each with the name it was given. */
function stages(dockerfile: string): Array<{ name: string; from: string; body: string }> {
  const parts = dockerfile.split(/^(?=FROM\s)/m).filter((part) => part.startsWith("FROM"));
  return parts.map((body) => {
    const header = body.split("\n")[0] ?? "";
    const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(header);
    return { from: match?.[1] ?? "", name: match?.[2] ?? "", body };
  });
}

describe("Next.js telemetry is disabled", () => {
  const dockerfile = read("apps/web/Dockerfile");
  const all = stages(dockerfile);
  const byName = new Map(all.map((stage) => [stage.name, stage]));

  /** True when the stage sets the variable itself or inherits a stage that does. */
  const setsIt = (stage: { from: string; body: string }): boolean =>
    DISABLED.test(stage.body) ||
    (byName.has(stage.from) && setsIt(byName.get(stage.from) as { from: string; body: string }));

  it("finds the web Dockerfile's stages", () => {
    expect(all.map((stage) => stage.name)).toEqual(["base", "build", "runtime"]);
  });

  it("sets it in every stage of the web image, the runtime included", () => {
    // Every stage either runs Next (build) or is the image that ships (runtime),
    // and an ENV on the runtime stage keeps the variable in the running container.
    for (const stage of all) {
      expect(setsIt(stage), `stage ${stage.name} does not set NEXT_TELEMETRY_DISABLED=1`).toBe(
        true
      );
    }
  });

  it("sets it before the stage runs Next", () => {
    const build = byName.get("build");
    expect(build).toBeDefined();
    const body = build?.body ?? "";
    const runsNext = body.indexOf("@wayscribe/web build");
    expect(runsNext).toBeGreaterThan(-1);
    // Inherited from base, which comes first, or set earlier in this stage.
    const own = body.search(DISABLED);
    expect(setsIt({ from: build?.from ?? "", body: "" }) || (own > -1 && own < runsNext)).toBe(
      true
    );
  });

  it("sets it in every web package script that starts Next", () => {
    const manifest = JSON.parse(read("apps/web/package.json")) as {
      scripts: Record<string, string>;
    };
    const next = Object.entries(manifest.scripts).filter(([, command]) =>
      /(^|\s)next\s/.test(command)
    );
    expect(next.map(([name]) => name).sort()).toEqual(["build", "dev", "start"]);
    for (const [name, command] of next) {
      expect(command, `script ${name}`).toMatch(/^NEXT_TELEMETRY_DISABLED=1 next\s/);
    }
  });

  it("sets it for every CI job", () => {
    const ci = parse(read(".gitlab-ci.yml"), { merge: true }) as {
      variables?: Record<string, string>;
    };
    expect(ci.variables?.["NEXT_TELEMETRY_DISABLED"]).toBe("1");
  });

  it("scopes the privacy statements to the running services", () => {
    // "There is no telemetry" was untrue of a build while nothing set the
    // variable, and a build is still not offline now that something does.
    for (const file of ["README.md", "SECURITY.md"]) {
      const text = read(file).replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/There is no telemetry/i);
      expect(text, file).toContain("The running services send no telemetry");
      expect(text, file).toContain("Building the images is not offline");
      expect(text, file).toContain("NEXT_TELEMETRY_DISABLED=1");
    }
  });
});
