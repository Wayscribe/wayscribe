// Types for scripts/release-manifest.mjs, which is plain JavaScript run with
// `node`, so src/package.test.ts can import it under type-aware lint.
export declare function releaseManifest(packed: Record<string, unknown>): Record<string, unknown>;
