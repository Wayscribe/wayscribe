import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOURNEY_STATUSES } from "../packages/database/src/repositories/journey-list.js";
import { parseRecentJourneysQuery } from "../apps/api/src/routes/recent-query.js";

const root = fileURLToPath(new URL("../", import.meta.url));

const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

/** Directories with nothing authored in them. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".pnpm-store",
  "coverage",
  "playwright-report",
  "test-results",
  // The frozen planning records quote claims as they were, which is the point
  // of keeping them.
  "superpowers"
]);

/**
 * Every markdown file in the repository, so a claim cannot reappear in one that
 * nobody thought to list.
 *
 * Walked rather than asked of `git ls-files`. The CI image is `node:24-alpine`
 * and has no git — GitLab clones with a separate helper container — so the first
 * version of this passed on a clean clone and failed in the pipeline with
 * `spawnSync git ENOENT`. A unit test should not need a tool outside Node.
 */
function markdownFiles(directory = "", found: string[] = []): string[] {
  return filesEndingWith(".md", directory, found);
}

function filesEndingWith(suffix: string, directory = "", found: string[] = []): string[] {
  for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitlab") continue;
    if (SKIP.has(entry.name)) continue;

    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) filesEndingWith(suffix, relative, found);
    else if (entry.name.endsWith(suffix)) found.push(relative);
  }
  return found;
}

/**
 * Claims the documentation makes that the repository can check for itself.
 *
 * The README's status text has now been wrong in both directions inside one
 * week — it overstated readiness at one audit and understated it at the next,
 * and it counted 33 ADRs when there were 37. Rewriting it a third time without
 * changing why it drifts would just schedule a fourth.
 */
