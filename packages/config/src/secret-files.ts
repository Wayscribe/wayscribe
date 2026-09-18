import { readFileSync, statSync } from "node:fs";
import { ConfigError } from "./config-error.js";

/**
 * Settings that may be read from a file instead of the environment.
 *
 * With the Compose install paths these are ordinary container environment
 * variables, so anything that can run `docker inspect` on the host can read the
 * key that decrypts every stored payload and the token that signs every admin
 * session (F-023, docs/SECURITY.md §5). Helm installs already avoid that with
 * `existingSecret`; `NAME_FILE` is the equivalent for a file mounted into the
 * container, which is what Docker's own `secrets:` mechanism provides.
 *
 * `ENCRYPTION_KEY_PREVIOUS` is here too, so a rotation does not have to put the
 * outgoing key back into the environment the incoming one has just left.
 */
export const SECRET_FILE_SETTINGS = [
  "ENCRYPTION_KEY",
  "ENCRYPTION_KEY_PREVIOUS",
  "ADMIN_TOKEN"
] as const;

/**
 * The most a setting may be read from.
 *
 * Every setting this reads is a key or a token of well under a hundred bytes.
 * The cap is generous enough that no real secrets file meets it and small
 * enough that a path naming something else is refused rather than read.
 */
export const MAX_SECRET_FILE_BYTES = 65_536;

/** A file system error's code in parentheses, for a message that names a path. */
const code = (error: unknown): string => {
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? ` (${value})` : "";
};

/** Blank counts as unset: Compose passes an unset variable through as "". */
const set = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

/**
 * The environment with every `NAME_FILE` setting replaced by the file's
 * contents, or {@link ConfigError} naming every setting that is wrong.
 *
 * Whitespace at the end of the file is removed, because a secrets file and
 * `kubectl create secret --from-file` both commonly end in a newline and a
 * kept newline changes the key. An empty file is refused rather than read as an
 * unset setting, which would start the API on a published default instead.
 * Giving both `NAME` and `NAME_FILE` is refused rather than silently preferring
 * one, since the two could differ and nothing on a running container would say
 * which had won.
 *
 * The path has to name a regular file of at most {@link MAX_SECRET_FILE_BYTES}.
 * Anything else is refused before it is opened: a `_FILE` pointing at a named
 * pipe, a socket or a character device would otherwise block `readFileSync`
 * forever, and the process would hang before it had logged anything at all,
 * which is harder to diagnose than any message. The size cap is the same idea
 * for a path that happens to name something enormous.
 *
 * No message ever holds a value. The path is named, because that is what the
 * operator has to fix and it is not itself a secret.
 */
export function resolveSecretFiles(
  source: Record<string, string | undefined>
): Record<string, string | undefined> {
  const resolved = { ...source };
  const problems: string[] = [];

  for (const name of SECRET_FILE_SETTINGS) {
    const fileVariable = `${name}_FILE`;
    const path = set(source[fileVariable]);
    if (path === undefined) continue;

    if (set(source[name]) !== undefined) {
      problems.push(
        `${name} and ${fileVariable} are both set. Set one: nothing on a running container would say which value had won.`
      );
      continue;
    }

    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      problems.push(`${fileVariable} names a file that could not be read${code(error)}: ${path}`);
      continue;
    }
    if (!stats.isFile()) {
      // Checked before the open, not after: reading a named pipe or a device
      // blocks until something writes, and a process hung there has said
      // nothing about why.
      problems.push(`${fileVariable} does not name a regular file: ${path}`);
      continue;
    }
    if (stats.size > MAX_SECRET_FILE_BYTES) {
      problems.push(
        `${fileVariable} names a file of ${String(stats.size)} bytes, more than the ${String(MAX_SECRET_FILE_BYTES)} a setting may be read from: ${path}`
      );
      continue;
    }

    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      problems.push(`${fileVariable} names a file that could not be read${code(error)}: ${path}`);
      continue;
    }

    // Only the end: whitespace before the value would be as deliberate as the
    // value, and trimming it would hide a secret pasted with a leading space
    // rather than fix it.
    const value = contents.trimEnd();
    if (value === "") {
      problems.push(`${fileVariable} names a file with nothing in it: ${path}`);
      continue;
    }
    resolved[name] = value;
    // The file variable is emptied once it has been read, so resolving an
    // already-resolved environment is not read as the setting being given both
    // ways. Doctor resolves once for its own checks and hands the result to the
    // keyring, which resolves again.
    resolved[fileVariable] = "";
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid environment configuration:\n${problems.map((problem) => `  ${problem}`).join("\n")}`
    );
  }
  return resolved;
}
