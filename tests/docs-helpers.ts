import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Helpers shared by the tests that hold the documentation to the code
 * (ADR-040): `docs-truth.test.ts` and the files beside it.
 */

export const root = fileURLToPath(new URL("../", import.meta.url));

export const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

/**
 * The text of a `## ` section of a markdown document, up to the next one, or
 * undefined when there is no such section. `heading` is the whole heading text.
 */
export function findSection(markdown: string, heading: string): string | undefined {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) return undefined;
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, end === -1 ? undefined : end);
}

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
 * Directories the website's build writes from files that are read here at their
 * source (ADR-058), ignored by git. Walking them would test each document twice,
 * and a local build could make a test disagree with CI.
 */
export const GENERATED_DIRECTORIES: ReadonlySet<string> = new Set([
  "site/src/content/docs/docs",
  "site/src/generated",
  "site/public/images"
]);

/**
 * Every markdown file in the repository, so a claim cannot reappear in one that
 * nobody thought to list.
 *
 * Walked rather than asked of `git ls-files`. The CI image is `node:24-alpine`
 * and has no git (GitLab clones with a separate helper container), so the first
 * version of this passed on a clean clone and failed in the pipeline with
 * `spawnSync git ENOENT`. A unit test should not need a tool outside Node.
 */
export function markdownFiles(directory = "", found: string[] = []): string[] {
  return filesEndingWith(".md", directory, found);
}

export function filesEndingWith(suffix: string, directory = "", found: string[] = []): string[] {
  for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitlab") continue;
    if (SKIP.has(entry.name)) continue;

    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (GENERATED_DIRECTORIES.has(relative)) continue;
    if (entry.isDirectory()) filesEndingWith(suffix, relative, found);
    else if (entry.name.endsWith(suffix)) found.push(relative);
  }
  return found;
}

/** GitLab's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-")
    .replace(/-{2,}/g, "-");
}

/** Markdown with its fenced code blocks removed. */
export function withoutCode(markdown: string): string {
  return markdown.replace(/^([ \t]*)```[\s\S]*?^\1```/gm, "");
}

/** The anchors a markdown document's headings produce. */
export function anchors(markdown: string): Set<string> {
  return new Set(
    [...withoutCode(markdown).matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
      slug((match[1] ?? "").replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))
    )
  );
}

/**
 * The rows of the first markdown table in `text`, each as an array of trimmed
 * cells, without the header or the separator row.
 */
export function tableRows(text: string): string[][] {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith("|"));
  if (first === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.trimStart().startsWith("|")) break;
    rows.push(
      line
        .trim()
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim())
    );
  }
  return rows;
}

/** The backticked words in a table cell: "`a`, `b`" is ["a", "b"]. */
export function codeWords(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** The first capture of `pattern` in `text`, or a failure naming what was missing. */
export function capture(text: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`could not find ${what}`);
  return found;
}

/**
 * The public documents this repository's claims audit covers
 * (`docs/claims-audit-2026-09-16.md`). The decision log is historical and not
 * in the list.
 */
export const AUDITED_DOCUMENTS: readonly string[] = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/OPERATIONS.md",
  "docs/SECURITY.md",
  "docs/SECURITY_REVIEW.md",
  "docs/RELEASE_NOTES_DRAFT.md",
  "docs/FAQ.md",
  "docs/TROUBLESHOOTING.md",
  "docs/INGESTION_CONTRACT.md",
  "docs/PROPAGATION_SPEC.md",
  "docs/API_SPEC.md",
  "docs/ROADMAP.md",
  "docs/LOCAL_DEVELOPMENT.md",
  "docs/ALTERNATIVES.md",
  "packages/sdk-node/README.md",
  "docs/recipes/README.md",
  "docs/recipes/express-bullmq-hubspot.md",
  "docs/recipes/fastify-sqs-salesforce.md",
  "docs/recipes/nextjs-stripe.md",
  "deploy/helm/README.md",
  "docs/claims-audit-2026-09-16.md"
];
