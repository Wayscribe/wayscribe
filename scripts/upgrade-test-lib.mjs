// The parts of scripts/upgrade-test.mjs that decide something, without Docker
// or git, so tests/upgrade-test-lib.test.ts can check them in `pnpm test`.

/** A release tag: vMAJOR.MINOR.PATCH and nothing after it. */
export const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Release tags from a list of tag names, newest version first.
 *
 * Pre-releases (`v1.0.0-rc.1`) and every other tag (`phase-6-complete`,
 * `usable-v0`) are dropped: an upgrade test from a release candidate tells an
 * operator nothing about the release they actually run. Sorted numerically here
 * rather than by git's `version:refname`, whose placement of suffixed tags
 * depends on `versionsort.suffix`.
 *
 * @param {readonly string[]} tags
 * @returns {string[]}
 */
export function releaseTags(tags) {
  return tags
    .map((tag) => ({ tag, match: RELEASE_TAG.exec(tag) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => {
      for (let i = 1; i <= 3; i += 1) {
        const difference = Number(b.match[i]) - Number(a.match[i]);
        if (difference !== 0) return difference;
      }
      return 0;
    })
    .map((entry) => entry.tag);
}

/** The value a redacted header carries. Matches REDACTED in payload-security. */
export const REDACTED = "[REDACTED]";

/**
 * Every field the baseline returned must be present and equal in the current
 * response. Fields the current build added are allowed; arrays must match
 * element for element, because a lost alias or event is exactly the failure.
 *
 * `headerMaps` names the paths that hold a recorded map of HTTP header names to
 * values, such as a replay run's `requestHeaders`. There the names must match
 * exactly, and a value may have become `[REDACTED]`: a release that stops
 * storing header values (migration 015 on the replay-header-storage branch
 * rewrites every stored replay run header to `[REDACTED]`) keeps what the record
 * is for, which headers were sent, while the value was a credential that should
 * never have been stored. Everywhere else a value that became `[REDACTED]` is a
 * mismatch like any other, because losing data is exactly what this test finds.
 *
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} path
 * @param {string[]} mismatches
 * @param {ReadonlySet<string>} [headerMaps]
 */
export function containedIn(expected, actual, path, mismatches, headerMaps = new Set()) {
  if (headerMaps.has(path)) {
    compareHeaderMap(expected, actual, path, mismatches);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      mismatches.push(`${path}: expected an array, got ${JSON.stringify(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      mismatches.push(
        `${path}: expected ${String(expected.length)} items, got ${String(actual.length)}`
      );
    }
    expected.forEach((item, index) => {
      containedIn(item, actual[index], `${path}[${String(index)}]`, mismatches, headerMaps);
    });
    return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      mismatches.push(`${path}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) {
        mismatches.push(`${path}.${key}: missing (baseline had ${JSON.stringify(value)})`);
        continue;
      }
      containedIn(value, actual[key], `${path}.${key}`, mismatches, headerMaps);
    }
    return;
  }
  if (expected !== actual) {
    mismatches.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function compareHeaderMap(expected, actual, path, mismatches) {
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isMap(expected) || !isMap(actual)) {
    mismatches.push(
      `${path}: expected a header map, got ${JSON.stringify(actual)} for ${JSON.stringify(expected)}`
    );
    return;
  }
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    mismatches.push(
      `${path}: header names ${JSON.stringify(actualNames)}, expected ${JSON.stringify(expectedNames)}`
    );
    return;
  }
  for (const name of expectedNames) {
    if (actual[name] !== expected[name] && actual[name] !== REDACTED) {
      mismatches.push(
        `${path}.${name}: expected ${JSON.stringify(expected[name])} or ${REDACTED}, got ${JSON.stringify(actual[name])}`
      );
    }
  }
}

/**
 * Whether a `doctor` run passed as the upgrade test requires: exit 0, every
 * check it printed PASS (a WARN or SKIP is not a pass here, because a freshly
 * upgraded installation under test has nothing to warn about), and every
 * required check present, so a check that silently stopped running is caught.
 *
 * Reads formatDoctor's layout: the status in four columns, two spaces, then the
 * check name padded to 23 columns, then the detail.
 *
 * @param {number} exitCode
 * @param {string} stdout
 * @param {readonly string[]} required
 * @returns {{ ok: boolean, checks: number, problems: string[] }}
 */
export function doctorVerdict(exitCode, stdout, required) {
  const statuses = new Map();
  for (const line of stdout.split("\n")) {
    const status = line.slice(0, 4);
    if (["PASS", "WARN", "FAIL", "SKIP"].includes(status) && line.slice(4, 6) === "  ") {
      statuses.set(line.slice(6, 29).trim(), status);
    }
  }
  const problems = [];
  if (exitCode !== 0) problems.push(`doctor exited ${String(exitCode)}`);
  for (const [name, status] of statuses) {
    if (status !== "PASS") problems.push(`${name}: ${status}`);
  }
  for (const name of required) {
    if (!statuses.has(name)) problems.push(`${name}: not reported`);
  }
  return { ok: problems.length === 0, checks: statuses.size, problems };
}
