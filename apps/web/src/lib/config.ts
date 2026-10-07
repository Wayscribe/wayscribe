import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { OPERATOR_SESSION_LABEL, READER_SESSION_LABEL, type WebPrincipal } from "./session";

/** The most a `*_FILE` setting may hold, as in packages/config. */
const MAX_SECRET_FILE_BYTES = 65_536;

/** The tokens this app may read from a file named by `<NAME>_FILE`. */
const TOKEN_SETTINGS = ["ADMIN_TOKEN", "READ_TOKEN"] as const;
type TokenSetting = (typeof TOKEN_SETTINGS)[number];

const blankAsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// Trimmed, exactly as packages/config trims them for the API. The two must
// agree byte for byte: the API compares the value against the Authorization
// header and this app derives its session signing key from it, so a token
// file with a leading space or a byte-order mark would otherwise leave a token
// nobody can type at the login form, with nothing said about why. Blank is
// unset: Compose passes an unset variable as "", and the demo overlay clears
// ADMIN_TOKEN that way.
const token = z.preprocess(blankAsUnset, z.string().trim().min(32).optional());

const schema = z
  .object({
    ADMIN_TOKEN: token,
    // The reader principal's token (ADR-070). Required in anonymous read-only
    // mode, where it is the only token this app holds.
    READ_TOKEN: token,
    // Every visitor is signed in as a reader, with no login page (ADR-069).
    // Exactly "true", as `wayscribe doctor` reads it.
    WEB_ANONYMOUS_READ_ONLY: z
      .preprocess(blankAsUnset, z.enum(["true", "false"]).default("false"))
      .transform((value) => value === "true"),
    // http or https only. `z.url()` alone takes any scheme, so `api:8080`, the
    // host and port without one, was read as a URL with the scheme `api:`; the
    // app started, passed its health check, and could reach nothing.
    API_URL: z.url({
      protocol: /^https?$/i,
      error: "must be an http:// or https:// URL, such as http://api:8080"
    }),
    // How many reverse proxies in front of the web app append to X-Forwarded-For.
    // 0 keys the login limiter on the socket and ignores the header, which any
    // client can set. Blank counts as unset, as Compose passes an unset variable.
    TRUSTED_PROXY_COUNT: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(0).max(10).default(0)
    )
  })
  .superRefine((env, context) => {
    if (env.WEB_ANONYMOUS_READ_ONLY) {
      if (env.READ_TOKEN === undefined) {
        context.addIssue({
          code: "custom",
          path: ["READ_TOKEN"],
          message:
            "is required when WEB_ANONYMOUS_READ_ONLY is true. The web app signs every visitor in as a reader with it."
        });
      }
      if (env.ADMIN_TOKEN !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_TOKEN"],
          message:
            "must not be set when WEB_ANONYMOUS_READ_ONLY is true. A web app that serves the public holds the read token only."
        });
      }
      return;
    }
    if (env.ADMIN_TOKEN === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ADMIN_TOKEN"],
        message: "is required. The login form compares against it and sessions are signed with it."
      });
    }
  });

export type WebConfig = z.infer<typeof schema>;

/**
 * Fail at boot with the offending variable named, mirroring packages/config.
 * `startup.ts` calls this once when the server starts and exits on the error.
 *
 * A web app that starts without its token would render a login page that can
 * never succeed, a failure that looks like a forgotten password rather than a
 * misconfiguration.
 */
