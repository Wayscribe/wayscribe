import { existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDITED_DOCUMENTS, anchors, read, root, withoutCode } from "./docs-helpers.js";

/**
 * Every relative link in the audited documents lands on a file that exists, and
 * a link with an anchor lands on a heading that file has.
 *
 * The 2026-09-16 claims audit found a pointer to "section 10" of the ingestion
 * contract, which has nine; a link to a heading that was renamed fails the same
 * way, silently, and only a reader finds it.
 */

interface Link {
  document: string;
  target: string;
}

function linksIn(document: string): Link[] {
  const text = withoutCode(read(document));
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) => ({ document, target }));
}

const links = AUDITED_DOCUMENTS.flatMap(linksIn);

describe("links in the audited documents", () => {
  it("finds the links it checks", () => {
    // A walk that finds nothing passes every assertion below.
    expect(links.length).toBeGreaterThan(100);
  });

  it("resolves every one to a file, and every anchor to a heading of that file", () => {
    const broken = links.flatMap((link) => {
      const [path = "", anchor] = link.target.split("#");
      const target =
        path === "" ? link.document : normalize(join(dirname(link.document), decodeURI(path)));
      const where = `${link.document} -> ${link.target}`;
      if (!existsSync(join(root, target))) return [`${where}: no such file`];
      if (anchor === undefined || anchor === "") return [];
      if (!statSync(join(root, target)).isFile() || !target.endsWith(".md")) {
        return [`${where}: an anchor on something that is not a markdown file`];
      }
      return anchors(read(target)).has(anchor) ? [] : [`${where}: no such heading`];
    });
    expect(broken).toEqual([]);
  });
});

describe("section numbers the audited documents cite", () => {
  /** `## N. Title` headings of a numbered document. */
  const numbered = (document: string): Map<number, string> =>
    new Map(
      [...withoutCode(read(document)).matchAll(/^## (\d+)\. (.+)$/gm)].map((match) => [
        Number(match[1]),
        match[2] ?? ""
      ])
    );

  /**
   * "OPERATIONS §9", "Operations §12", "`OPERATIONS.md` §8", "SECURITY section
   * 4", "OPERATIONS.md section 8" and the like, with the document they name.
   */
  const CITATION =
    /\b(OPERATIONS|Operations|SECURITY|Security|INGESTION_CONTRACT|API_SPEC|API specification|REPLAY_SPEC|SDK_SPEC|EVENT_PROTOCOL)(?:\.md)?`?\)?,?\s+(?:§\s*|section\s+)(\d+)\b/g;

  const DOCUMENT: Record<string, string> = {
    OPERATIONS: "docs/OPERATIONS.md",
    Operations: "docs/OPERATIONS.md",
    SECURITY: "docs/SECURITY.md",
    Security: "docs/SECURITY.md",
    INGESTION_CONTRACT: "docs/INGESTION_CONTRACT.md",
    API_SPEC: "docs/API_SPEC.md",
    "API specification": "docs/API_SPEC.md",
    REPLAY_SPEC: "docs/REPLAY_SPEC.md",
    SDK_SPEC: "docs/SDK_SPEC.md",
    EVENT_PROTOCOL: "docs/EVENT_PROTOCOL.md"
  };

  const citations = AUDITED_DOCUMENTS.flatMap((document) =>
    [...read(document).matchAll(CITATION)].map((match) => ({
      document,
      cited: DOCUMENT[match[1] ?? ""] ?? "",
      number: Number(match[2]),
      text: match[0]
    }))
  )
    // The root SECURITY.md has no numbered sections, so a numbered citation of
    // SECURITY always means docs/SECURITY.md.
    .filter((citation) => citation.cited !== "");

  it("finds the citations it checks", () => {
    expect(citations.length).toBeGreaterThan(40);
  });

  it("cites only sections that exist", () => {
    const missing = citations.filter((citation) => !numbered(citation.cited).has(citation.number));
    expect(missing).toEqual([]);
  });

  it("sends a reader who wants to run the conformance cases to the section that says how", () => {
    const contract = read("docs/INGESTION_CONTRACT.md");
    const running = /section (\d+), \[Running them\]\(#running-them\)/.exec(contract)?.[1];
    expect(running, "the introduction no longer points at Running them").toBeDefined();
    expect(numbered("docs/INGESTION_CONTRACT.md").get(Number(running))).toBe(
      "The conformance case format"
    );
  });
});
