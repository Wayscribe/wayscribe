import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnFailure } from "../src/spawn";

const ok = { status: 0, signal: null, stderr: "" };

describe("spawn failures", () => {
  it("reports nothing for a clean exit", () => {
    expect(spawnFailure("ffmpeg", ["-i", "a"], ok)).toBeUndefined();
  });

  it("says a missing program is missing, not that its output was unreadable", () => {
    const error = Object.assign(new Error("spawnSync ffmpeg ENOENT"), { code: "ENOENT" });
    // spawnSync leaves stderr null (or undefined) when the program never started.
    const message = spawnFailure("ffmpeg", ["-i", "a"], {
      error,
      status: null,
      signal: null,
      stderr: null
    });
    expect(message).toBe("ffmpeg not found on PATH.");
  });

  it("names each program, and a full path as the path it is", () => {
    const error = Object.assign(new Error("x"), { code: "ENOENT" });
    const bare = { error, status: null, signal: null };
    expect(spawnFailure("ffprobe", [], bare)).toBe("ffprobe not found on PATH.");
    // An override (FFMPEG=/opt/none/ffmpeg) that points nowhere is not a PATH problem.
    expect(spawnFailure("/opt/none/ffmpeg", [], bare)).toBe("/opt/none/ffmpeg not found.");
  });

  it("reports any other spawn error with its own message", () => {
    const error = Object.assign(new Error("spawnSync ffmpeg EACCES"), { code: "EACCES" });
    expect(
      spawnFailure("ffmpeg", [], { error, status: null, signal: null, stderr: undefined })
    ).toBe("ffmpeg could not run: spawnSync ffmpeg EACCES");
  });

  it("reports a killed program by its signal, before looking at stderr", () => {
    expect(
      spawnFailure("ffmpeg", ["-i", "a"], { status: null, signal: "SIGKILL", stderr: undefined })
    ).toBe("ffmpeg was killed by SIGKILL.");
  });

  it("reports a non-zero exit with the tail of stderr", () => {
    const stderr = `${"x".repeat(5000)}\nthe real reason`;
    const message = spawnFailure("ffmpeg", ["-i", "a", "b"], { status: 1, signal: null, stderr });
    expect(message).toMatch(/^ffmpeg -i a b exited with status 1:\n/);
    expect(message).toMatch(/the real reason$/);
    expect(message?.length).toBeLessThan(2300);
  });

  it("copes with a non-zero exit that left no stderr", () => {
    expect(spawnFailure("ffprobe", ["f"], { status: 2, signal: null, stderr: undefined })).toBe(
      "ffprobe f exited with status 2:\n(no output)"
    );
  });

  it("reports an exit that was neither a status nor a signal", () => {
    expect(spawnFailure("ffmpeg", [], { status: null, signal: null, stderr: "" })).toBe(
      "ffmpeg ended without an exit status."
    );
  });

  it("agrees with a real spawn of a program that does not exist", () => {
    const result = spawnSync("wayscribe-no-such-program", [], { encoding: "utf8" });
    expect(spawnFailure("wayscribe-no-such-program", [], result)).toBe(
      "wayscribe-no-such-program not found on PATH."
    );
  });
});
