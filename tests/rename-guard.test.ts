import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { root } from "./docs-helpers.js";

/**
 * The product was renamed from Flight Recorder to Wayscribe (ADR-057). Any old
 * name outside the history and the deliberate exceptions below is a leftover.
 */

// POSIX ERE has no `\b`, and Apple's git reads it as a literal `b`, so word
// edges are spelled out to behave the same on every git build.
const START = "(^|[^A-Za-z0-9_])";
const END = "([^A-Za-z0-9_]|$)";
const LEGACY_PREFIX = `${START}fr_`;
const OLD = [
  "flight.?recorder",
  "x-flight",
  "flightJourney",
  "flightEntity",
  `${START}_flight${END}`,
  LEGACY_PREFIX,
  "FLIGHT_",
  "flight_session",
  String.raw`flight\.example`
].join("|");

const ALLOWED_FILES = [
  /^docs\/superpowers\/(specs|plans)\//,
  /^docs\/reviews\//,
  /^docs\/claims-audit-2026-09-16\.md$/,
  /^packages\/database\/migrations\//,
  /^docs\/DECISIONS\.md$/, // ADR-001 to ADR-056 are history; ADR-057 names the old names
  /^CHANGELOG\.md$/, // past entries are history
  /^tests\/rename-guard\.test\.ts$/,
  /^packages\/payload-security\/src\/derivation-labels\.test\.ts$/,
  /^scripts\/rename-to-wayscribe\.mjs$/ // the one-off rename script; removed in its own commit
];

/** Lines outside the allowed files that may keep an old name, and why. */
const ALLOWED_LINES: RegExp[] = [
  /"flight-recorder\/(field-encryption|search-token|api-key|content-hash|key-id|web-session)"/, // derivation labels
  /fr_/ // legacy key prefix, checked by the next test instead
];

/** `git grep` exits 1 when nothing matches; that is an empty result, not an error. */
function gitGrep(args: string[]): string {
  try {
    return execFileSync("git", ["grep", ...args, "--", ".", ":!pnpm-lock.yaml"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    }).trim();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return "";
    throw error;
  }
}

const allowedFile = (file: string): boolean => ALLOWED_FILES.some((pattern) => pattern.test(file));

describe("rename to Wayscribe", () => {
  it("leaves no old name outside history and the deliberate exceptions", () => {
    const leftovers = gitGrep(["-n", "-i", "-I", "-E", OLD])
      .split("\n")
      .filter((line) => line !== "")
      .filter((line) => !allowedFile(line.slice(0, line.indexOf(":"))))
      .filter((line) => !ALLOWED_LINES.some((pattern) => pattern.test(line)));
    expect(leftovers).toEqual([]);
  });

  it("mentions the legacy fr_ key prefix only where old keys are still recognised", () => {
    const files = gitGrep(["-l", "-E", LEGACY_PREFIX])
      .split("\n")
      .filter((file) => file !== "")
      .filter((file) => !allowedFile(file));
    expect(files.sort()).toEqual(
      [
        ".gitleaks.toml", // allows fixtures in both key forms
        "docs/SECURITY.md", // the one place the docs name the old key form
        "packages/database/src/doctor.ts", // accepts an fr_ key for --api-key
        "packages/database/src/doctor.test.ts",
        "packages/payload-security/src/api-key.ts", // says why fr_ keys still verify
        "packages/payload-security/src/api-key.test.ts", // proves they do
        "packages/payload-security/src/mask-text.ts", // masks fr_ keys in error text
        "packages/payload-security/src/mask-text.test.ts",
        "scripts/upgrade-test.mjs" // the baseline build issues fr_ keys
      ].sort()
    );
  });
});
