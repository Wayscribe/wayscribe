import type { IssuedKey } from "./repositories/key-admin.js";

/**
 * `key:create`'s arguments and its two output forms.
 *
 * The human form prints the key once under a banner, with its prefix on a line
 * of its own. A script capturing it had to parse prose by position, and a
 * change to the banner would have broken it silently, so `--json` prints one
 * object on one line and nothing else (F-016).
 */

export const KEY_CREATE_USAGE =
  "Usage: key:create <project-slug> <environment> [name] [--json]\n" +
  "       --json prints one JSON object with the key, its prefix, the project " +
  "and the environment, and nothing else.";

export type KeyCreateArgs =
  | { ok: true; projectSlug: string; environmentName: string; name: string; json: boolean }
  | { ok: false; message: string };

/**
 * The positional arguments and `--json`, which may appear anywhere.
 *
 * An unknown flag is refused rather than folded into the name: a mistyped
 * `--jsonl` would otherwise issue a key named `--jsonl` and print it in the
 * form the caller did not ask for.
 */
export function parseKeyCreateArgs(args: readonly string[]): KeyCreateArgs {
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--json");

  const unknownFlag = rest.find((arg) => arg.startsWith("--"));
  if (unknownFlag !== undefined) {
    return { ok: false, message: `Unknown argument: ${unknownFlag}\n${KEY_CREATE_USAGE}` };
  }

  const [projectSlug, environmentName, ...nameParts] = rest;
  if (projectSlug === undefined || environmentName === undefined) {
    return { ok: false, message: KEY_CREATE_USAGE };
  }

  const name = nameParts.join(" ");
  return {
    ok: true,
    projectSlug,
    environmentName,
    name: name === "" ? `${environmentName}-key` : name,
    json
  };
}

/** The lines `key:create` prints for a key it issued, in the form asked for. */
export function formatIssuedKey(issued: IssuedKey, json: boolean): string[] {
  if (json) {
    // One line, one object, no id: the id names a row nothing outside the
    // database has any use for, and printing it would only widen what a
    // capturing script holds.
    return [
      JSON.stringify({
        apiKey: issued.apiKey,
        keyPrefix: issued.keyPrefix,
        projectSlug: issued.projectSlug,
        environmentName: issued.environmentName
      })
    ];
  }
  return [
    `Key issued for ${issued.projectSlug}/${issued.environmentName}.`,
    "",
    "  API key (shown once, not recoverable):",
    `    ${issued.apiKey}`,
    "",
    `  prefix: ${issued.keyPrefix}`
  ];
}
