import { createServer, request } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { REDACTED, redact } from "./redact.js";

// Built by concatenation so a scanner reading this file does not see a
// credential, and so a leak is unmistakable when one of these is found stored.
const BEARER = "Bearer " + "tok" + "_header_shape_" + "TUPLE01";
const RAW_BEARER = "Bearer " + "tok" + "_header_shape_" + "RAW02";
const RAW_COOKIE = "sid=" + "cookie" + "_header_shape_" + "RAW03";
const REQUEST_BEARER = "Bearer " + "tok" + "_header_shape_" + "REQ04";

const builtIn = (value: unknown): unknown => redact(value, DEFAULT_SECRET_PATHS);

/**
 * The security review stored each of these verbatim through SDK, API and
 * PostgreSQL in the default capture mode: the built-in rules matched object key
 * names, and an HTTP client files headers under array positions and inside
 * strings as often as under keys.
 */
describe("headers filed as name-value pairs", () => {
  it("redacts a fetch or undici header tuple", () => {
    const result = builtIn({ init: { headers: [["Authorization", BEARER]] } });
    expect(JSON.stringify(result)).not.toContain("TUPLE01");
    expect(result).toEqual({ init: { headers: [["Authorization", REDACTED]] } });
  });

  it("redacts a tuple under every built-in spelling of the name", () => {
    const result = builtIn([
      ["proxy-authorization", BEARER],
      ["Set-Cookie", "sid=1"],
      ["X_API_KEY", "k-1"],
      ["x-request-id", "req_42"]
    ]);
    expect(result).toEqual([
      ["proxy-authorization", REDACTED],
      ["Set-Cookie", REDACTED],
      ["X_API_KEY", REDACTED],
      ["x-request-id", "req_42"]
    ]);
  });

  it("redacts a tuple named by a configured any-depth rule", () => {
    expect(redact({ fields: [["ssn", "111-22-3333"]] }, ["**.ssn"])).toEqual({
      fields: [["ssn", REDACTED]]
    });
  });

  it("leaves pairs with ordinary names unchanged", () => {
    const pairs = [
      ["color", "red"],
      ["Content-Type", "application/json"],
      ["size", "L"]
    ];
    expect(builtIn({ pairs })).toEqual({ pairs });
  });

  it("does not treat a longer tuple or a non-string name as a pair", () => {
    const rows = [
      ["authorization", "kept", "third"],
      [1, "kept"]
    ];
    expect(builtIn({ rows })).toEqual({ rows });
  });
});

describe("headers filed as interleaved raw headers", () => {
  it("redacts Node's rawHeaders", () => {
    const result = builtIn({
      rawHeaders: ["Authorization", RAW_BEARER, "Cookie", RAW_COOKIE, "Host", "api.example.com"]
    });
    const stored = JSON.stringify(result);
    expect(stored).not.toContain("RAW02");
    expect(stored).not.toContain("RAW03");
    expect(result).toEqual({
      rawHeaders: ["Authorization", REDACTED, "Cookie", REDACTED, "Host", "api.example.com"]
    });
  });

  it("redacts a configured any-depth name once the array reads as headers", () => {
    expect(
      redact({ rawHeaders: ["User-Agent", "curl/8", "X-Tenant-Secret", "t-1"] }, [
        "**.x-tenant-secret"
      ])
    ).toEqual({ rawHeaders: ["User-Agent", "curl/8", "X-Tenant-Secret", REDACTED] });
  });

  it("leaves an ordinary string array unchanged", () => {
    const words = ["apple", "banana", "cherry", "date"];
    expect(builtIn({ words })).toEqual({ words });
  });

  it("does not reinterpret an array whose names include no known header", () => {
    // `password` is a secret name, but nothing else says this list is headers.
    const values = ["password", "hunter2-kept", "username", "dana"];
    expect(builtIn({ values })).toEqual({ values });
  });

  it("does not reinterpret an odd-length array or one with a non-token name", () => {
    const odd = ["Authorization", "kept", "Host"];
    const notTokens = ["Host", "h", "not a header name", "kept", "Cookie", "kept too"];
    const spaced = ["authorization", "kept", "two words", "kept too"];
    expect(builtIn({ odd, notTokens, spaced })).toEqual({ odd, notTokens, spaced });
  });
});

