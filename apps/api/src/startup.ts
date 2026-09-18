import {
  findInsecureDefaults,
  loadServerEnv,
  type InsecureDefault,
  type ServerEnv
} from "@wayscribe/config";
import { createKeyring, type Keyring } from "@wayscribe/payload-security";

export type Startup =
  | { ok: true; env: ServerEnv; keyring: Keyring; insecureDefaults: InsecureDefault[] }
  | { ok: false; message: string };

/**
 * Read the environment and build the keyring, or say why the API cannot start.
 *
 * Both used to throw from the top of server.ts, so a mistake an operator makes
 * by hand, such as pasting the same key into ENCRYPTION_KEY and
 * ENCRYPTION_KEY_PREVIOUS, surfaced as an uncaught exception and a stack trace.
 * The message is the reason alone, naming the variable to change.
 *
 * `insecureDefaults` is found in the values the API will actually run on, not
 * in the raw environment. A setting read from the file its `_FILE` names is not
 * in `process.env` at all, so looking there would have started a stack on a
 * published development default in silence, which is the one thing the boot
 * warning exists to prevent.
 */
export function prepareStartup(source: Record<string, string | undefined>): Startup {
  try {
    const env = loadServerEnv(source);
    // During a rotation the previous key is held beside the current one so data
    // written under it stays readable. A previous key equal to the current one
    // is refused here rather than starting a rotation that rotates nothing.
    const keyring = createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    return { ok: true, env, keyring, insecureDefaults: insecureDefaultsIn(env) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Every line one level deeper, so a configuration error's per-variable
    // lines stay nested under its own header.
    const indented = reason
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    return { ok: false, message: `Wayscribe API cannot start:\n${indented}` };
  }
}

/**
 * The published development defaults among the values the API is running on.
 *
 * Only the three secrets `findInsecureDefaults` knows are handed to it, as
 * strings, so the values a `_FILE` setting brought in are checked exactly as a
 * variable's would be.
 */
export function insecureDefaultsIn(env: ServerEnv): InsecureDefault[] {
  return findInsecureDefaults({
    ENCRYPTION_KEY: env.ENCRYPTION_KEY,
    ENCRYPTION_KEY_PREVIOUS: env.ENCRYPTION_KEY_PREVIOUS,
    ADMIN_TOKEN: env.ADMIN_TOKEN
  });
}
