import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Deadline, runChild, resolveTool } from "./process.js";
it("requires an executable before reserving resources", async () => {
  await expect(
    resolveTool("pg_dump", { PATH: "/missing" }, new Deadline(1000))
  ).rejects.toMatchObject({ code: "tool_unavailable" });
});
describe("owned child lifecycle", () => {
  it("kills and reaps a real SIGTERM-ignoring child by the deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "backup-child-test-"));
    const pidFile = join(dir, "pid");
    const start = Date.now();
    try {
      await expect(
        runChild(
          process.execPath,
          [
            "-e",
            `require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>process.stderr.write('sensitive'.repeat(10000)),1)`,
            pidFile
          ],
          { env: process.env, deadline: new Deadline(600) }
        )
      ).rejects.toMatchObject({ code: "timeout" });
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(Date.now() - start).toBeLessThan(2000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("never exposes child stderr", async () => {
    await expect(
      runChild(
        process.execPath,
        ["-e", "process.stderr.write('PASSWORD_SENTINEL');process.exit(3)"],
        { env: process.env, deadline: new Deadline(1000) }
      )
    ).rejects.toMatchObject({ message: "tool_failed" });
  });
  it("rejects an already aborted operation before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runChild("/not/executable", [], { env: {}, deadline: new Deadline(1000, controller.signal) })
    ).rejects.toMatchObject({ code: "aborted" });
  });
});
it("cancels a started wait even when its deadline already elapsed", async () => {
  const deadline = new Deadline(1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  let cancelled = false;
  await expect(
    deadline.wait(new Promise(() => undefined), () => {
      cancelled = true;
    })
  ).rejects.toMatchObject({ code: "timeout" });
  expect(cancelled).toBe(true);
});
