// Types for scripts/build-identity.mjs, which is plain JavaScript run with
// `node`, so src/bundle-identity.test.ts can import it under type-aware lint.

/** What the bundle bakes into `runtime.sdk`: the version, and the commit if one was found. */
export interface BuildIdentity {
  version: string;
  commit?: string;
}

/** Runs git with `args` in `cwd` and returns its standard output, or throws. */
export type Git = (args: string[], cwd: string) => string;

export declare const COMMIT_VARIABLES: readonly string[];

export declare function buildIdentity(options?: {
  packageRoot?: string;
  env?: Record<string, string | undefined>;
  git?: Git;
}): BuildIdentity;
