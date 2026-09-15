// Types for scripts/upgrade-test-lib.mjs, which is plain JavaScript run with
// `node`, so tests/upgrade-test-lib.test.ts can import it under type-aware lint.

export declare const RELEASE_TAG: RegExp;
export declare const REDACTED: string;
export declare function releaseTags(tags: readonly string[]): string[];
export declare function containedIn(
  expected: unknown,
  actual: unknown,
  path: string,
  mismatches: string[],
  headerMaps?: ReadonlySet<string>
): void;
export declare function doctorVerdict(
  exitCode: number,
  stdout: string,
  required: readonly string[]
): { ok: boolean; checks: number; problems: string[] };
