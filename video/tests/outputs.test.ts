import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearOutputs, partialName, writeThenRename } from "../scripts/outputs";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wayscribe-outputs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const names = async () => (await readdir(dir)).sort();

describe("render outputs", () => {
  it("keeps the extension on the temporary name, which ffmpeg reads to pick the format", () => {
    expect(partialName(join(dir, "wayscribe-demo.mp4"))).toBe(
      join(dir, "wayscribe-demo.partial.mp4")
    );
    expect(partialName(join(dir, "demo-diff.gif"))).toBe(join(dir, "demo-diff.partial.gif"));
  });

  it("clears the last run's outputs, files and directories alike, and ignores the absent", async () => {
    await writeFile(join(dir, "report.txt"), "All checks pass.\n");
    await writeFile(join(dir, "wayscribe-demo.mp4"), "old");
    await writeFile(join(dir, "wayscribe-demo.partial.mp4"), "half");
    await mkdir(join(dir, "stills", "wide"), { recursive: true });
    await writeFile(join(dir, "stills", "wide", "01-hook.png"), "old");
    await writeFile(join(dir, "keep.txt"), "not an output");
    await clearOutputs(dir, ["report.txt", "wayscribe-demo.mp4", "stills", "never-written.gif"]);
    expect(await names()).toEqual(["keep.txt"]);
  });

  it("clears a leftover temporary file even when the final file is absent", async () => {
    await writeFile(join(dir, "demo-diff.partial.gif"), "half");
    await clearOutputs(dir, ["demo-diff.gif"]);
    expect(await names()).toEqual([]);
  });

  it("writes to the temporary name and renames on success", async () => {
    const final = join(dir, "wayscribe-demo.mp4");
    await writeThenRename(final, async (partial) => {
      expect(partial).toBe(join(dir, "wayscribe-demo.partial.mp4"));
      await writeFile(partial, "encoded");
      // Mid-write, nothing looks finished.
      expect(await names()).toEqual(["wayscribe-demo.partial.mp4"]);
    });
    expect(await names()).toEqual(["wayscribe-demo.mp4"]);
    expect(await readFile(final, "utf8")).toBe("encoded");
  });

  it("leaves nothing behind when the write fails, and does not touch an earlier file", async () => {
    const final = join(dir, "wayscribe-demo.mp4");
    await writeFile(final, "earlier");
    await expect(
      writeThenRename(final, async (partial) => {
        await writeFile(partial, "half");
        throw new Error("ffmpeg died");
      })
    ).rejects.toThrow("ffmpeg died");
    expect(await names()).toEqual(["wayscribe-demo.mp4"]);
    expect(await readFile(final, "utf8")).toBe("earlier");
  });

  it("fails when the write produced nothing to rename", async () => {
    await expect(writeThenRename(join(dir, "a.mp4"), () => undefined)).rejects.toThrow();
    expect(await names()).toEqual([]);
  });
});
