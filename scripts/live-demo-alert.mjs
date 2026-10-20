/* global AbortSignal */
// The live-demo CI job's after_script (.gitlab-ci.yml, ADR-073): when the
// check failed, post one line with the pipeline's URL to NTFY_TOPIC_URL.
//
// It never fails the job a second time. GitLab ignores an after_script's exit
// status anyway, and a missing topic (NTFY_TOPIC_URL is protected, so a merge
// request pipeline has none) or an unreachable ntfy prints a warning and exits
// 0. The topic URL is never printed.
//
//   CI_JOB_STATUS=failed NTFY_TOPIC_URL=https://ntfy.sh/<topic> node scripts/live-demo-alert.mjs

import { pathToFileURL } from "node:url";

/** How long the post may take before it is given up. */
export const POST_TIMEOUT_MS = 10_000;

/**
 * @param {{
 *   env: Record<string, string | undefined>;
 *   post: (url: string, body: string) => Promise<{ ok: boolean; status: number }>;
 *   log: (line: string) => void;
 * }} io
 * @returns {Promise<"not-failed" | "no-topic" | "sent" | "send-failed">}
 */
export async function alertOnFailure({ env, post, log }) {
  if (env.CI_JOB_STATUS !== "failed") return "not-failed";
  const topic = env.NTFY_TOPIC_URL;
  if (topic === undefined || topic === "") {
    log(
      "live-demo: warning: NTFY_TOPIC_URL is not set (it reaches main and v* pipelines only), so no alert was sent"
    );
    return "no-topic";
  }
  const ref = env.CI_COMMIT_REF_NAME ?? "an unknown ref";
  const pipeline = env.CI_PIPELINE_URL ?? "no pipeline URL";
  try {
    const response = await post(topic, `Wayscribe live-demo check failed on ${ref}: ${pipeline}`);
    if (!response.ok) {
      log(`live-demo: warning: ntfy answered ${String(response.status)}, so no alert was sent`);
      return "send-failed";
    }
    log("live-demo: alert sent");
    return "sent";
  } catch (error) {
    const reason = error instanceof Error ? error.name : "an error";
    log(`live-demo: warning: ntfy could not be reached (${reason}), so no alert was sent`);
    return "send-failed";
  }
}

/** POSTs `body` as plain text, giving up after POST_TIMEOUT_MS. */
export async function postText(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8", title: "Wayscribe live demo" },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS)
  });
  return { ok: response.ok, status: response.status };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await alertOnFailure({ env: process.env, post: postText, log: (line) => console.log(line) });
}
