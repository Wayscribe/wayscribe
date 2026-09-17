import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The stack recipes in `docs/recipes/` show code, and code in documentation
 * drifts from the API it calls. Each recipe's code lives in
 * `examples/recipes/<name>/`, and this checks two things about it:
 *
 * - It type-checks against the SDK's source, with each recipe's own
 *   tsconfig.json. The frameworks it uses (Express, BullMQ, Fastify, the AWS
 *   SQS client, Stripe, `next/server`) are stubbed in `examples/recipes/stubs`
 *   rather than installed, so the check needs nothing outside this workspace.
 * - Every `typescript` block in the recipe's page appears, as written, in that
 *   code, so the page cannot show something the check never saw.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const recipesDir = join(root, "examples/recipes");
const docsDir = join(root, "docs/recipes");
const sdkTypes = join(root, "packages/sdk-node/src/types.ts");

const RECIPES = ["express-bullmq-hubspot", "fastify-sqs-salesforce", "nextjs-stripe"];

function parseConfig(configPath: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) throw new Error(format([read.error]));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
}

function format(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n"
  });
}

/** A program for one tsconfig, with extra in-memory files beside its own. */
function program(configPath: string, extra: Record<string, string> = {}): ts.Program {
  const config = parseConfig(configPath);
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = extra[fileName];
    return text === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => fileName in extra || fileExists(fileName);
  return ts.createProgram({
    rootNames: [...config.fileNames, ...Object.keys(extra)],
    options: config.options,
    host
  });
}

function errors(checked: ts.Program): readonly ts.Diagnostic[] {
  return ts.getPreEmitDiagnostics(checked);
}

/** Every file of a recipe that is not configuration, read as one text. */
function recipeSource(name: string, directory = join(recipesDir, name)): string {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return recipeSource(name, path);
      return entry.name.endsWith(".ts") ? readFileSync(path, "utf8") : "";
    })
    .join("\n");
}

function typescriptBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```typescript\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
}

describe("the stack recipes", () => {
  it("has a checked code directory and a page for each recipe, and nothing else", () => {
    const directories = readdirSync(recipesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "stubs")
      .map((entry) => entry.name)
      .sort();
    const pages = readdirSync(docsDir)
      .filter((file) => file.endsWith(".md") && file !== "README.md")
      .map((file) => file.replace(/\.md$/, ""))
      .sort();
    expect(directories).toEqual(RECIPES);
    expect(pages).toEqual(RECIPES);
  });

  describe.each(RECIPES)("%s", (name) => {
    const configPath = join(recipesDir, name, "tsconfig.json");

    it("type-checks against the SDK source", () => {
      const checked = program(configPath);
      expect(format(errors(checked))).toBe("");
      // Resolved to the source, not to nothing: an unresolved import would be
      // an error above, and a resolution to some other copy would miss this.
      expect(checked.getSourceFile(sdkTypes)).toBeDefined();
    }, 60_000);

    it("shows only code that the check covers", () => {
      const source = recipeSource(name);
      const blocks = typescriptBlocks(readFileSync(join(docsDir, `${name}.md`), "utf8"));
      expect(blocks.length, `docs/recipes/${name}.md has no typescript blocks`).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(source, `a block in docs/recipes/${name}.md is not in the recipe's code`).toContain(
          block
        );
      }
    });
  });

  it("fails a recipe that calls the SDK the way it no longer accepts", () => {
    // Without this, a configuration that resolved the SDK to `any` would pass
    // every recipe and check nothing.
    const configPath = join(recipesDir, "express-bullmq-hubspot", "tsconfig.json");
    const probe = join(recipesDir, "express-bullmq-hubspot", "src", "drift-probe.ts");
    const checked = program(configPath, {
      [probe]: [
        'import { createRecorder } from "@flight-recorder/node";',
        'const recorder = createRecorder({ endpoint: "http://localhost:8080" });',
        'const journey = recorder.startJourney({ entity: { type: "lead", id: "1" } });',
        "// fail() once took metadata as its third argument.",
        'journey.fail("give-up", new Error("x"), { queue: "dead-letter" });',
        "recorder.continueJourney({ ctx: undefined });",
        ""
      ].join("\n")
    });
    const found = errors(checked).filter((d) => d.file?.fileName === probe);
    expect(found.map((d) => d.code).sort()).toEqual([2345, 2353, 2353]);
  }, 60_000);
});
