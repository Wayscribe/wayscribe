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
 * A search's `q` is usually a customer identifier, and the Journeys page's
 * filters name services and environments and carry text a reader half
 * remembers, so values never reach the log. Names stay,
 * because "a search with a cursor" is what an operator reading the log needs.
 * The path stays whole: it carries route parameters such as a journey id,
 * which the API's own warnings already log.
 */
export function urlForLog(url: string): string {
  const path = pathOf(url);
  let rest = url.slice(path.length);

  // Matrix parameters (`;jsessionid=…`) are hidden whole: some clients and
  // proxies put session ids and tokens there, and no route uses them.
  let matrix = "";
  if (rest.startsWith(";")) {
    const query = rest.indexOf("?");
    matrix = `;${REDACTED}`;
    rest = query === -1 ? "" : rest.slice(query);
  }

  const query = rest.slice(1);
  if (query === "") return `${path}${matrix}`;

  const parameters = query.split("&").map((pair) => {
    if (pair === "") return "";
    const name = pair.split("=", 1)[0] ?? "";
    return PARAMETER_NAME.test(name) ? `${name}=${REDACTED}` : REDACTED;
  });
  return `${path}${matrix}?${parameters.join("&")}`;
}

/** The path alone: everything before the first `?` or `;`. */
export function pathOf(url: string): string {
  const end = url.search(/[?;]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Properties an error may carry that hold request bytes rather than a
 * description of the failure.
 *
 * `rawPacket` is set by Node's HTTP parser on a request it cannot parse: the
 * bytes as received, which include every header (a bearer API key among them)
 * and the query string. Fastify's default client-error handler logs that error
 * at trace.
 */
const REQUEST_BYTES = new Set(["rawPacket"]);

/**
 * Properties a PostgreSQL error (node-postgres's `DatabaseError`) fills with
 * row contents, logged as REDACTED when present.
 *
 * `detail` prints the failing row of a constraint violation ("Failing row
 * contains (...)") and the key of a unique violation ("Key (...)=(...)"), so a
 * masked alias being written, or a label, would reach the log. `where` and
 * `internalQuery` can quote a statement run inside a function, values
 * included. The rest, `code`, `constraint`, `table`, `column`, `schema`,
 * `routine`, name the failure without its data and stay.
 */
const ROW_CONTENTS = new Set(["detail", "where", "internalQuery"]);

/** How deep a chain of `cause`s is followed. */
const MAX_CAUSE_DEPTH = 5;

// A type alias rather than an interface, so it satisfies the index signature
// in Fastify's serializer type.
export type LoggedError = {
  type: string;
  message: string;
  stack: string;
  [property: string]: unknown;
};

/**
 * Replaces pino's standard `err` serialiser, which copies every enumerable
 * property of the error, `rawPacket` included.
 *
 * Same shape otherwise: type, message, stack, the error's own properties such
 * as `code` and `statusCode`, and its cause, except that a database error's
 * fields that carry row contents are redacted.
 */
export function serializeError(error: Error): LoggedError {
  return describeError(error, 0);
}

function describeError(error: Error, depth: number): LoggedError {
  const logged: LoggedError = {
    type: error.constructor.name,
    message: error.message,
    stack: error.stack ?? ""
  };
  for (const [property, value] of Object.entries(error)) {
    if (REQUEST_BYTES.has(property) || property in logged) continue;
    logged[property] = ROW_CONTENTS.has(property) && value != null ? REDACTED : value;
  }
  if (error.cause instanceof Error && depth < MAX_CAUSE_DEPTH) {
    logged["cause"] = describeError(error.cause, depth + 1);
  }
  return logged;
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
