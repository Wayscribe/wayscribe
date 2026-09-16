import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverEnvSchema } from "../packages/config/src/schema.js";
import { DEFAULT_SECRET_PATHS } from "../packages/payload-security/src/default-secrets.js";

/**
 * docs/SECURITY_REVIEW.md is read by a security engineer deciding in a few
 * minutes whether a pilot may run. Every statement on it links to its source,
 * so the links have to land, and the numbers it repeats have to be the ones the
 * code enforces (ADR-040).
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");
const PAGE = "docs/SECURITY_REVIEW.md";
const page = read(PAGE);

/** GitLab's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-")
    .replace(/-{2,}/g, "-");
}

function anchors(markdown: string): Set<string> {
  const outsideCode = markdown.replace(/^```[\s\S]*?^```/gm, "");
  return new Set(
    [...outsideCode.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1] ?? ""))
  );
}

describe(PAGE, () => {
  const links = [...page.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter((target) => !/^[a-z]+:/.test(target));

  it("links only to files that exist, and to headings they have", () => {
    expect(links.length, "the page lost its source links").toBeGreaterThan(40);
    for (const link of links) {
      const [path = "", anchor] = link.split("#");
      const target = normalize(join(dirname(PAGE), path));
      expect(existsSync(join(root, target)), `${link} names a missing file`).toBe(true);
      if (anchor !== undefined) {
        expect(anchors(read(target)).has(anchor), `${link} names a missing heading`).toBe(true);
      }
    }
  });

  it("cites only ADRs the decision log has", () => {
    const recorded = new Set(
      [...read("docs/DECISIONS.md").matchAll(/^## (ADR-\d+)/gm)].map((match) => match[1])
    );
    for (const [cited] of page.matchAll(/ADR-\d+/g)) {
      expect(recorded.has(cited), `${cited} is not in the decision log`).toBe(true);
    }
  });

  it("uses no em or en dashes", () => {
    expect(page).not.toMatch(/[–—]/);
  });

  it("repeats the numbers the code enforces", () => {
    expect(page).toContain("AES-256-GCM");
    expect(read("packages/payload-security/src/encryption.ts")).toContain('"aes-256-gcm"');

    expect(page).toContain("192 random bits");
    expect(read("packages/payload-security/src/api-key.ts")).toMatch(/const KEY_BYTES = 24;/);

    expect(page).toContain("admin token** (at least 32 characters)");
    expect(serverEnvSchema.shape.ADMIN_TOKEN.safeParse("a".repeat(31)).success).toBe(false);
    expect(serverEnvSchema.shape.ADMIN_TOKEN.safeParse("a".repeat(32)).success).toBe(true);

    expect(page).toContain("12 hours");
    expect(read("apps/web/app/api/login/route.ts")).toContain(
      "SESSION_DURATION_MS = 12 * 60 * 60 * 1000"
    );

    expect(page).toContain("five failed credentials a minute");
    expect(page).toContain("for five minutes");
    const throttle = read("apps/api/src/address-throttle.ts");
    expect(throttle).toMatch(/maxFailures: 5,\s+windowMs: 60_000,\s+cooldownMs: 300_000/);

    expect(page).toContain("eight webhook signature headers");
    const webhook = DEFAULT_SECRET_PATHS.filter((path) => /signature|hmac/.test(path));
    expect(webhook).toHaveLength(8);

    expect(page).toContain("new environments get `redacted-payload`");
    expect(read("packages/database/migrations/002_environments.js")).toContain(
      'table.text("capture_mode").notNullable().defaultTo("redacted-payload")'
    );
  });

  it("shows a placeholder image tag, never a real release", () => {
    expect(page).toContain("api:vX.Y.Z");
    expect(page).not.toMatch(/:v\d+\.\d+\.\d+/);
  });
});
