import { describe, expect, it } from "vitest";
import { describeTarget, parseResetArgs } from "./reset.js";

const URL = "postgresql://flight:flight@localhost:5432/flight";

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
    expect(describeTarget("postgresql:///flight?host=/var/run/postgresql")).toBe(
      "the configured host"
    );
    expect(describeTarget("not a url")).toBe("the configured host");
  });
});
