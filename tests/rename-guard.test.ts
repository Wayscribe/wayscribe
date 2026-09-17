import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { root } from "./docs-helpers.js";

/**
 * The product was renamed from Flight Recorder to Wayscribe (ADR-057). Any old
 * name outside the history and the deliberate exceptions below is a leftover.
 *
 * The scan reads files itself rather than using `git grep`: `git grep -I`
 * skips any file holding a NUL byte, and some TypeScript tests do, and a line
 * search cannot see a name split across a line break.
 */

// Word edges spelled out rather than `\b`, as the patterns were first written
// for `git grep`, whose POSIX ERE on Apple's git has no `\b`.
const START = "(^|[^A-Za-z0-9_])";
const END = "([^A-Za-z0-9_]|$)";
const LEGACY_PREFIX = new RegExp(`${START}fr_`, "g");
const OLD = new RegExp(
  [
    "flight.?recorder",
    "x-flight",
    "flightJourney",
    "flightEntity",
    `${START}_flight${END}`,
    `${START}fr_`,
    "FLIGHT_",
    "flight_session",
    String.raw`flight\.example`
  ].join("|"),
  "i"
);
const SPLIT_NAME = /flight\s+recorder/gi;

const ALLOWED_FILES = [
  /^docs\/superpowers\/(specs|plans)\//,
  /^docs\/reviews\//,
  /^docs\/claims-audit-2026-09-16\.md$/,
  /^packages\/database\/migrations\//,
  /^docs\/DECISIONS\.md$/, // ADR-001 to ADR-056 are history; ADR-057 names the old names
  /^CHANGELOG\.md$/, // past entries are history
  /^tests\/rename-guard\.test\.ts$/,
  /^packages\/payload-security\/src\/derivation-labels\.test\.ts$/,
  /^scripts\/rename-to-wayscribe\.mjs$/, // the one-off rename script; removed in its own commit
  /^pnpm-lock\.yaml$/
];

/** Single lines outside the allowed files that must keep an old name, and why. */
const ALLOWED_LINES: { file: string; line: RegExp }[] = [
  // Removes a local stack started before the rename, under its old project name.
  {
    file: "docs/LOCAL_DEVELOPMENT.md",
    line: /^docker compose -p flight-recorder -f infrastructure\/compose\.yaml down -v$/
  }
];

/** Files that are not text at all. Anything else is read, NUL bytes or not. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz)$/i;

/** HKDF labels that must keep the old name, since they determine derived keys. */
const DERIVATION_LABEL =
  /"flight-recorder\/(field-encryption|search-token|api-key|content-hash|key-id|web-session)"/g;

interface Scanned {
  file: string;
  text: string;
}

function scannedFiles(): Scanned[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "")
    .filter((file) => !ALLOWED_FILES.some((pattern) => pattern.test(file)))
    .filter((file) => !BINARY.test(file))
    .map((file) => ({ file, text: readFileSync(`${root}${file}`, "latin1") }));
}

const files = scannedFiles();

/**
 * An old name on a line, once the two deliberate exceptions are taken out: the
 * derivation labels, and the legacy `fr_` token (checked by its own test), so
 * that `FLIGHT_X=fr_...` is still caught by its other half.
 */
function hasOldName(line: string): boolean {
  const stripped = line.replace(DERIVATION_LABEL, "").replace(LEGACY_PREFIX, "$1");
  return OLD.test(stripped);
}

describe("rename to Wayscribe", () => {
  it("scans every tracked text file, including ones holding NUL bytes", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(({ text }) => text.includes("\0"))).toBe(true);
  });

  it("leaves no old name outside history and the deliberate exceptions", () => {
    const leftovers = files.flatMap(({ file, text }) =>
      text
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => hasOldName(line))
        .filter(
          ({ line }) =>
            !ALLOWED_LINES.some((allowed) => allowed.file === file && allowed.line.test(line))
        )
        .map(({ line, number }) => `${file}:${String(number)}:${line}`)
    );
    expect(leftovers).toEqual([]);
  });

  it("leaves no old name split across a line break", () => {
    const leftovers = files.flatMap(({ file, text }) => {
      const unlabelled = text.replace(DERIVATION_LABEL, "");
      return [...unlabelled.matchAll(SPLIT_NAME)].map((match) => {
        const number = unlabelled.slice(0, match.index).split("\n").length;
        return `${file}:${String(number)}:${match[0].replace(/\s+/g, " ")}`;
      });
    });
    expect(leftovers).toEqual([]);
  });

  it("mentions the legacy fr_ key prefix only where old keys are still recognised", () => {
    const mentioning = files
      .filter(({ text }) => new RegExp(LEGACY_PREFIX.source, "m").test(text))
      .map(({ file }) => file);
    expect(mentioning.sort()).toEqual(
      [
        ".gitleaks.toml", // allows fixtures in both key forms
        "docs/SECURITY.md", // the one place the docs name the old key form
        "packages/config/src/insecure-defaults.ts", // the demo key published before the rename
        "packages/config/src/insecure-defaults.test.ts",
        "packages/database/src/doctor.ts", // accepts an fr_ key for --api-key
        "packages/database/src/doctor.test.ts",
        "packages/database/src/doctor.integration.test.ts", // warns on the old demo key
        "packages/payload-security/src/api-key.ts", // says why fr_ keys still verify
        "packages/payload-security/src/api-key.test.ts", // proves they do
        "packages/payload-security/src/mask-text.ts", // masks fr_ keys in error text
        "packages/payload-security/src/mask-text.test.ts",
        "scripts/upgrade-test.mjs" // the baseline build issues fr_ keys
      ].sort()
    );
  });
});
