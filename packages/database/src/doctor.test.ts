import { describe, expect, it } from "vitest";
import {
  doctorExitCode,
  formatDoctor,
  parseDoctorArgs,
  versionResult,
  type CheckResult
} from "./doctor.js";

describe("parseDoctorArgs", () => {
  it("accepts no arguments", () => {
    expect(parseDoctorArgs([])).toEqual({ ok: true });
  });

  it("reads both flags, separated or joined with =", () => {
    expect(
      parseDoctorArgs(["--api-url", "http://api:8080", "--api-key=fr_abcdefghijklmnop"])
    ).toEqual({ ok: true, apiUrl: "http://api:8080", apiKey: "fr_abcdefghijklmnop" });
  });

  it("keeps an = inside a value", () => {
    expect(parseDoctorArgs(["--api-key=fr_a=b"])).toEqual({ ok: true, apiKey: "fr_a=b" });
  });

  it.each([
    [["--api-url"], "--api-url needs a value."],
    [["--api-key="], "--api-key needs a value."],
    [["--api-url", "http://a", "--api-url", "http://b"], "--api-url was given twice."],
    [["--api-url", "ftp://api"], "--api-url must be an http:// or https:// URL."],
    [["--verbose"], "Unknown argument."]
  ])("refuses %j", (args, message) => {
    const parsed = parseDoctorArgs(args);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain(message);
  });

  it("never echoes an argument it does not recognise, which may be a key", () => {
    const parsed = parseDoctorArgs(["fr_pasted_without_its_flag_000000000"]);
    expect(parsed.ok ? "" : parsed.message).not.toContain("fr_pasted");
  });
});

describe("formatDoctor", () => {
  const results: CheckResult[] = [
    { status: "PASS", check: "Database reachable", detail: 'Connected to database "flight".' },
    { status: "WARN", check: "Projects and keys", detail: "No project.", fix: "Create one." },
    { status: "FAIL", check: "ADMIN_TOKEN", detail: "A default.", fix: "Set your own." },
    { status: "SKIP", check: "API key", detail: "Not checked: migrations are pending." }
  ];

  it("prints one line per check, the fix beneath it, and a summary", () => {
    expect(formatDoctor(results)).toEqual([
      'PASS  Database reachable      Connected to database "flight".',
      "WARN  Projects and keys       No project.",
      "                              Fix: Create one.",
      "FAIL  ADMIN_TOKEN             A default.",
      "                              Fix: Set your own.",
      "SKIP  API key                 Not checked: migrations are pending.",
      "",
      "1 failed, 1 warning, 1 passed, 1 skipped."
    ]);
  });

  it("exits 1 only when something failed", () => {
    expect(doctorExitCode(results)).toBe(1);
    expect(doctorExitCode(results.filter((result) => result.status !== "FAIL"))).toBe(0);
  });
});

describe("versionResult", () => {
  it("fails below 15, warns below 17, and passes on 17 and later", () => {
    expect(versionResult({ num: 140_011, text: "14.11" }).status).toBe("FAIL");
    expect(versionResult({ num: 150_000, text: "15.0" }).status).toBe("WARN");
    expect(versionResult({ num: 160_004, text: "16.4" }).status).toBe("WARN");
    expect(versionResult({ num: 170_006, text: "17.6" }).status).toBe("PASS");
    expect(versionResult({ num: 180_000, text: "18.0" }).status).toBe("PASS");
  });
});
