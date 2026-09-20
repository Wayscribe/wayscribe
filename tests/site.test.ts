import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findSection, GENERATED_DIRECTORIES, read, root } from "./docs-helpers.js";

/**
 * The website (ADR-058). Its docs are generated from the repository on every
 * build, so what is checked here is the input: which documents are published,
 * that they are fit to publish, and that the hand-written landing page says what
 * the repository says. The site's own build checks its links.
 *
 * Nothing here needs the site's dependencies installed: the unit job installs
 * the root workspace only.
 */

interface Page {
  source: string;
  slug: string;
  label: string;
  title?: string;
  sections?: string[];
}

interface Manifest {
  repository: string;
  branch: string;
  groups: { label: string; pages: Page[] }[];
  landing: { partials: { source: string; sections: string[] }[]; images: string[] };
}

const manifest = JSON.parse(read("site/docs-manifest.json")) as Manifest;
const pages = manifest.groups.flatMap((group) => group.pages);
const sources = [...new Set(pages.map((page) => page.source))];
const landing = read("site/src/content/docs/index.mdx");

/** Lines with an em or en dash, numbered. */
const dashes = (text: string): string[] =>
  text
    .split("\n")
    .map((line, index) => `${String(index + 1)}: ${line}`)
    .filter((line) => /[\u2013\u2014]/.test(line));

/** A code block's lines, trimmed, so an excerpt can be compared at any indent. */
const lines = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

/**
 * What the site's install and build write, none of it committed: the generated
 * docs, partial and images, and the site's dependencies, output and Astro cache.
 */
const SITE_OUTPUT: ReadonlySet<string> = new Set([
  ...GENERATED_DIRECTORIES,
  "site/node_modules",
  "site/dist",
  "site/.astro"
]);

/** Every file under a directory of the site, skipping what the build writes. */
function siteFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (SITE_OUTPUT.has(relative)) continue;
    if (entry.isDirectory()) siteFiles(relative, found);
    else found.push(relative);
  }
  return found;
}

