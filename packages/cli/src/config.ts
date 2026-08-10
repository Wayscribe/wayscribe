/**
 * Where to talk to, and as whom.
 *
 * Flags beat environment variables, because a flag is what somebody reaches for
 * when the environment is already set to something else and they want one
 * different answer.
 */
export interface CliConfig {
  url: string;
  token: string;
  /** Sent as `x-flight-project-id`. An admin token spans projects and must name one. */
  projectId?: string | undefined;
  json: boolean;
}

export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

export interface ConfigInput {
  url?: string | undefined;
  token?: string | undefined;
  project?: string | undefined;
  json?: boolean | undefined;
}

const DEFAULT_URL = "http://localhost:8080";

export function resolveConfig(
  flags: ConfigInput,
  env: Record<string, string | undefined>
): CliConfig {
  const token = flags.token ?? env["FLIGHT_RECORDER_TOKEN"];
  if (token === undefined || token === "") {
    throw new ConfigError(
      "No token. Set FLIGHT_RECORDER_TOKEN to your ADMIN_TOKEN, or pass --token.\n" +
        "It is the same value the web interface asks for."
    );
  }

  const url = flags.url ?? env["FLIGHT_RECORDER_URL"] ?? DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`"${url}" is not a URL. Expected something like ${DEFAULT_URL}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`"${url}" is not an http(s) URL.`);
  }

  return {
    // Trailing slashes make every joined path wrong in a way that is tedious to
    // spot in a 404.
    url: parsed.origin + parsed.pathname.replace(/\/+$/, ""),
    token,
    projectId: flags.project ?? env["FLIGHT_RECORDER_PROJECT"],
    json: flags.json ?? false
  };
}
