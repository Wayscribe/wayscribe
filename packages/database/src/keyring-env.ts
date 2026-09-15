import { loadEncryptionKeys } from "@flight-recorder/config";
import { createKeyring, type Keyring } from "@flight-recorder/payload-security";

/**
 * The keyring for a process that reads its keys straight from the environment.
 *
 * The CLI and the demo bootstrap issue verifiers too, so they read
 * `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` through the API's own
 * configuration schema: the same trimming, the same blank-means-unset rule, and
 * the same refusal of one key set twice.
 */
export function keyringFromEnvironment(env: Record<string, string | undefined>): Keyring {
  const keys = loadEncryptionKeys(env);
  return createKeyring(keys.ENCRYPTION_KEY, keys.ENCRYPTION_KEY_PREVIOUS);
}