describe("headers filed inside an HTTP header block string", () => {
  it("redacts a secret-named header line and keeps the rest", () => {
    const header = `POST /oauth/token HTTP/1.1\r\nAuthorization: ${REQUEST_BEARER}\r\nHost: 127.0.0.1:1\r\nCookie: ${RAW_COOKIE}\r\nContent-Length: 2\r\n\r\n`;
    const result = builtIn({ _header: header }) as { _header: string };
    expect(result._header).not.toContain("REQ04");
    expect(result._header).not.toContain("RAW03");
    expect(result._header).toBe(
      "POST /oauth/token HTTP/1.1\r\nAuthorization: [REDACTED]\r\nHost: 127.0.0.1:1\r\nCookie: [REDACTED]\r\nContent-Length: 2\r\n\r\n"
    );
  });

  it("is idempotent, as the SDK and the server both apply it", () => {
    const header = `GET / HTTP/1.1\r\nAuthorization: ${REQUEST_BEARER}\r\n\r\n`;
    const once = builtIn(header);
    expect(builtIn(once)).toBe(once);
  });

  it("stops at the end of the header section", () => {
    const chunk = `POST / HTTP/1.1\r\nHost: h\r\n\r\npassword: body-text-kept`;
    expect(builtIn(chunk)).toBe(chunk);
  });

  it("does not mask ordinary strings, even ones naming a secret", () => {
    // ADR-046 rejected masking every payload string by shape.
    const note = "password: hunter2-kept in a note";
    const lines = "first line\nAuthorization: kept, since this is not a header block";
    expect(builtIn({ note, lines })).toEqual({ note, lines });
  });

  it("redacts the header a real http.ClientRequest carries", async () => {
    const captured = await new Promise<unknown>((resolve) => {
      const outgoing = request({
        host: "127.0.0.1",
        port: 1,
        method: "POST",
        path: "/oauth/token",
        headers: { Authorization: REQUEST_BEARER }
      });
      outgoing.on("error", (error) => {
        resolve({ error, request: outgoing });
      });
      outgoing.end("{}");
    });

    const stored = JSON.stringify(builtIn(captured));
    expect(stored).toContain("/oauth/token");
    expect(stored).toContain("Authorization: [REDACTED]");
    expect(stored).not.toContain("REQ04");
  });
});

