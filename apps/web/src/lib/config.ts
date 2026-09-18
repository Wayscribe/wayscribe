import { readFileSync } from "node:fs";
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
  const result = schema.safeParse(withTokenFromFile(source));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid web configuration:\n${issues}`);
  }
  return Object.freeze(result.data);
}

export const webConfig = (): WebConfig => loadWebConfig(process.env);

/**
 * The admin token a session is verified against, or "" when there is none.
 *
 * The auth gate and the project picker verify a cookie before anything has
 * loaded the whole configuration, and an unset token has always left them
 * redirecting to the login page rather than throwing a server error onto it.
 * This keeps that, and reads `ADMIN_TOKEN_FILE` the way everything else does:
 * without it, a stack configured with the file would verify every session
 * against "" and redirect forever.
 */
export function sessionAdminToken(
  source: Record<string, string | undefined> = process.env
): string {
  try {
    return withTokenFromFile(source)["ADMIN_TOKEN"] ?? "";
  } catch {
    // A misconfigured file leaves no token, which is the unset case above. The
    // API refuses to start on the same mistake, and `loadWebConfig` names it
    // wherever this app loads its configuration in full.
    return "";
  }
}

/**
 * `ADMIN_TOKEN` read from the file `ADMIN_TOKEN_FILE` names.
 *
 * The rules are `packages/config`'s `resolveSecretFiles`, restated here for the
 * same reason the loader above is: this app deliberately depends on no
 * workspace package, so its runtime image carries nothing but Next's traced
 * bundle. They have to agree: the web app and the API must hold the same token
 * byte for byte, since the web app derives its session signing key from it.
 *
 * Whitespace at the end goes, an empty file is refused rather than read as an
 * unset setting, and giving both the variable and the file is refused rather
 * than silently preferring one. No message holds the value.
 */
function withTokenFromFile(
  source: Record<string, string | undefined>
): Record<string, string | undefined> {
  const path = source["ADMIN_TOKEN_FILE"]?.trim() ?? "";
  if (path === "") return source;
  if ((source["ADMIN_TOKEN"]?.trim() ?? "") !== "") {
    throw new Error(
      "Invalid web configuration:\n  ADMIN_TOKEN and ADMIN_TOKEN_FILE are both set. " +
        "Set one: nothing on a running container would say which value had won."
    );
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(
      `Invalid web configuration:\n  ADMIN_TOKEN_FILE names a file that could not be read${
        typeof code === "string" ? ` (${code})` : ""
      }: ${path}`
    );
  }

  const token = contents.trimEnd();
  if (token === "") {
    throw new Error(
      `Invalid web configuration:\n  ADMIN_TOKEN_FILE names a file with nothing in it: ${path}`
    );
  }
  return { ...source, ADMIN_TOKEN: token, ADMIN_TOKEN_FILE: undefined };
}
