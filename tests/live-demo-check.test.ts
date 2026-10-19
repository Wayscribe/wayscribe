import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { alertOnFailure, postText } from "../scripts/live-demo-alert.mjs";
import { read } from "./docs-helpers.js";

/**
 * The live check of the public demo (ADR-073): its alert, and the line between
 * it and the end-to-end suite, which must never reach production.
 */

const TOPIC = "https://ntfy.example.test/wayscribe-alerts";
const FAILED = {
  CI_JOB_STATUS: "failed",
  NTFY_TOPIC_URL: TOPIC,
  CI_COMMIT_REF_NAME: "main",
  CI_PIPELINE_URL: "https://gitlab.com/jojithedev/wayscribe/-/pipelines/1"
};

interface Recorder {
  posts: { url: string; body: string }[];
  lines: string[];
  io: {
    post: (url: string, body: string) => Promise<{ ok: boolean; status: number }>;
    log: (line: string) => void;
  };
}

function recorder(answer: () => Promise<{ ok: boolean; status: number }>): Recorder {
  const posts: { url: string; body: string }[] = [];
  const lines: string[] = [];
  return {
    posts,
    lines,
    io: {
      post: (url: string, body: string) => {
        posts.push({ url, body });
        return answer();
      },
      log: (line: string) => lines.push(line)
    }
  };
}

describe("the live-demo alert", () => {
  it("posts one line naming the ref and the pipeline when the check failed", async () => {
    const { posts, lines, io } = recorder(() => Promise.resolve({ ok: true, status: 200 }));
    expect(await alertOnFailure({ env: FAILED, ...io })).toBe("sent");
    expect(posts).toEqual([
      {
        url: TOPIC,
        body: "Wayscribe live-demo check failed on main: https://gitlab.com/jojithedev/wayscribe/-/pipelines/1"
      }
    ]);
    expect(lines).toEqual(["live-demo: alert sent"]);
  });

  it.each(["success", "canceled", undefined])(
    "posts nothing when the job status is %s",
    async (status) => {
      const { posts, io } = recorder(() => Promise.resolve({ ok: true, status: 200 }));
      expect(await alertOnFailure({ env: { ...FAILED, CI_JOB_STATUS: status }, ...io })).toBe(
        "not-failed"
      );
      expect(posts).toEqual([]);
    }
  );

  it.each([undefined, ""])("warns, and posts nothing, without a topic (%s)", async (topic) => {
    const { posts, lines, io } = recorder(() => Promise.resolve({ ok: true, status: 200 }));
    expect(await alertOnFailure({ env: { ...FAILED, NTFY_TOPIC_URL: topic }, ...io })).toBe(
      "no-topic"
    );
    expect(posts).toEqual([]);
    expect(lines.join("\n")).toContain("warning: NTFY_TOPIC_URL is not set");
  });

  it("warns without throwing when ntfy refuses or cannot be reached, and never prints the topic", async () => {
    const refused = recorder(() => Promise.resolve({ ok: false, status: 429 }));
    expect(await alertOnFailure({ env: FAILED, ...refused.io })).toBe("send-failed");
    expect(refused.lines).toEqual(["live-demo: warning: ntfy answered 429, so no alert was sent"]);

    const unreachable = recorder(() => Promise.reject(new TypeError("fetch failed")));
    expect(await alertOnFailure({ env: FAILED, ...unreachable.io })).toBe("send-failed");
    expect(unreachable.lines).toEqual([
      "live-demo: warning: ntfy could not be reached (TypeError), so no alert was sent"
    ]);
    for (const line of [...refused.lines, ...unreachable.lines]) expect(line).not.toContain(TOPIC);
  });

  it("posts plain text over HTTP", async () => {
    const received: { method: string | undefined; type: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        received.push({ method: request.method, type: request.headers["content-type"], body });
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      expect(await postText(`http://127.0.0.1:${String(port)}/topic`, "one line")).toEqual({
        ok: true,
        status: 200
      });
      expect(received).toEqual([
        { method: "POST", type: "text/plain; charset=utf-8", body: "one line" }
      ]);
    } finally {
      server.close();
    }
  });
});

describe("the live check and the end-to-end suite", () => {
  it("keeps pnpm test:e2e on apps/web/e2e and away from the public demo", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts["test:e2e"]).toBe("playwright test");
    expect(scripts["test:live"]).toBe("playwright test --config playwright.live.config.ts");
    const e2e = read("playwright.config.ts");
    expect(e2e).toContain('testDir: "./apps/web/e2e"');
    expect(e2e).not.toContain("demo.wayscribe.dev");
  });

  it("points the live config at the public demo, under the smoke check's user agent", () => {
    const live = read("playwright.live.config.ts");
    expect(live).toContain('testDir: "./apps/web/e2e-live"');
    expect(live).toContain('process.env["LIVE_URL"] ?? "https://demo.wayscribe.dev"');
    // deploy/demo/visit-notifier skips this prefix, so a check is not a visit.
    expect(read("deploy/demo/visit-notifier/notifier.ts")).toContain(
      'SMOKE_USER_AGENT_PREFIX = "wayscribe-smoke/"'
    );
    expect(live).toContain('userAgent: "wayscribe-smoke/live-demo"');
    // Worst case must fit under the job's RUNNER_SCRIPT_TIMEOUT (12m) with install.
    expect(live).toContain("timeout: 30_000");
    expect(live).toContain("globalTimeout: 8 * 60_000");
  });

  it("only reads: the live spec sends no request but a page load", () => {
    const spec = read("apps/web/e2e-live/demo.spec.ts");
    expect(spec).not.toMatch(/\b(request|fetch)\s*[.(]/);
    expect(spec).not.toMatch(/method:/);
    expect(spec).not.toMatch(
      /\.(click|dblclick|tap|fill|press|pressSequentially|type|check|uncheck|selectOption|setInputFiles|dispatchEvent)\(|\.submit\(/
    );
  });
});
