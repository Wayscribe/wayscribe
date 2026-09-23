import { parseArgs } from "node:util";

export type IngestionCommand = "check" | "preview";
export const INGESTION_USAGE = `wayscribe check --url <url> --environment <name> --service <name> [--api-key-env <NAME>] [--json]
wayscribe preview <batch.json> --url <url> [--api-key-env <NAME>] [--json]

Explicit dry-run validation; stores no journey evidence. Key usage bookkeeping may change.
URL/environment/service default only to explicit WAYSCRIBE_URL/WAYSCRIBE_ENVIRONMENT/WAYSCRIBE_SERVICE.
The ingestion key comes from WAYSCRIBE_API_KEY or --api-key-env; never --token or WAYSCRIBE_TOKEN.
Preview uses file environments/services unchanged. Check does not inspect an installed SDK.`;

const options = {
  url: { type: "string" },
  environment: { type: "string" },
  service: { type: "string" },
  "api-key-env": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  token: { type: "string" },
  project: { type: "string" },
  limit: { type: "string" },
  diff: { type: "boolean" }
} as const;

export class IngestionError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}
export const invalidArguments = (): IngestionError =>
  new IngestionError(
    "INVALID_ARGUMENTS",
    "Invalid ingestion arguments. Use check --help or preview --help."
  );

/** Use actual positional boundaries: a read argument or option value can be 'check'. */
export function ingestionCommand(argv: readonly string[]): IngestionCommand | undefined {
  try {
    const parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: false });
    const command = parsed.positionals[0];
    return command === "check" || command === "preview" ? command : undefined;
  } catch {
    return undefined;
  }
}

type ParsedIngestionArgs =
  | { help: true; json: boolean }
  | {
      help: false;
      json: boolean;
      flags: { url?: string; environment?: string; service?: string; "api-key-env"?: string };
      file: string | undefined;
    };

export function parseIngestionArgs(
  command: IngestionCommand,
  args: readonly string[]
): ParsedIngestionArgs {
  try {
    const parsed = parseArgs({ args: [...args], options, allowPositionals: true, tokens: true });
    if (parsed.values.help === true)
      return { help: true as const, json: parsed.values.json === true };
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (
        seen.has(token.name) ||
        ["token", "project", "diff", "limit", "version"].includes(token.name)
      )
        throw invalidArguments();
      if (command === "preview" && ["environment", "service"].includes(token.name))
        throw invalidArguments();
      seen.add(token.name);
    }
    if (
      parsed.positionals[0] !== command ||
      parsed.positionals.length !== (command === "check" ? 1 : 2)
    )
      throw invalidArguments();
    return {
      help: false as const,
      json: parsed.values.json === true,
      flags: parsed.values,
      file: parsed.positionals[1]
    };
  } catch {
    throw invalidArguments();
  }
}

/** URL has already normalized case, IPv4 shorthand and IPv6 brackets. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export interface IngestionConfig {
  url: string;
  apiKey: string;
  environment?: string;
  service?: string;
}
export function resolveIngestionConfig(
  command: IngestionCommand,
  flags: { url?: string; environment?: string; service?: string; "api-key-env"?: string },
  env: Record<string, string | undefined>
): IngestionConfig {
  const name = flags["api-key-env"] ?? "WAYSCRIBE_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ["WAYSCRIBE_TOKEN", "ADMIN_TOKEN"].includes(name))
    throw invalidArguments();
  const rawUrl = flags.url ?? env["WAYSCRIBE_URL"];
  let url: URL;
  try {
    url = new URL(rawUrl ?? "");
  } catch {
    throw new IngestionError("INVALID_CONFIG", "An explicit http(s) ingestion URL is required.");
  }
  // URL normalizes an empty userinfo delimiter away; refuse it before that normalization.
  const authority =
    (rawUrl ?? "")
      .trim()
      .replaceAll("\\", "/")
      .replace(/^[^:]+:\/*/, "")
      .split(/[/?#]/, 1)[0] ?? "";
  if (
    !["http:", "https:"].includes(url.protocol) ||
    authority.includes("@") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[?#]/.test(rawUrl ?? "")
  )
    throw new IngestionError(
      "INVALID_CONFIG",
      "Ingestion URL must be http(s), without credentials, query or fragment."
    );
  // The Bearer key travels in the clear over http; allow that only to this machine.
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname))
    throw new IngestionError(
      "INVALID_CONFIG",
      "Ingestion URL must use https unless the host is loopback (localhost, 127.0.0.0/8, ::1)."
    );
  const apiKey = env[name];
  if (!apiKey || apiKey.length < 8 || !/^[A-Za-z0-9._~+/-]+=*$/.test(apiKey))
    throw new IngestionError(
      "INVALID_CONFIG",
      "A valid ingestion API key environment variable is required."
    );
  const config: IngestionConfig = { url: url.origin + url.pathname.replace(/\/+$/, ""), apiKey };
  if (command === "check") {
    const environment = flags.environment ?? env["WAYSCRIBE_ENVIRONMENT"];
    const service = flags.service ?? env["WAYSCRIBE_SERVICE"];
    if (!environment?.trim() || !service?.trim())
      throw new IngestionError(
        "INVALID_CONFIG",
        "Check requires explicit environment and service settings."
      );
    config.environment = environment;
    config.service = service;
  }
  return config;
}
