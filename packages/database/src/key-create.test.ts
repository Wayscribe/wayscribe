import { describe, expect, it } from "vitest";
import { formatIssuedKey, KEY_CREATE_USAGE, parseKeyCreateArgs } from "./key-create.js";

const issued = {
  id: "00000000-0000-4000-8000-000000000000",
  apiKey: "wsk_test0000000000000000000000000000",
  keyPrefix: "wsk_test0000",
  projectSlug: "acme",
  environmentName: "production"
};

describe("parseKeyCreateArgs", () => {
  it("reads the project, the environment and an optional name", () => {
    expect(parseKeyCreateArgs(["acme", "production", "acme", "worker"])).toEqual({
      ok: true,
      projectSlug: "acme",
      environmentName: "production",
      name: "acme worker",
      json: false
    });
  });

  it("defaults the name to the environment's", () => {
    expect(parseKeyCreateArgs(["acme", "production"])).toMatchObject({
      ok: true,
      name: "production-key"
    });
  });

  it("takes --json anywhere and keeps it out of the name", () => {
    expect(parseKeyCreateArgs(["--json", "acme", "production", "worker"])).toMatchObject({
      ok: true,
      projectSlug: "acme",
      environmentName: "production",
      name: "worker",
      json: true
    });
    expect(parseKeyCreateArgs(["acme", "production", "worker", "--json"])).toMatchObject({
      ok: true,
      name: "worker",
      json: true
    });
  });

  it.each([[[]], [["acme"]], [["--json"]], [["--json", "acme"]]])(
    "refuses %j, with the usage text",
    (args) => {
      const parsed = parseKeyCreateArgs(args);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.message).toBe(KEY_CREATE_USAGE);
    }
  );

  it.each([["-j"], ["-x"], ["-A1"], ["--jsonl=1"]])(
    "refuses %s before -- rather than issuing a key named after it",
    (arg) => {
      const parsed = parseKeyCreateArgs(["acme", "production", arg]);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.message).toContain(
        `Unknown argument: ${arg.split("=")[0] ?? ""}`
      );
    }
  );

  it("takes a name beginning with a dash after --, and --json after it as a word of the name", () => {
    expect(parseKeyCreateArgs(["acme", "production", "--json", "--", "-x", "--json"])).toEqual({
      ok: true,
      projectSlug: "acme",
      environmentName: "production",
      name: "-x --json",
      json: true
    });
  });

  it("refuses an unknown flag rather than taking it as a name", () => {
    const parsed = parseKeyCreateArgs(["acme", "production", "--jsonl"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.message).toContain("--jsonl");
  });

  it("says in its usage text that --json prints one object", () => {
    expect(KEY_CREATE_USAGE).toContain("--json");
  });
});

describe("formatIssuedKey", () => {
  it("prints the human form when --json is absent", () => {
    expect(formatIssuedKey(issued, false)).toEqual([
      "Key issued for acme/production.",
      "",
      "  API key (shown once, not recoverable):",
      "    wsk_test0000000000000000000000000000",
      "",
      "  prefix: wsk_test0000"
    ]);
  });

  it("prints one JSON object and nothing else with --json", () => {
    const lines = formatIssuedKey(issued, true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      apiKey: "wsk_test0000000000000000000000000000",
      keyPrefix: "wsk_test0000",
      projectSlug: "acme",
      environmentName: "production"
    });
  });

  it("keeps the key's id out of the JSON, which no caller needs and the human form omits", () => {
    expect(JSON.parse(formatIssuedKey(issued, true)[0] ?? "")).not.toHaveProperty("id");
  });
});
