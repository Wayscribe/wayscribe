import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

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

  it("does not claim payloads are encrypted at rest", () => {
    // They are `jsonb`. The claim was in README.md and docs/OPERATIONS.md, and
    // the OPERATIONS one told operators a dump taken without ENCRYPTION_KEY
    // held nothing readable — so following the documented backup procedure
    // exported every captured payload in the clear.
    for (const file of ["README.md", "docs/OPERATIONS.md", "docs/SECURITY.md"]) {
      expect(read(file), `${file} claims payloads are encrypted at rest`).not.toMatch(
        /payload[s]?[^.\n]*\bencrypted at rest\b/i
      );
    }
  });
});
