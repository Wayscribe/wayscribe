import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
  for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitlab") continue;
    if (SKIP.has(entry.name)) continue;

    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) markdownFiles(relative, found);
    else if (entry.name.endsWith(".md")) found.push(relative);
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
});
