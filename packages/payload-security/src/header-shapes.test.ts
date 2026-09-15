import { request } from "node:http";
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
