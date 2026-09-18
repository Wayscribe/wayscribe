import { readFileSync } from "node:fs";
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
 * No message ever holds a value. The path is named, because that is what the
 * operator has to fix and it is not itself a secret.
 */
export function resolveSecretFiles(
  source: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
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

    let contents: string;
    try {
      contents = readFile(path);
    } catch (error) {
      const reason = (error as { code?: unknown }).code;
      problems.push(
        `${fileVariable} names a file that could not be read${typeof reason === "string" ? ` (${reason})` : ""}: ${path}`
      );
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
