import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { bundleOptions } from "../scripts/bundle-options.mjs";

/**
 * The published bundle inlines the workspace code it imports and nothing from a
 * registry package. Built with `scripts/bundle-options.mjs`, the options
 * `scripts/bundle.mjs` builds the published bundle with.
 *
 * The SDK takes constants from `@flight-recorder/protocol`, whose root imports
 * Zod at module level. Importing from that root rather than a Zod-free subpath
 * still builds and still passes every other test, and adds some 700 KB to every
 * host. This is what notices.
 */
describe("the bundle", () => {
  it("inlines only workspace sources and imports only Node built-ins", async () => {
    const result = await build({
      ...bundleOptions(),
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
