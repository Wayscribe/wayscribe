import { describe, expect, it } from "vitest";
import { parseBackupArgs } from "./args.js";
import { preflight } from "../cli-commands.js";

describe("backup arguments", () => {
  it("requires output and uses a ten-minute default", () => {
    expect(parseBackupArgs("backup:create", ["--output", "x.dump"])).toEqual({
      ok: true,
      command: "backup:create",
      output: "x.dump",
      timeoutMs: 600_000
    });
  });
  it.each(
    [
      [],
      ["--output", "x", "--output", "y"],
      ["--output", "x", "--secret=value"],
      ["--output"],
      ["x"]
    ].map((args) => [args])
  )("refuses invalid create arguments %j", (args) => {
    expect(parseBackupArgs("backup:create", args).ok).toBe(false);
  });
  it.each(["0", "-1", "1.2", "3600001", "NaN", "1e3"])("refuses timeout %s", (timeout) => {
    expect(parseBackupArgs("backup:create", ["--output", "x", "--timeout-ms", timeout]).ok).toBe(
      false
    );
  });
  it("requires a restore input and lowercase target", () => {
    expect(
      parseBackupArgs("backup:restore", [
        "--input",
        "x",
        "--database",
        "copy_1",
        "--timeout-ms",
        "3600000"
      ])
    ).toMatchObject({ ok: true, database: "copy_1", timeoutMs: 3_600_000 });
    for (const database of [
      "Copy",
      "1copy",
      "a-b",
      "a".repeat(64),
      "postgres",
      "template0",
      "template1"
    ]) {
      expect(parseBackupArgs("backup:restore", ["--input", "x", "--database", database]).ok).toBe(
        false
      );
    }
  });
  it("answers help without needing environment", () => {
    expect(preflight("backup:create", ["--help"])).toMatchObject({ run: false, code: 0 });
  });
});
