import { z } from "zod";

const schema = z.object({
  ADMIN_TOKEN: z.string().min(32),
  API_URL: z.url(),
  // How many reverse proxies in front of the web app append to X-Forwarded-For.
  // 0 keys the login limiter on the socket and ignores the header, which any
  // client can set. Blank counts as unset, as Compose passes an unset variable.
  TRUSTED_PROXY_COUNT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(0).max(10).default(0)
  )
});

export type WebConfig = z.infer<typeof schema>;

/**
 * Fail at boot with the offending variable named, mirroring packages/config.
 *
 * A web app that starts without ADMIN_TOKEN would render a login page that can
 * never succeed — a failure that looks like a forgotten password rather than a
 * misconfiguration.
 */
export function loadWebConfig(source: Record<string, string | undefined>): WebConfig {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid web configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export const webConfig = (): WebConfig => loadWebConfig(process.env);
