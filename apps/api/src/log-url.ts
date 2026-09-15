/** What a hidden query value, or a name that may be a value, is logged as. */
export const REDACTED = "[REDACTED]";

/**
 * A parameter name as the API's routes spell them. Anything else, such as an
 * email address pasted without `=` or a very long token, is treated as data.
 */
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * A request URL fit for the log: the path, and each query parameter's name
 * with its value replaced.
 *
 * A search's `q` is usually a customer identifier and the Recent page's filters
 * name services and environments, so values never reach the log. Names stay,
 * because "a search with a cursor" is what an operator reading the log needs.
 * The path stays whole: it carries route parameters such as a journey id,
 * which the API's own warnings already log.
 */
export function urlForLog(url: string): string {
  const at = url.indexOf("?");
  if (at === -1) return url;

  const query = url.slice(at + 1);
  if (query === "") return url.slice(0, at);

  const parameters = query.split("&").map((pair) => {
    if (pair === "") return "";
    const name = pair.split("=", 1)[0] ?? "";
    return PARAMETER_NAME.test(name) ? `${name}=${REDACTED}` : REDACTED;
  });
  return `${url.slice(0, at)}?${parameters.join("&")}`;
}

/** The request fields Fastify's default serialiser logs, with the URL made safe. */
// A type alias rather than an interface, so it satisfies the index signature
// in Fastify's serializer type.
export type LoggedRequest = {
  method?: string;
  url?: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
};

/**
 * Replaces Fastify's default `req` serialiser, which logged `req.url` whole.
 *
 * Same fields otherwise, and still no headers: the redact paths configured
 * beside it are for log calls that build their own objects.
 */
export function serializeRequest(raw: object): LoggedRequest {
  // Typed by Fastify as the raw Node request, and called with Fastify's own
  // request object, which adds `host` and `ip`. Read field by field.
  const request = raw as {
    method?: unknown;
    url?: unknown;
    host?: unknown;
    ip?: unknown;
    socket?: { remotePort?: unknown } | null;
  };
  const logged: LoggedRequest = {};
  if (typeof request.method === "string") logged.method = request.method;
  if (typeof request.url === "string") logged.url = urlForLog(request.url);
  if (typeof request.host === "string") logged.host = request.host;
  if (typeof request.ip === "string") logged.remoteAddress = request.ip;
  if (typeof request.socket?.remotePort === "number") logged.remotePort = request.socket.remotePort;
  return logged;
}
