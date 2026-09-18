import { readFileSync, statSync } from "node:fs";
import { z } from "zod";

/** The most ADMIN_TOKEN_FILE may hold, as in packages/config. */
const MAX_SECRET_FILE_BYTES = 65_536;

const schema = z.object({
  // Trimmed, exactly as packages/config trims it for the API. The two must
  // agree byte for byte: the API compares this value against the Authorization
  // header and this app derives its session signing key from it, so a token
  // file with a leading space or a byte-order mark would otherwise leave a
  // token nobody can type at the login form, with nothing said about why.
  ADMIN_TOKEN: z.string().trim().min(32),
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
 * The admin token a session is verified against, or `null` when this app has
 * none to verify against.
 *
 * The auth gate and the project picker verify a cookie before anything has
 * loaded the whole configuration, so they need the token without the throw
 * `loadWebConfig` would put on the page. `null` is the answer for every way of
 * not having one: unset, blank, a `ADMIN_TOKEN_FILE` that cannot be read, an
 * empty file, or the setting given both ways.
 *
 * It is `null` rather than `""` because a caller must not verify against an
 * empty key. `signSession` derives its key from whatever string it is given, so
 * an empty token verifies a cookie anyone can sign with an empty token, and the
 * gate would admit it: a misconfiguration would become a way in rather than a
 * way out. Both callers redirect to the login page on `null` without verifying
 * anything, which is what an unset token has always done.
 */
export function sessionAdminToken(
  source: Record<string, string | undefined> = process.env
): string | null {
  let token: string | undefined;
  try {
    token = withTokenFromFile(source)["ADMIN_TOKEN"];
  } catch {
    // A misconfigured file leaves no token. The API refuses to start on the
    // same mistake, and `loadWebConfig` names it wherever this app loads its
    // configuration in full, which every data path does.
    return null;
  }
  // Trimmed the way the schema above trims it, so the token this verifies a
  // cookie against is the token the login route signed it with.
  const trimmed = token?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
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
 * unset setting, giving both the variable and the file is refused rather than
 * silently preferring one, and a path that is not a regular file is refused
 * before it is opened, since reading a named pipe would hang this process
 * before it had said anything. No message holds the value.
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

  const unreadable = (error: unknown): Error => {
    const code = (error as { code?: unknown }).code;
    return new Error(
      `Invalid web configuration:\n  ADMIN_TOKEN_FILE names a file that could not be read${
        typeof code === "string" ? ` (${code})` : ""
      }: ${path}`
    );
  };

  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw unreadable(error);
  }
  if (!stats.isFile()) {
    throw new Error(
      `Invalid web configuration:\n  ADMIN_TOKEN_FILE does not name a regular file: ${path}`
    );
  }
  if (stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(
      `Invalid web configuration:\n  ADMIN_TOKEN_FILE names a file of ${String(stats.size)} bytes, ` +
        `more than the ${String(MAX_SECRET_FILE_BYTES)} a setting may be read from: ${path}`
    );
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw unreadable(error);
  }

  const token = contents.trimEnd();
  if (token === "") {
    throw new Error(
      `Invalid web configuration:\n  ADMIN_TOKEN_FILE names a file with nothing in it: ${path}`
    );
  }
  return { ...source, ADMIN_TOKEN: token, ADMIN_TOKEN_FILE: undefined };
}
