/**
 * The checks `reset` makes before it touches anything.
 *
 * `reset` rolls every migration back, which drops every table and every
 * recorded journey in the database DATABASE_URL names, and then migrates and
 * seeds. Nothing about DATABASE_URL says whether that database is a laptop's
 * or a production one, and this CLI has no other notion of a development
 * context, so the command does nothing unless the operator says `--yes`.
 *
 * It also refuses outright under NODE_ENV=production, with or without the
 * flag. The published API image sets that, and it carries this CLI as
 * `packages/database/dist/cli.js` for provisioning a real installation, which
 * is the one place a reset is never wanted. A laptop leaves NODE_ENV unset, so
 * that check alone could not tell a local database from a production one
 * reached from a laptop; the flag is what does.
 */

import { commandUsage, everyFlagRead, flag, parseCommandArgs } from "./cli-commands.js";

export const RESET_USAGE = commandUsage("reset");

export type ResetArgs = { ok: true } | { ok: false; message: string };

/**
 * Whether `reset` may run with these arguments in this environment, and if
 * not, why, in words that name the database it would have wiped.
 */
export function parseResetArgs(
  args: readonly string[],
  env: Record<string, string | undefined>,
  databaseUrl: string
): ResetArgs {
  const YES = flag("reset", "--yes");
  const parsed = parseCommandArgs("reset", args);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const { yes, ...unread } = parsed.values;
  everyFlagRead(unread);
  if (env["NODE_ENV"] === "production") {
    return {
      ok: false,
      message:
        "reset refuses to run with NODE_ENV=production. It drops every table and " +
        "every recorded journey, and is for a local development database only."
    };
  }
  if (yes !== true) {
    return {
      ok: false,
      message:
        `reset drops every table and every recorded journey in the database on ${describeTarget(databaseUrl)}, ` +
        "then migrates and seeds it again. Nothing was changed.\n" +
        `If that is the local development database you mean, run it again with ${YES}: pnpm db:reset ${YES}`
    };
  }
  return { ok: true };
}

/**
 * Host and port from DATABASE_URL, so the refusal says which server it
 * protected.
 *
 * Never the user, password or database name: on the bundled stack the
 * database is called `wayscribe`, the same word as its password, which is why
 * `doctor` does not print it either.
 */
export function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    // An `@` the parser did not read as the end of the credentials means it
    // read them as something else: in `postgresql://owner:1234/5@db/x` an
    // unescaped `/` in the password makes `owner:1234` the host and port.
    const afterScheme = databaseUrl.slice(databaseUrl.indexOf("://") + 3);
    const credentialsMisread =
      afterScheme.includes("@") && url.username === "" && url.password === "";
    return url.host === "" || credentialsMisread ? "the configured host" : url.host;
  } catch {
    return "the configured host";
  }
}
