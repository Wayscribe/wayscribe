import { commandUsage, parseCommandArgs, type FlagsRead } from "./cli-commands.js";
import type { IssuedKey } from "./repositories/key-admin.js";

/**
 * `key:create`'s arguments and its two output forms.
 *
 * The human form prints the key once under a banner, with its prefix on a line
 * of its own. A script capturing it had to parse prose by position, and a
 * change to the banner would have broken it silently, so `--json` prints one
 * object on one line and nothing else (F-016).
 */

/** From the command registry, which `key:create --help` also reads, with the JSON fields. */
export const KEY_CREATE_USAGE = commandUsage("key:create");

export type KeyCreateArgs =
  | { ok: true; projectSlug: string; environmentName: string; name: string; json: boolean }
  | { ok: false; message: string };

/**
 * The positional arguments and `--json`, which may appear anywhere before a
 * `--`.
 *
 * Anything else that begins with a dash is refused rather than folded into
 * the name: a mistyped `--jsonl` or `-j` would otherwise issue a key named
 * after it and print it in the form the caller did not ask for. A name that
 * really begins with a dash goes after `--`, where every argument is a value.
 */
export function parseKeyCreateArgs(args: readonly string[]): KeyCreateArgs {
  const parsed = parseCommandArgs("key:create", args);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const read = { json: parsed.values.json === true } satisfies FlagsRead<"key:create">;

  const [projectSlug, environmentName, ...nameParts] = parsed.positionals;
  if (projectSlug === undefined || environmentName === undefined) {
    return { ok: false, message: KEY_CREATE_USAGE };
  }

  const name = nameParts.join(" ");
  return {
    ok: true,
    projectSlug,
    environmentName,
    name: name === "" ? `${environmentName}-key` : name,
    json: read.json
  };
}

/** The lines `key:create` prints for a key it issued, in the form asked for. */
export function formatIssuedKey(issued: IssuedKey, json: boolean): string[] {
  if (json) {
    // One line, one object, no id: the id names a row nothing outside the
    // database has any use for, and printing it would only widen what a
    // capturing script holds. `key:create --help` names these four fields,
    // and a test fails if it stops naming one of them.
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
