import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The published bundle inlines the workspace code it imports and nothing from a
 * registry package, with the options `scripts/bundle.mjs` uses.
 *
 * The SDK takes constants from `@flight-recorder/protocol`, whose root imports
 * Zod at module level. Importing from that root rather than a Zod-free subpath
 * still builds and still passes every other test, and adds some 700 KB to every
 * host. This is what notices.
 */
describe("the bundle", () => {
  it("inlines only workspace sources and imports only Node built-ins", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      conditions: ["development"],
      external: ["node:*"],
      write: false,
      metafile: true,
      logLevel: "silent"
    });

    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter((path) => path.includes("node_modules"))).toEqual([]);

    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((one) => one.path)
    );
    expect(imports.filter((path) => !path.startsWith("node:"))).toEqual([]);
  });
});
