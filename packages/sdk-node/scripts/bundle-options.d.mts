// Types for scripts/bundle-options.mjs, which is plain JavaScript run with
// `node`, so src/bundle.test.ts can import it under type-aware lint.
import type { BuildOptions } from "esbuild";
import type { BuildIdentity } from "./build-identity.mjs";

export declare function bundleOptions(identity?: BuildIdentity): BuildOptions & {
  entryPoints: string[];
  define: Record<string, string>;
};
