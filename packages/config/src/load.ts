import type { z } from "zod";
import { ConfigError } from "./config-error.js";
import { resolveSecretFiles } from "./secret-files.js";
import {
  encryptionKeysSchema,
  serverEnvSchema,
  statementTimeoutSchema,
  type EncryptionKeys,
  type ServerEnv
} from "./schema.js";

export { ConfigError };

/**
 * Parse and validate the server environment.
 *
 * Throws {@link ConfigError} listing every invalid variable rather than stopping
 * at the first, so a misconfigured deployment is fixed in one pass instead of
 * one restart per mistake.
 *
 * `ENCRYPTION_KEY_FILE`, `ENCRYPTION_KEY_PREVIOUS_FILE` and `ADMIN_TOKEN_FILE`
 * are read first, so a setting mounted as a file is validated exactly as one
 * given in the environment (`secret-files.ts`).
 */
export function loadServerEnv(source: Record<string, string | undefined>): ServerEnv {
  return parse(serverEnvSchema, resolveSecretFiles(source));
}

/**
 * Parse only the encryption keys, for processes that need nothing else.
 *
 * The database CLI and the demo bootstrap write verifiers and ciphertext too.
 * Reading the keys through the server's own field schemas means they trim and
 * treat a blank previous key exactly as the API does.
 */
export function loadEncryptionKeys(source: Record<string, string | undefined>): EncryptionKeys {
  return parse(encryptionKeysSchema, resolveSecretFiles(source));
}

/**
 * Parse only DATABASE_STATEMENT_TIMEOUT_MS, for `doctor`, which reports on the
 * API's setting from an environment that may not hold the rest of it.
 */
export function loadStatementTimeoutMs(source: Record<string, string | undefined>): number {
  return parse(statementTimeoutSchema, source).DATABASE_STATEMENT_TIMEOUT_MS;
}

function parse<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>
): Readonly<z.output<T>> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data);
}
