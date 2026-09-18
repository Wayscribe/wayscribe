import { describe, expect, it } from "vitest";
import {
  apiKeyShapeProblem,
  doctorExitCode,
  DOCTOR_USAGE,
  formatDoctor,
  parseDoctorArgs,
  scrub,
  secretsIn,
  versionResult,
  type CheckResult
} from "./doctor.js";

describe("parseDoctorArgs", () => {
  it("accepts no arguments", () => {
    expect(parseDoctorArgs([])).toEqual({ ok: true });
  });

  it("reads both flags, separated or joined with =", () => {
    expect(
      parseDoctorArgs(["--api-url", "http://api:8080", "--api-key=wsk_abcdefghijklmnop"])
    ).toEqual({ ok: true, apiUrl: "http://api:8080", apiKey: "wsk_abcdefghijklmnop" });
  });

  it("keeps an = inside a value", () => {
    expect(parseDoctorArgs(["--api-key=wsk_a=b"])).toEqual({ ok: true, apiKey: "wsk_a=b" });
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
    const parsed = parseDoctorArgs(["wsk_pasted_without_its_flag_00000000"]);
    expect(parsed.ok ? "" : parsed.message).not.toContain("wsk_pasted");
  });

  it("takes the key from WAYSCRIBE_API_KEY when the flag is absent", () => {
    expect(parseDoctorArgs([], { WAYSCRIBE_API_KEY: "wsk_fromtheenvironment000000" })).toEqual({
      ok: true,
      apiKey: "wsk_fromtheenvironment000000"
    });
  });

  it("lets the flag win over the environment", () => {
    expect(
      parseDoctorArgs(["--api-key=wsk_fromtheflag0000000000"], {
        WAYSCRIBE_API_KEY: "wsk_fromtheenvironment000000"
      })
    ).toEqual({ ok: true, apiKey: "wsk_fromtheflag0000000000" });
  });

  it.each(["", "   "])("treats a blank WAYSCRIBE_API_KEY as unset (%j)", (value) => {
    expect(parseDoctorArgs([], { WAYSCRIBE_API_KEY: value })).toEqual({ ok: true });
  });

  it("trims the environment's value, which a secrets file often ends with a newline", () => {
    expect(parseDoctorArgs([], { WAYSCRIBE_API_KEY: "wsk_withanewline000000000\n" })).toEqual({
      ok: true,
      apiKey: "wsk_withanewline000000000"
    });
  });

  it("says in its usage text that the key may come from the environment", () => {
    expect(DOCTOR_USAGE).toContain("WAYSCRIBE_API_KEY");
  });
});

describe("apiKeyShapeProblem", () => {
  it("accepts a key in the current form", () => {
    expect(apiKeyShapeProblem("wsk_" + "q8Zr4LmN2pXw7Kc9Vt3Hb6Js1Dy5Gf0A")).toBeNull();
  });

  it("accepts a key issued before the rename, which starts fr_", () => {
    expect(apiKeyShapeProblem("fr_" + "q8Zr4LmN2pXw7Kc9Vt3Hb6Js1Dy5Gf0A")).toBeNull();
  });

  it.each([["sk_" + "q8Zr4LmN2pXw7Kc9Vt3Hb6Js1Dy5Gf0A"], ["wsk_short"], [""]])(
    "refuses %j, naming the wsk_ form",
    (presented) => {
      const problem = apiKeyShapeProblem(presented);
      expect(problem?.status).toBe("FAIL");
      expect(problem?.detail).toBe(
        "The key given is not a Wayscribe API key, which starts wsk_ (or fr_ for keys issued before the rename)."
      );
    }
  );
});

describe("formatDoctor", () => {
  const results: CheckResult[] = [
    { status: "PASS", check: "Database reachable", detail: 'Connected to database "wayscribe".' },
    { status: "WARN", check: "Projects and keys", detail: "No project.", fix: "Create one." },
    { status: "FAIL", check: "ADMIN_TOKEN", detail: "A default.", fix: "Set your own." },
    { status: "SKIP", check: "API key", detail: "Not checked: migrations are pending." }
  ];

  it("prints one line per check, the fix beneath it, and a summary", () => {
    expect(formatDoctor(results)).toEqual([
      'PASS  Database reachable      Connected to database "wayscribe".',
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

describe("scrubbing secrets from results", () => {
  const result = (detail: string, fix?: string): CheckResult => ({
    status: "FAIL",
    check: "Probe",
    detail,
    ...(fix === undefined ? {} : { fix })
  });

  it("collects every configured secret, the database password raw and decoded", () => {
    expect(
      secretsIn(
        {
          ADMIN_TOKEN: "admin-token-value-0000000000000000",
          ENCRYPTION_KEY: " encryption-key-value-000000000000 ",
          ENCRYPTION_KEY_PREVIOUS: "",
          DATABASE_URL: "postgresql://wayscribe:p%40ss%2Fword@db:5432/wayscribe"
        },
        "wsk_presentedkey00000000000000000000"
      ).sort()
    ).toEqual(
      [
        "admin-token-value-0000000000000000",
        "encryption-key-value-000000000000",
        "wsk_presentedkey00000000000000000000",
        "p%40ss%2Fword",
        "p@ss/word"
      ].sort()
    );
  });

  it("scrubs a password of four characters or more wherever it appears, in detail and fix", () => {
    const secrets = secretsIn({ DATABASE_URL: "postgresql://u:hunt@db/wayscribe" }, undefined);
    expect(scrub([result("role said hunt", "not hunt again")], secrets)).toEqual([
      result("role said [redacted]", "not [redacted] again")
    ]);
  });

  it("leaves a password shorter than four characters alone, since it would blank ordinary text", () => {
    const secrets = secretsIn({ DATABASE_URL: "postgresql://u:a1@db/wayscribe" }, undefined);
    expect(secrets).toEqual([]);
    expect(scrub([result("PostgreSQL 17.1a1")], secrets)).toEqual([result("PostgreSQL 17.1a1")]);
  });

  it("scrubs every occurrence, not only the first", () => {
    expect(scrub([result("xsecretx and secret")], ["secret"])).toEqual([
      result("x[redacted]x and [redacted]")
    ]);
  });
});

describe("versionResult", () => {
  it("fails below 15, passes from 15 to 18, and warns above 18, the newest CI tests", () => {
    expect(versionResult({ num: 140_011, text: "14.11" }).status).toBe("FAIL");
    expect(versionResult({ num: 150_000, text: "15.0" }).status).toBe("PASS");
    expect(versionResult({ num: 160_004, text: "16.4" }).status).toBe("PASS");
    expect(versionResult({ num: 170_006, text: "17.6" }).status).toBe("PASS");
    expect(versionResult({ num: 180_000, text: "18.0" }).status).toBe("PASS");
    expect(versionResult({ num: 180_099, text: "18.99" }).status).toBe("PASS");
    expect(versionResult({ num: 190_000, text: "19beta1" }).status).toBe("WARN");
  });

  it("names the tested releases in its advice", () => {
    expect(versionResult({ num: 140_011, text: "14.11" })).toMatchObject({
      detail: "PostgreSQL 14.11 is older than 15, the oldest supported.",
      fix: "Upgrade PostgreSQL to 15 or later; CI tests 15, 17 and 18."
    });
    expect(versionResult({ num: 190_001, text: "19.1" })).toMatchObject({
      detail: "PostgreSQL 19.1 is newer than 18, the newest release CI tests."
    });
    expect(versionResult({ num: 160_004, text: "16.4" })).toMatchObject({
      detail: "PostgreSQL 16.4."
    });
  });
});
