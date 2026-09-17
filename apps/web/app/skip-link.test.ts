import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = fileURLToPath(new URL(".", import.meta.url));

/** Every page-level file Next renders into the shell: pages, loading, error, not-found. */
function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "api" ? [] : pageFiles(path);
    return /^(page|loading|error|not-found)\.tsx$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The root layout's skip link targets `#main`, and each page renders its own
 * `<main>`, so a page added without the id would leave the link going nowhere.
 * The browser suite checks the link on two pages; this checks every file.
 */
describe("the skip link target", () => {
  const files = pageFiles(APP);

  it("finds the page files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("is on every <main> in every page file", () => {
    const missing = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/<main\b[^>]*>/g)]
        .map(([tag]) => tag)
        .filter((tag) => !tag.includes('id="main"'))
        .map((tag) => `${file.slice(APP.length)}: ${tag}`)
    );
    expect(missing).toEqual([]);
  });
});