describe("the documentation's checkable claims", () => {
  it("counts the ADRs correctly", () => {
    const actual = (read("docs/DECISIONS.md").match(/^## ADR-/gm) ?? []).length;
    const claimed = /\[the decision log\]\(docs\/DECISIONS\.md\) — (\d+) ADRs/.exec(
      read("README.md")
    );

    expect(claimed, "README no longer states an ADR count in the expected shape").not.toBeNull();
    expect(Number(claimed?.[1])).toBe(actual);
  });

  it("numbers the ADRs without gaps or repeats", () => {
    // A duplicated number is how two branches silently claim one decision.
    const numbers = [...read("docs/DECISIONS.md").matchAll(/^## ADR-(\d+)/gm)].map((m) =>
      Number(m[1])
    );
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  it("does not claim payloads are encrypted at rest, in any document", () => {
    // They are `jsonb`. The claim was in README.md and docs/OPERATIONS.md, and
    // the OPERATIONS one told operators a dump taken without ENCRYPTION_KEY
    // held nothing readable — so following the documented backup procedure
    // exported every captured payload in the clear.
    //
    // Every markdown file rather than three named ones: the first version of
    // this test listed the files the claim happened to be in, which would have
    // missed it reappearing anywhere else.
    // Two documents quote the claim in order to record that it was wrong, which
    // is the opposite of asserting it. They are named rather than pattern-matched
    // so that the claim reappearing anywhere *else* is still caught — the check
    // is "every file except these two", not "these files".
    const records = new Set(["docs/DECISIONS.md", "docs/WHAT_RUNNING_IT_FOUND.md"]);

    for (const file of markdownFiles().filter((f) => !records.has(f))) {
      expect(read(file), `${file} claims payloads are encrypted at rest`).not.toMatch(
        /payload[s]?[^.\n]*\bencrypted at rest\b/i
      );
    }
  });

  it("does not describe field-level encryption as future work", () => {
    // Entity identifiers, alias display values, and replay destination headers
    // are encrypted at rest today, with a key derived from ENCRYPTION_KEY
    // (ADR-040). SECURITY.md and DATABASE_SCHEMA.md both described this as
    // something V0 "may" do later; that stopped being true once ADR-040 landed.
    for (const file of ["docs/SECURITY.md", "docs/DATABASE_SCHEMA.md"]) {
      const content = read(file);
      expect(content, `${file} still calls field-level encryption future work`).not.toMatch(
        /Future field-level encryption/i
      );
      expect(
        content,
        `${file} still describes payload storage as possibly relying on encryption`
      ).not.toMatch(/may initially rely on encrypted database storage/i);
    }
  });

  it("does not present the first-contact audit's defects as still open", () => {
    // The 2026-08-09 audit found eight defects (M1 to M8) and seven smaller
    // ones. Every one was fixed the same day, and the fixes were then
    // dogfooded against a real ORM (ADR-034 to ADR-036). The README's status
    // section kept saying "fixes are underway" for five weeks afterwards,
    // which told an evaluator the diff still lied about Dates — the exact
    // claim WHAT_RUNNING_IT_FOUND.md records as fixed.
    const readme = read("README.md");
    expect(readme).not.toMatch(/fixes are underway/i);
    expect(readme).not.toMatch(/treat this as a design and architecture reference/i);
  });

  it("does not tell users to run pnpm db:seed", () => {
    // The seed is a development fixture. Neither the demo stack nor the
    // published stack runs it, and ADR-037 made `project:create` the way a
    // project comes to exist. The login page and the empty projects page both
    // still pointed at it, so a first-time user who followed the interface's
    // own instruction would be told to run a script the README never mentions.
    for (const file of filesEndingWith(".tsx", "apps/web/app")) {
      expect(read(file), `${file} tells the user to run pnpm db:seed`).not.toContain("db:seed");
    }
  });

  it("never tells anyone to run a repository script that pnpm has a built-in for", () => {
    // pnpm 11 has its own `doctor`, and `pnpm doctor` runs it rather than the
    // root script: it checks the pnpm installation, prints its own report, and
    // exits 0 on a database it never looked at. `pnpm run doctor` always means
    // the script. Every markdown file, for the reason the checks above give.
    for (const file of markdownFiles()) {
      expect(read(file), `${file} says \`pnpm doctor\`; write \`pnpm run doctor\``).not.toMatch(
        /\bpnpm doctor\b/
      );
    }
  });

  it("runs package scripts from the root with `run`, so a pnpm built-in cannot shadow one", () => {
    // `pnpm --filter <package> doctor` ran pnpm's built-in doctor across the
    // workspace and failed with "Unknown option: 'recursive'". Every name, not
    // only doctor: pnpm adds built-ins, and the next one would shadow silently.
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    for (const [name, command] of Object.entries(scripts)) {
      const filtered = /^pnpm --filter \S+ (\S+)/.exec(command);
      if (filtered === null) continue;
      expect(
        ["run", "exec"],
        `root script ${name} runs \`${command}\`; filter into the package with \`run\``
      ).toContain(filtered[1]);
    }
  });

  it("keeps the pre-implementation documents marked as such", () => {
    // They predate every ADR and describe an install premise ADR-037 inverted.
    // They are kept for provenance, which only works if a reader is told.
    for (const file of [
      "docs/PRODUCT_SPEC.md",
      "docs/ARCHITECTURE.md",
      "docs/IMPLEMENTATION_PLAN.md",
      "docs/PRODUCT_PRINCIPLES.md"
    ]) {
      expect(read(file), `${file} lost its provenance note`).toContain(
        "Written before implementation"
      );
    }
  });

  describe("GET /v1/journeys in API_SPEC.md", () => {
    const section = (): string => {
      const match = /## 6\. List recent journeys\n([\s\S]*?)\n## 7\./.exec(
        read("docs/API_SPEC.md")
      );
      expect(match, "API_SPEC.md has no section 6 for recent journeys").not.toBeNull();
      return match?.[1] ?? "";
    };
    /** First-column names of the parameter table. */
    const documented = (): string[] =>
      [...section().matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1] ?? "");

    it("documents exactly the query parameters the route reads", () => {
      expect(documented()).toEqual([
        "since",
        "status",
        "environment",
        "service",
        "limit",
        "cursor"
      ]);
    });

    it.each(["since", "status", "environment", "service"])(
      "documents %s, which the parser validates",
      (name) => {
        // A repeated parameter is refused by name only if the parser reads it.
        const query: Record<string, unknown> = {
          since: "2026-01-01T00:00:00Z",
          [name]: ["a", "b"]
        };
        expect(parseRecentJourneysQuery(query, new Date("2026-09-15T00:00:00Z"))).toEqual({
          ok: false,
          message: `${name} must be given once.`
        });
      }
    );

    it("documents limit and cursor, which the route reads as other lists do", () => {
      const route = /app\.get\("\/v1\/journeys", [\s\S]*?\n {2}\}\);/.exec(
        read("apps/api/src/routes/queries.ts")
      );
      expect(route?.[0]).toContain("parseLimit(request.query)");
      expect(route?.[0]).toContain("cursorParam(request.query)");
    });

    it("lists the statuses the database allows", () => {
      const row = /^\| `status` \|(.*)$/m.exec(section())?.[1] ?? "";
      expect([...row.matchAll(/`([a-z]+)`/g)].map((m) => m[1])).toEqual([...JOURNEY_STATUSES]);
    });
  });
});
