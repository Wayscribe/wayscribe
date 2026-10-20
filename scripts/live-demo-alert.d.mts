// Types for scripts/live-demo-alert.mjs, which is plain JavaScript run with
// `node`, so tests/live-demo-check.test.ts can import it under type-aware lint.

export declare const POST_TIMEOUT_MS: number;
export declare function alertOnFailure(io: {
  env: Record<string, string | undefined>;
  post: (url: string, body: string) => Promise<{ ok: boolean; status: number }>;
  log: (line: string) => void;
}): Promise<"not-failed" | "no-topic" | "sent" | "send-failed">;
export declare function postText(
  url: string,
  body: string
): Promise<{ ok: boolean; status: number }>;