describe("the documents the site publishes", () => {
  it("lists pages, each from a markdown file that exists, under a unique slug", () => {
    expect(pages.length).toBeGreaterThan(20);
    for (const source of sources) {
      expect(source, source).toMatch(/\.md$/);
      expect(existsSync(join(root, source)), `${source} does not exist`).toBe(true);
    }
    const slugs = pages.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("finds every section a page or the landing page takes from a document", () => {
    for (const { source, sections = [] } of [...pages, ...manifest.landing.partials]) {
      for (const heading of sections) {
        expect(findSection(read(source), heading), `${source}: ## ${heading}`).toBeDefined();
      }
    }
  });

  it("publishes no internal or historical record", () => {
    for (const source of sources) {
      expect(source).not.toMatch(
        /^docs\/(superpowers|reviews)\/|claims-audit|TASKS\.md$|IMPLEMENTATION_PLAN\.md$/
      );
    }
  });

  it("publishes no page with an em or en dash", () => {
    for (const source of sources) expect(dashes(read(source)), source).toEqual([]);
  });

  it("uses only images that exist", () => {
    for (const image of manifest.landing.images) {
      expect(statSync(join(root, image)).isFile(), image).toBe(true);
    }
  });

  it("rebuilds the site in CI when any published document changes", () => {
    const ci = parse(read(".gitlab-ci.yml"), { merge: true }) as Record<
      string,
      { rules?: { changes?: string[] }[] }
    >;
    const changes = ci.site?.rules?.flatMap((rule) => rule.changes ?? []) ?? [];
    expect(changes.length).toBeGreaterThan(0);
    const covered = (file: string): boolean =>
      changes.some((pattern) =>
        pattern.endsWith("/**/*") ? file.startsWith(pattern.slice(0, -4)) : file === pattern
      );
    for (const source of [...sources, ...manifest.landing.images]) {
      expect(covered(source), `${source} is not in the site job's changes`).toBe(true);
    }
    // The landing page's code comes from a recipe.
    expect(covered("examples/recipes/express-bullmq-hubspot/src/webhook.ts")).toBe(true);
  });

  it("never runs the site's jobs on a tag, nor lets them hold back the mirror", () => {
    interface Job {
      stage?: string;
      needs?: unknown[];
      rules?: { if?: string; when?: string }[];
    }
    const ci = parse(read(".gitlab-ci.yml"), { merge: true }) as Record<string, Job> & {
      stages: string[];
    };
    for (const name of ["site", "pages"]) {
      const rules = ci[name]?.rules ?? [];
      // Rules are read in order, so the exclusion has to come before any rule
      // that could match a tag pipeline.
      const tag = rules.findIndex((rule) => rule.if === "$CI_COMMIT_TAG" && rule.when === "never");
      expect(tag, `${name} has no tag exclusion`).toBeGreaterThanOrEqual(0);
      const firstMatching = rules.findIndex((rule) => rule.when !== "never");
      expect(tag, `${name} can match a tag before it excludes one`).toBeLessThan(firstMatching);
    }
    // mirror-to-github has no `needs`, so it waits for every stage before its
    // own; the site's stage must come after it.
    expect(ci["mirror-to-github"]?.needs).toBeUndefined();
    const stage = (name: string): number => ci.stages.indexOf(ci[name]?.stage ?? "");
    expect(stage("mirror-to-github")).toBeGreaterThanOrEqual(0);
    expect(stage("site")).toBeGreaterThan(stage("mirror-to-github"));
    expect(stage("pages")).toBeGreaterThan(stage("site"));
    // Started at once regardless of its stage.
    expect(ci.site?.needs).toEqual([]);
  });
});

describe("the site's own files", () => {
  it("use no em or en dashes", () => {
    const files = siteFiles("site").filter((file) =>
      /\.(mdx?|mjs|json|css|astro|yaml)$/.test(file)
    );
    expect(files).toContain("site/src/content/docs/index.mdx");
    for (const file of files.filter((name) => !name.endsWith("pnpm-lock.yaml"))) {
      expect(dashes(read(file)), file).toEqual([]);
    }
  });

  it("load nothing from another host", () => {
    for (const file of siteFiles("site").filter((name) => /\.(mdx|mjs|css|astro)$/.test(name))) {
      const text = read(file);
      expect(text, file).not.toMatch(/<script[^>]+src=["']https?:/);
      expect(text, file).not.toMatch(/@import\s+(url\()?["']?https?:/);
      expect(text, file).not.toMatch(/fonts\.googleapis|googletagmanager|plausible|analytics\.js/);
    }
  });

  it("turn Astro's telemetry off wherever Astro runs", () => {
    const scripts = (JSON.parse(read("site/package.json")) as { scripts: Record<string, string> })
      .scripts;
    for (const [name, command] of Object.entries(scripts)) {
      if (/\bastro\b/.test(command)) {
        expect(command, name).toContain("ASTRO_TELEMETRY_DISABLED=1 astro");
      }
    }
    const ci = parse(read(".gitlab-ci.yml")) as Record<
      string,
      { variables?: Record<string, string> }
    >;
    expect(ci.site?.variables?.ASTRO_TELEMETRY_DISABLED).toBe("1");
  });

  it("pins every dependency to an exact version", () => {
    const manifestFile = JSON.parse(read("site/package.json")) as {
      dependencies: Record<string, string>;
    };
    for (const [name, version] of Object.entries(manifestFile.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("stay out of the root workspace and out of the images", () => {
    const workspace = parse(read("pnpm-workspace.yaml")) as { packages: string[] };
    expect(workspace.packages).not.toContain("site");
    expect(workspace.packages.some((pattern) => pattern.startsWith("site"))).toBe(false);
    expect(existsSync(join(root, "site/pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(root, "site/pnpm-workspace.yaml"))).toBe(true);
    expect(read(".dockerignore").split("\n")).toContain("site");
    expect(read("scripts/verify-image-contents.sh")).toMatch(/for DIR in [^\n]* \/app\/site; do/);
  });
});

describe("the landing page", () => {
  const readme = read("README.md");
  const blocks = (language: string): string[] =>
    [...landing.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map(
      (match) => match[1] ?? ""
    );

  it("gives the quick start's commands exactly as the README does", () => {
    const shell = blocks("bash");
    const tryIt = findSection(readme, "Try it") ?? "";
    for (const command of [
      "git clone https://gitlab.com/jojithedev/wayscribe.git && cd wayscribe\n",
      "docker compose -f infrastructure/compose.yaml \\\n               -f infrastructure/compose.demo.yaml up --build\n",
      "curl -X POST http://localhost:3100/trigger\n"
    ]) {
      expect(tryIt, "the README changed").toContain(`\`\`\`bash\n${command}\`\`\``);
      expect(shell, "the landing page changed").toContain(command);
    }
    expect(landing).toContain("Measured on\n2026-09-14 from a fresh clone");
    expect(readme).toMatch(/Measured on 2026-09-14 from a fresh clone/);
    expect(landing).toContain("the build\ntook 38 seconds and the boot 12");
    expect(readme).toContain("the build took 38 seconds and the boot 12");
  });

  it("names the development admin token the Compose defaults set", () => {
    const token = /^ADMIN_TOKEN=(.+)$/m.exec(read("infrastructure/defaults.env"))?.[1];
    expect(token).toBeDefined();
    expect(landing).toContain(`\`${token ?? ""}\``);
  });

  it("installs the released SDK by exact version and includes the released stack in Quick start", () => {
    const version = (JSON.parse(read("packages/sdk-node/package.json")) as { version: string })
      .version;
    const releasedInstall = `npm install @wayscribe/node@${version}`;
    expect(landing).toContain(releasedInstall);
    expect(landing).not.toMatch(/wayscribe-node-[\d.]+\.tgz/);

    const install = findSection(readme, "Instrument your own service") ?? "";
    expect(install).toContain(releasedInstall);
    // --silent, so capturing stdout gives the tarball's path and nothing else
    // (F-018). Source-preview guidance remains available after the release.
    expect(install).toContain(
      "pnpm --silent --filter @wayscribe/node run pack:release /path/to/your-app/vendor/"
    );

    const releaseHeading = `Install ${version} without a checkout`;
    const quickStart = pages.find((page) => page.slug === "quick-start");
    expect(quickStart?.sections).toContain(releaseHeading);
    expect(findSection(readme, releaseHeading)).toBeDefined();
  });

  it("shows only code the recipe type-check covers", () => {
    const recipe = ["recorder.ts", "webhook.ts"]
      .map((file) => read(`examples/recipes/express-bullmq-hubspot/src/${file}`))
      .join("\n");
    const code = blocks("typescript");
    expect(code).toHaveLength(2);
    for (const block of code) expect(lines(recipe)).toContain(lines(block).trimEnd());
  });

  it("takes the comparison from the README's Alternatives section, which carries the dated claim", () => {
    expect(landing).toMatch(
      /import \{ Content as Alternatives \} from "..\/..\/generated\/alternatives\.md";/
    );
    expect(landing).toContain("<Alternatives />");
    expect(manifest.landing.partials).toContainEqual(
      expect.objectContaining({ source: "README.md", sections: ["Alternatives"] })
    );
    const section = (findSection(readme, "Alternatives") ?? "").replace(/\s+/g, " ");
    expect(section).toContain(
      "As of September 2026, I have not found an open-source tool that does all four for services you already run"
    );
    expect(section).toContain("open an issue");
  });

  it("says who did the security review, and that the tool is a preview", () => {
    const prose = landing.replace(/\s+/g, " ");
    expect(prose).toContain(
      "was done by an AI review agent at the maintainer's direction. It is not an independent audit"
    );
    expect(prose).toContain("0.x preview");
    expect(prose).toContain("the read-only mirror");
    // The mirror may be empty until its token is configured: nothing may say
    // the code is on GitHub.
    expect(prose).not.toMatch(/(code|source) (is|lives) on GitHub/i);
  });

  it("sends vulnerability reports where SECURITY.md does, and to no address it does not list", () => {
    // MDX comments are not rendered; the TODO about the mailbox lives in one.
    const rendered = landing.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const policy = read("SECURITY.md");
    for (const address of rendered.match(/[\w.+-]+@[\w-]+(?:\.[A-Za-z][\w-]*)+/g) ?? []) {
      expect(policy, `${address} is not in SECURITY.md`).toContain(address);
    }
    expect(rendered).toContain(
      "[confidential issue on GitLab](https://gitlab.com/jojithedev/wayscribe/-/issues/new)"
    );
  });
});
