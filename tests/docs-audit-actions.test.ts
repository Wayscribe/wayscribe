import { describe, expect, it } from "vitest";
import { codeWords, filesEndingWith, findSection, read, tableRows } from "./docs-helpers.js";

/**
 * docs/SECURITY.md section 13 lists what writes an audit row. It used to list
 * API key creation and revocation, capture-policy changes and retention changes,
 * none of which wrote one, beside a replay destination "update" that no route
 * performs. The table is now held to every `recordAudit` call in the code, in
 * both directions.
 */

/**
 * Every audit action the code writes: each `action: "noun.verb"` literal in a
 * source file that writes audit rows. Literals rather than `recordAudit` calls,
 * because erasure and range deletion hand their action to a batching helper
 * that makes the call.
 */
function auditedActions(): Set<string> {
  const writers = [
    ...filesEndingWith(".ts", "apps/api/src"),
    ...filesEndingWith(".ts", "packages/database/src")
  ].filter((file) => !file.endsWith(".test.ts") && /\brecordAudit\(/.test(read(file)));
  // audit.ts defines it, and the rest call it.
  if (writers.length < 4) throw new Error("the walk found almost no audit writers; is it broken?");

  const actions = new Set<string>();
  for (const file of writers) {
    for (const match of read(file).matchAll(/\baction:\s*"([a-z_]+\.[a-z_]+)"/g)) {
      actions.add(match[1] ?? "");
    }
  }
  return actions;
}

function documentedActions(): Set<string> {
  const section = findSection(read("docs/SECURITY.md"), "13. Audit events");
  if (section === undefined) throw new Error("docs/SECURITY.md has no section 13");
  return new Set(tableRows(section).flatMap((row) => codeWords(row[0] ?? "")));
}

describe("docs/SECURITY.md section 13 against the code", () => {
  it("lists exactly the actions the code audits", () => {
    expect([...documentedActions()].sort()).toEqual([...auditedActions()].sort());
  });

  it("audits issuing and revoking an API key, which it once only claimed to", () => {
    const actions = auditedActions();
    expect(actions).toContain("api_key.created");
    expect(actions).toContain("api_key.revoked");
  });

  it("says plainly that environment settings are changed without an audit row", () => {
    // No code path writes capture mode, redaction paths, allowlist or retention.
    // If one appears, it has to audit, and this sentence has to change with it.
    const writers = [
      ...filesEndingWith(".ts", "apps"),
      ...filesEndingWith(".ts", "packages")
    ].filter(
      (file) =>
        !file.endsWith(".test.ts") && /\("environments"\)[\s\S]{0,200}?\.update\(/.test(read(file))
    );
    expect(writers).toEqual([]);
    expect(findSection(read("docs/SECURITY.md"), "13. Audit events")).toContain(
      "What is **not** audited"
    );
  });

  it("is what ROADMAP counts", () => {
    const count = auditedActions().size;
    const words = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "eleven",
      "twelve"
    ];
    expect(read("docs/ROADMAP.md")).toContain(`${words[count] ?? String(count)} actions in all`);
  });
});
