// Types for scripts/release-manifest.mjs, which is plain JavaScript run with
// `node`, so src/package.test.ts can import it under type-aware lint.
export declare const LEGAL_FILES: readonly string[];
export declare function releaseManifest(packed: Record<string, unknown>): Record<string, unknown>;
export declare const REPOSITORY_BLOB: string;
export declare const PACKAGE_DIRECTORY: string;
export declare function releaseReadme(markdown: string, version: string): string;