describe("header recognition scales linearly", () => {
  // Payload strings and arrays are reachable from public HTTP, so the new
  // checks are timed at two sizes as the error-text masker is: linear work
  // takes about four times as long at four times the size.
  const KIB = 1024;
  const NOISE_FLOOR_MS = 10;
  const fill = (unit: string, size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const fastest = (value: unknown): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      builtIn(value);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  const adversarial: Record<string, (size: number) => unknown> = {
    "secret header lines": (size) => "GET / HTTP/1.1\r\n" + fill("Authorization: x\r\n", size),
    "one long header name with no colon": (size) => "\r\n" + fill("a", size),
    "many empty-valued header lines": (size) => fill("Cookie:\r\n", size),
    "an interleaved header list": (size) =>
      Array.from({ length: size / 8 }, (_, index) => (index % 2 === 0 ? "Cookie" : "v")),
    "a list of pairs": (size) => Array.from({ length: size / 16 }, () => ["Cookie", "v"])
  };

  for (const [name, build] of Object.entries(adversarial)) {
    it(`handles ${name} in time proportional to its length`, () => {
      const small = build(16 * KIB);
      const large = build(64 * KIB);
      builtIn(small);
      expect(fastest(large)).toBeLessThan(Math.max(8 * fastest(small), NOISE_FLOOR_MS));
    });
  }
});

// Built by concatenation, as above.
const H2_BEARER = "Bearer " + "tok" + "_header_shape_" + "H2REQ05";
const H2_COOKIE = "sid=" + "cookie" + "_header_shape_" + "H2REQ06";
const H2_SET_COOKIE = "sid=" + "cookie" + "_header_shape_" + "H2RES07";
const H1_BEARER = "Bearer " + "tok" + "_header_shape_" + "H1REQ08";
const H1_SET_COOKIE = "sid=" + "cookie" + "_header_shape_" + "H1RES09";

interface Exchange {
  request: string[];
  response: string[];
}

/**
 * Real HTTP/2 rawHeaders from both ends of one exchange: the server's view of
 * the request and the client's view of the response.
 */
async function http2Exchange(): Promise<Exchange> {
  const server = createHttp2Server();
  let received: string[] = [];
  server.on("request", (incoming, outgoing) => {
    received = incoming.rawHeaders;
    outgoing.setHeader("set-cookie", H2_SET_COOKIE);
    outgoing.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const client = connectHttp2(`http://127.0.0.1:${String(port)}`);
  const response = await new Promise<string[]>((resolve, reject) => {
    const stream = client.request({ ":path": "/", authorization: H2_BEARER, cookie: H2_COOKIE });
    stream.on("response", (_headers, _flags, rawHeaders: string[]) => {
      resolve(rawHeaders);
    });
    stream.on("error", reject);
    stream.resume();
    stream.end();
  });
  client.close();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return { request: received, response };
}

/** The same for HTTP/1.1: IncomingMessage.rawHeaders on the server and on the client. */
async function http1Exchange(): Promise<Exchange> {
  let received: string[] = [];
  const server = createServer((incoming, outgoing) => {
    received = incoming.rawHeaders;
    outgoing.setHeader("set-cookie", H1_SET_COOKIE);
    outgoing.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const response = await new Promise<string[]>((resolve) => {
    const outgoing = request({ host: "127.0.0.1", port, headers: { Authorization: H1_BEARER } });
    outgoing.on("response", (incoming) => {
      incoming.resume();
      resolve(incoming.rawHeaders);
    });
    outgoing.end();
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return { request: received, response };
}

describe("rawHeaders from real HTTP/1.1 and HTTP/2 exchanges", () => {
  it("redacts HTTP/2 request rawHeaders, pseudo-headers and all", async () => {
    const exchange = await http2Exchange();
    // The shape under test, asserted so a Node change cannot make this vacuous.
    expect(exchange.request[0]).toBe(":path");
    const stored = JSON.stringify(builtIn({ rawHeaders: exchange.request }));
    expect(stored).not.toContain("H2REQ05");
    expect(stored).not.toContain("H2REQ06");
    expect(stored).toContain('":method","GET"');
    expect(stored).toContain('"authorization","[REDACTED]"');
  });

  it("redacts HTTP/2 response rawHeaders a client receives", async () => {
    const exchange = await http2Exchange();
    expect(exchange.response[0]).toBe(":status");
    const stored = JSON.stringify(builtIn({ rawHeaders: exchange.response }));
    expect(stored).not.toContain("H2RES07");
    expect(stored).toContain('":status","200"');
    expect(stored).toContain('"set-cookie","[REDACTED]"');
  });

  it("redacts HTTP/1.1 rawHeaders in both directions", async () => {
    const exchange = await http1Exchange();
    const stored = JSON.stringify(builtIn(exchange));
    expect(stored).not.toContain("H1REQ08");
    expect(stored).not.toContain("H1RES09");
    expect(stored).toContain('"Authorization","[REDACTED]"');
  });

  it("does not accept a colon that is not followed by a token as a pseudo-header", () => {
    const bare = [":", "kept", "host", "h", "authorization", "kept too"];
    const spaced = [": path", "kept", "host", "h", "authorization", "kept too"];
    expect(builtIn({ bare, spaced })).toEqual({ bare, spaced });
  });
});

describe("headers filed as name and value objects", () => {
  it("redacts a HAR or Playwright headersArray entry", () => {
    const result = builtIn({
      har: [
        { name: "Authorization", value: BEARER },
        { name: "Accept", value: "application/json" }
      ],
      playwright: [
        { key: "Cookie", value: RAW_COOKIE },
        { key: "x-request-id", value: "req_42" }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("TUPLE01");
    expect(JSON.stringify(result)).not.toContain("RAW03");
    expect(result).toEqual({
      har: [
        { name: "Authorization", value: REDACTED },
        { name: "Accept", value: "application/json" }
      ],
      playwright: [
        { key: "Cookie", value: REDACTED },
        { key: "x-request-id", value: "req_42" }
      ]
    });
  });

  it("uses a configured any-depth name as well", () => {
    expect(redact({ fields: [{ name: "ssn", value: "111-22-3333" }] }, ["**.ssn"])).toEqual({
      fields: [{ name: "ssn", value: REDACTED }]
    });
  });

  it("leaves objects with other names, other keys or extra keys unchanged", () => {
    const rows = [
      { name: "color", value: "red" },
      { label: "authorization", value: "kept" },
      { name: "authorization", value: "kept", comment: "three keys" },
      { name: "authorization", data: "kept" },
      { name: 7, value: "kept" }
    ];
    expect(builtIn({ rows })).toEqual({ rows });
  });
});

describe("values that are themselves header names", () => {
  // A list of header names is configuration, not headers. Read as pairs, the
  // name after `authorization` or `cookie` was replaced, which a diff then
  // showed as a change nobody made.
  it("keeps an allowedHeaders list", () => {
    const allowedHeaders = ["Authorization", "Content-Type"];
    expect(builtIn({ allowedHeaders })).toEqual({ allowedHeaders });
  });

  it("keeps a vary list", () => {
    const vary = ["content-type", "authorization", "cookie", "accept"];
    expect(builtIn({ vary })).toEqual({ vary });
  });

  it("keeps a pair whose value is a header name", () => {
    const exposeHeaders = [
      ["authorization", "x-api-key"],
      ["set-cookie", "Set-Cookie"]
    ];
    expect(builtIn({ exposeHeaders })).toEqual({ exposeHeaders });
  });

  it("still redacts a real value in the same shapes", () => {
    expect(builtIn(["Authorization", BEARER, "Content-Type", "application/json"])).toEqual([
      "Authorization",
      REDACTED,
      "Content-Type",
      "application/json"
    ]);
    expect(builtIn([["cookie", RAW_COOKIE]])).toEqual([["cookie", REDACTED]]);
    expect(builtIn([{ name: "cookie", value: RAW_COOKIE }])).toEqual([
      { name: "cookie", value: REDACTED }
    ]);
  });
});
