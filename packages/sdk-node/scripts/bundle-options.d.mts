// Types for scripts/bundle-options.mjs, which is plain JavaScript run with
// `node`, so src/bundle.test.ts can import it under type-aware lint.
import type { BuildOptions } from "esbuild";

export declare function bundleOptions(): BuildOptions & {
  entryPoints: string[];
};