export function loadWebConfig(source: Record<string, string | undefined>): WebConfig {
  const result = schema.safeParse(withTokensFromFiles(source));
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
 * The token this app sends to the API: the read token in anonymous read-only
 * mode, the admin token otherwise. Server-side only; it never reaches the
 * browser (ADR-029, ADR-070).
 */
export function apiToken(config: WebConfig): string {
  const value = config.WEB_ANONYMOUS_READ_ONLY ? config.READ_TOKEN : config.ADMIN_TOKEN;
  // loadWebConfig refuses a configuration without the token its mode needs.
  if (value === undefined) {
    throw new Error(`Invalid web configuration: ${apiTokenName(config)} is not set.`);
  }
  return value;
}

/** The name of the setting `apiToken` read, for messages. */
export function apiTokenName(config: WebConfig): TokenSetting {
  return config.WEB_ANONYMOUS_READ_ONLY ? "READ_TOKEN" : "ADMIN_TOKEN";
}

/** Whether every visitor is signed in as a reader. Exact, as the schema reads it. */
export function anonymousReadOnly(
  source: Record<string, string | undefined> = process.env
): boolean {
  return source["WEB_ANONYMOUS_READ_ONLY"] === "true";
}

/** What signs and verifies this app's session cookies, and whom they sign in. */
export interface SessionSigner {
  secret: string;
  label: string;
  principal: WebPrincipal;
}

/**
 * The session signer for this app's mode, or `null` when it has no token to
 * sign with. The two modes use different secrets and different HKDF labels, so
 * a session from one never verifies in the other, even if somebody set the two
 * tokens to the same value.
 */
export function sessionSigner(
  source: Record<string, string | undefined> = process.env
): SessionSigner | null {
  if (anonymousReadOnly(source)) {
    const secret = sessionToken(source, "READ_TOKEN");
    return secret === null ? null : { secret, label: READER_SESSION_LABEL, principal: "reader" };
  }
  const secret = sessionAdminToken(source);
  return secret === null ? null : { secret, label: OPERATOR_SESSION_LABEL, principal: "admin" };
}

/**
 * The admin token a session is verified against, or `null` when this app has
 * none to verify against.
 *
 * `null` rather than `""` because a caller must not verify against an empty
 * key. `signSession` derives its key from whatever string it is given, so an
 * empty token verifies a cookie anyone can sign with an empty token, and the
 * gate would admit it: a misconfiguration would become a way in rather than a
 * way out.
 */
export function sessionAdminToken(
  source: Record<string, string | undefined> = process.env
): string | null {
  return sessionToken(source, "ADMIN_TOKEN");
}

function sessionToken(
  source: Record<string, string | undefined>,
  name: TokenSetting
): string | null {
  let value: string | undefined;
  try {
    value = withTokenFromFile(source, name)[name];
  } catch {
    // A misconfigured file leaves no token. This app refuses to start on the
    // mistake (`startup.ts`), so it is only reached when the file changes
    // under a running server.
    return null;
  }
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function withTokensFromFiles(
  source: Record<string, string | undefined>
): Record<string, string | undefined> {
  return TOKEN_SETTINGS.reduce((resolved, name) => withTokenFromFile(resolved, name), source);
}

/**
 * A token read from the file `<NAME>_FILE` names.
 *
 * The rules are `packages/config`'s `resolveSecretFiles`, restated here because
 * this app deliberately depends on no workspace package. Whitespace at the end
 * goes; an empty file is refused; giving both the variable and the file is
 * refused; a path that is not a regular file is refused before it is opened,
 * since reading a named pipe would hang this process. No message holds the value.
 */
function withTokenFromFile(
  source: Record<string, string | undefined>,
  name: TokenSetting
): Record<string, string | undefined> {
  const fileVariable = `${name}_FILE`;
  const path = source[fileVariable]?.trim() ?? "";
  if (path === "") return source;
  if ((source[name]?.trim() ?? "") !== "") {
    throw new Error(
      `Invalid web configuration:\n  ${name} and ${fileVariable} are both set. ` +
        "Set one: nothing on a running container would say which value had won."
    );
  }

  const unreadable = (error: unknown): Error => {
    const code = (error as { code?: unknown }).code;
    return new Error(
      `Invalid web configuration:\n  ${fileVariable} names a file that could not be read${
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
      `Invalid web configuration:\n  ${fileVariable} does not name a regular file: ${path}`
    );
  }
  if (stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(
      `Invalid web configuration:\n  ${fileVariable} names a file of ${String(stats.size)} bytes, ` +
        `more than the ${String(MAX_SECRET_FILE_BYTES)} a setting may be read from: ${path}`
    );
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw unreadable(error);
  }

  const value = contents.trimEnd();
  if (value === "") {
    throw new Error(
      `Invalid web configuration:\n  ${fileVariable} names a file with nothing in it: ${path}`
    );
  }
  return { ...source, [name]: value, [fileVariable]: undefined };
}
