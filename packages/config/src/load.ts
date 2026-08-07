import { serverEnvSchema, type ServerEnv } from "./schema.js";

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

/**
 * Parse and validate the server environment.
 *
 * Throws {@link ConfigError} listing every invalid variable rather than stopping
 * at the first, so a misconfigured deployment is fixed in one pass instead of
 * one restart per mistake.
 */
export function loadServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }

  return Object.freeze(result.data);
}
