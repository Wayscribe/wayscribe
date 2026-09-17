import { describe, expect, it } from "vitest";
import { describeTarget, parseResetArgs } from "./reset.js";

const URL = "postgresql://wayscribe:wayscribe@localhost:5432/wayscribe";

describe("parseResetArgs", () => {
  it("runs with --yes outside production", () => {
    expect(parseResetArgs(["--yes"], {}, URL)).toEqual({ ok: true });
    expect(parseResetArgs(["--yes"], { NODE_ENV: "development" }, URL)).toEqual({ ok: true });
  });

  it("refuses without --yes and names the server it would have wiped", () => {
    const parsed = parseResetArgs([], {}, URL);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("localhost:5432");
    expect(parsed.message).toContain("Nothing was changed.");
    expect(parsed.message).toContain("--yes");
  });

  it("refuses under NODE_ENV=production even with --yes", () => {
    const parsed = parseResetArgs(["--yes"], { NODE_ENV: "production" }, URL);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("NODE_ENV=production");
  });

  it.each([[["--yes", "--force"]], [["-y"]], [["yes"]]])(
    "refuses an argument it does not know: %j",
    (args) => {
      const parsed = parseResetArgs(args, {}, URL);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.message).toContain("Usage: reset --yes");
    }
  );

  it("never prints the user, password or database name", () => {
    const parsed = parseResetArgs([], {}, "postgresql://owner:s3cret-pass@db.internal:6543/ledger");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("db.internal:6543");
    for (const secret of ["owner", "s3cret-pass", "ledger"]) {
      expect(parsed.message).not.toContain(secret);
    }
  });
});

describe("describeTarget", () => {
  it("falls back when the URL has no host or does not parse", () => {
    expect(describeTarget("postgresql:///wayscribe?host=/var/run/postgresql")).toBe(
      "the configured host"
    );
    expect(describeTarget("not a url")).toBe("the configured host");
  });

  it.each([
    ["postgresql://owner:1234/5@db.internal:5432/ledger", ["1234", "5"]],
    ["postgresql://owner:9876?x@db.internal/ledger", ["9876"]]
  ])("never prints credentials the parser misreads as the host: %s", (databaseUrl, digits) => {
    const target = describeTarget(databaseUrl);
    expect(target).toBe("the configured host");
    const parsed = parseResetArgs([], {}, databaseUrl);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).not.toContain("owner");
    for (const secret of digits) expect(parsed.message).not.toContain(secret);
  });

  it("still names the host when the password holds an escaped @", () => {
    expect(describeTarget("postgresql://owner:p%40ss@db.internal:5432/ledger")).toBe(
      "db.internal:5432"
    );
  });
});
