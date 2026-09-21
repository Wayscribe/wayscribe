import { mkdtemp, writeFile, readFile, readdir, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackup } from "./archive.js";
let dir: string;
const databaseUrl = "postgresql://user:password@localhost/source";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backup-files-test-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
async function tool(body: string): Promise<void> {
  await writeFile(
    join(dir, "pg_dump"),
    `#!${process.execPath}\nif(process.argv.includes('--version')) {console.log('pg_dump (PostgreSQL) 18.4');process.exit(0)}\n${body}`,
    { mode: 0o700 }
  );
  vi.stubEnv("PATH", dir);
}
it("publishes a complete private archive", async () => {
  await tool("process.stdout.write('PGDMPsynthetic')");
  const output = join(dir, "backup.dump");
  expect(await createBackup({ databaseUrl, output, timeoutMs: 5000 })).toEqual({ bytes: 14 });
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  expect((await readdir(dir)).sort()).toEqual(["backup.dump", "pg_dump"]);
});
it.each([false, true])(
  "preserves an existing destination including symlinks (%s)",
  async (link) => {
    await tool("process.stdout.write('overwrite')");
    const output = join(dir, "backup.dump");
    await writeFile(join(dir, "keep"), "keep me");
    if (link) await symlink(join(dir, "keep"), output);
    else await writeFile(output, "keep me");
    await expect(createBackup({ databaseUrl, output, timeoutMs: 5000 })).rejects.toMatchObject({
      code: "output_exists"
    });
    expect(await readFile(output, "utf8")).toBe("keep me");
  }
);
it("preserves a destination created during dumping", async () => {
  const output = join(dir, "backup.dump");
  await tool(
    `require('fs').writeFileSync(${JSON.stringify(output)},'racer');process.stdout.write('PGDMPnew')`
  );
  await expect(createBackup({ databaseUrl, output, timeoutMs: 5000 })).rejects.toMatchObject({
    code: "output_exists"
  });
  expect(await readFile(output, "utf8")).toBe("racer");
  expect((await readdir(dir)).sort()).toEqual(["backup.dump", "pg_dump"]);
});
it("removes owned partial output on failure and timeout", async () => {
  const output = join(dir, "backup.dump");
  await tool("process.stdout.write('partial');process.exit(1)");
  await expect(createBackup({ databaseUrl, output, timeoutMs: 5000 })).rejects.toMatchObject({
    code: "tool_failed"
  });
  await tool(
    "process.stdout.write('partial');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  );
  await expect(createBackup({ databaseUrl, output, timeoutMs: 300 })).rejects.toMatchObject({
    code: "timeout"
  });
  expect(await readdir(dir)).toEqual(["pg_dump"]);
});
it("refuses unsupported connections and missing/old tools without reserving output", async () => {
  const output = join(dir, "backup.dump");
  vi.stubEnv("PATH", dir);
  await expect(createBackup({ databaseUrl, output, timeoutMs: 5000 })).rejects.toMatchObject({
    code: "tool_unavailable"
  });
  await expect(
    createBackup({ databaseUrl: `${databaseUrl}?service=evil`, output, timeoutMs: 5000 })
  ).rejects.toMatchObject({ code: "connection_unsupported" });
  expect(await readdir(dir)).toEqual([]);
});
it("refuses pre-18 tools before output reservation", async () => {
  await writeFile(
    join(dir, "pg_dump"),
    `#!${process.execPath}\nconsole.log('pg_dump (PostgreSQL) 17.1')`,
    { mode: 0o700 }
  );
  vi.stubEnv("PATH", dir);
  await expect(
    createBackup({ databaseUrl, output: join(dir, "old.dump"), timeoutMs: 1000 })
  ).rejects.toMatchObject({ code: "tool_version" });
  expect(await readdir(dir)).toEqual(["pg_dump"]);
});
