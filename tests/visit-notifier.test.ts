import { describe, expect, it, vi } from "vitest";
import {
  browserFamily,
  clientKey,
  closeWindowIfOver,
  createState,
  handleRecord,
  newYorkTime,
  osFamily,
  parseCaddyLine,
  routeShape,
  sendToNtfy,
  type AccessRecord,
  type Message
} from "../deploy/demo/visit-notifier/notifier.ts";

const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const T0 = Date.parse("2026-10-07T14:00:00.000Z"); // 10:00 AM in New York (EDT)
const MINUTE = 60_000;

/** A line as Caddy's JSON access log writes it. */
function caddyLine(overrides: {
  ts?: number;
  ip?: string;
  ua?: string;
  uri?: string;
  method?: string;
  status?: number;
  referer?: string;
}): string {
  const headers: Record<string, string[]> = { "User-Agent": [overrides.ua ?? SAFARI] };
  if (overrides.referer !== undefined) headers["Referer"] = [overrides.referer];
  return JSON.stringify({
    level: "info",
    ts: (overrides.ts ?? T0) / 1000,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "172.18.0.1",
      client_ip: overrides.ip ?? "203.0.113.7",
      proto: "HTTP/2.0",
      method: overrides.method ?? "GET",
      host: "demo.wayscribe.dev",
      uri: overrides.uri ?? "/",
      headers
    },
    status: overrides.status ?? 200
  });
}

const record = (overrides: Parameters<typeof caddyLine>[0]): AccessRecord => {
  const parsed = parseCaddyLine(caddyLine(overrides));
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
};

let saltCount = 0;
const newSalt = (): string => `salt-${String(++saltCount)}`;
const handle = (
  state: ReturnType<typeof createState>,
  input: AccessRecord,
  now = input.at
): Message[] => handleRecord(state, input, { now, ownHost: "demo.wayscribe.dev", newSalt });

describe("parseCaddyLine", () => {
  it("reads the client address, agent, path without its query, status and referrer", () => {
    expect(
      parseCaddyLine(
        caddyLine({
          uri: "/?q=%2B1%20555%200100",
          referer: "https://news.ycombinator.com/item?id=1"
        })
      )
    ).toEqual({
      at: T0,
      clientIp: "203.0.113.7",
      userAgent: SAFARI,
      method: "GET",
      path: "/",
      status: 200,
      referer: "https://news.ycombinator.com/item?id=1"
    });
  });

  it("returns null for a line that is not an access record", () => {
    expect(parseCaddyLine("not json")).toBeNull();
    expect(parseCaddyLine(JSON.stringify({ level: "info", msg: "serving" }))).toBeNull();
  });
});

describe("handleRecord", () => {
  it("notifies a first visit with New York time, landing path, referrer host and browser family", () => {
    const state = createState(T0, newSalt);
    const messages = handle(
      state,
      record({ uri: "/journeys/jrn_x?event=e", referer: "https://news.ycombinator.com/" })
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("10:00 AM ET");
    expect(messages[0]?.body).toContain("/journeys/:id");
    expect(messages[0]?.body).not.toContain("event=e");
    expect(messages[0]?.body).toContain("news.ycombinator.com");
    expect(messages[0]?.body).toContain("Safari on macOS");
  });

  it("never sends a search term", () => {
    const state = createState(T0, newSalt);
    const [message] = handle(state, record({ uri: "/?q=%2B1%20555%200100" }));
    expect(message?.body).not.toContain("555");
    expect(message?.body).not.toContain("q=");
  });

  it("says direct when there is no referrer or it is the demo itself", () => {
    const state = createState(T0, newSalt);
    expect(handle(state, record({}))[0]?.body).toContain("direct");
    expect(
      handle(state, record({ ip: "198.51.100.2", referer: "https://demo.wayscribe.dev/" }))[0]?.body
    ).toContain("direct");
  });

  it("does not notify a repeat from the same client within six hours, and does after", () => {
    const state = createState(T0, newSalt);
    expect(handle(state, record({}))).toHaveLength(1);
    expect(handle(state, record({ ts: T0 + 5 * 60 * MINUTE }))).toHaveLength(0);
    expect(handle(state, record({ ts: T0 + 11 * 60 * MINUTE + 1 }))).toHaveLength(1);
  });

  it("ignores assets, API and health requests, non-GET, errors, the smoke check and bots", () => {
    const state = createState(T0, newSalt);
    for (const ignored of [
      record({ uri: "/_next/static/chunks/app.js" }),
      record({ uri: "/favicon.ico" }),
      record({ uri: "/robots.txt" }),
      record({ uri: "/health" }),
      record({ uri: "/api/events/evt_1" }),
      record({ method: "POST", uri: "/api/select-project" }),
      record({ status: 404, uri: "/nope" }),
      record({ ua: "wayscribe-smoke/1" }),
      record({ ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }),
      record({ ua: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" }),
      record({ ua: "" })
    ]) {
      expect(handle(state, ignored), ignored.path + " " + ignored.userAgent).toEqual([]);
    }
  });

  it("sends ten in an hour, then one mute notice on the eleventh, then a summary when the hour ends", () => {
    const state = createState(T0, newSalt);
    const sent: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      for (const message of handle(
        state,
        record({ ip: `203.0.113.${String(i + 10)}`, ts: T0 + i * MINUTE })
      )) {
        sent.push(message.title);
      }
    }
    expect(sent.filter((title) => title === "Demo visit")).toHaveLength(10);
    expect(sent.filter((title) => title === "Demo visits muted")).toHaveLength(1);
    expect(sent).toHaveLength(11);

    expect(closeWindowIfOver(state, T0 + 59 * MINUTE)).toEqual([]);
    const summary = closeWindowIfOver(state, T0 + 60 * MINUTE);
    expect(summary).toEqual([{ title: "Demo visits", body: "4 more visits in the last hour." }]);
    // A new hour starts clean.
    expect(handle(state, record({ ip: "192.0.2.1", ts: T0 + 61 * MINUTE }))).toHaveLength(1);
  });

  it("names the minute the mute ends in New York time", () => {
    const state = createState(T0, newSalt);
    let notice = "";
    for (let i = 0; i < 11; i += 1) {
      for (const message of handle(state, record({ ip: `203.0.113.${String(i + 10)}` }))) {
        if (message.title === "Demo visits muted") notice = message.body;
      }
    }
    expect(notice).toContain(`Muted until ${newYorkTime(T0 + 60 * MINUTE)}`);
    expect(newYorkTime(T0 + 60 * MINUTE)).toBe("11:00 AM ET");
  });

  it("rotates its salt daily and holds no raw address", () => {
    const state = createState(T0, newSalt);
    handle(state, record({}));
    const firstSalt = state.salt;
    expect(JSON.stringify([...state.seen.keys()])).not.toContain("203.0.113.7");
    handle(state, record({ ip: "198.51.100.9", ts: T0 + 24 * 60 * MINUTE }));
    expect(state.salt).not.toBe(firstSalt);
  });
});

describe("family names", () => {
  it("reads browser and OS families", () => {
    expect(browserFamily(SAFARI)).toBe("Safari");
    expect(osFamily(SAFARI)).toBe("macOS");
    expect(browserFamily(CHROME_WINDOWS)).toBe("Chrome");
    expect(osFamily(CHROME_WINDOWS)).toBe("Windows");
  });
});

describe("sendToNtfy", () => {
  it("logs and drops a message when ntfy is unreachable, and never throws", async () => {
    const log = vi.fn();
    const failing = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    await expect(
      sendToNtfy(
        { title: "Demo visit", body: "x" },
        { url: "https://ntfy.sh", topic: "t", fetch: failing, log }
      )
    ).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("message dropped"));
  });

  it("logs and drops when ntfy answers an error", async () => {
    const log = vi.fn();
    const refusing = vi.fn(() => Promise.resolve(new Response("no", { status: 500 })));
    await expect(
      sendToNtfy(
        { title: "Demo visit", body: "x" },
        { url: "https://ntfy.sh/", topic: "t", fetch: refusing, log }
      )
    ).resolves.toBe(false);
    expect(refusing).toHaveBeenCalledWith(
      "https://ntfy.sh/t",
      expect.objectContaining({ method: "POST" })
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("500"));
  });
});

describe("review hardening", () => {
  const HOUR = 60 * MINUTE;

  it("ignores redirects and informational statuses, counts only 2xx", () => {
    const state = createState(T0, newSalt);
    for (const status of [100, 101, 301, 308, 399]) {
      expect(handle(state, record({ status, ip: `10.0.0.${String(status % 200)}` }))).toEqual([]);
    }
    expect(handle(state, record({ status: 204, ip: "10.9.9.9" }))).toHaveLength(1);
  });

  it("reduces any path to a known route shape", () => {
    const state = createState(T0, newSalt);
    const [long] = handle(state, record({ uri: `/URGENT-call-555-0199-${"A".repeat(10_000)}/` }));
    expect(long?.body.length).toBeLessThan(200);
    expect(long?.body).toContain("other page");
    expect(long?.body).not.toContain("URGENT");
    for (const [path, shape] of [
      ["/", "/"],
      ["/journeys", "/journeys"],
      ["/journeys/jrn_abc", "/journeys/:id"],
      ["/recent", "/recent"],
      ["/projects", "/projects"],
      ["/login", "/login"],
      ["/journeys/a/b/c", "other page"],
      ["/call-me", "other page"]
    ] as const) {
      expect(routeShape(path)).toBe(shape);
    }
  });

  it("never leaks addresses, agent text, queries or referrer paths", () => {
    const state = createState(T0, newSalt);
    const agents = [
      SAFARI,
      CHROME_WINDOWS,
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0 SECRETAGENTTOKEN"
    ];
    const paths = [
      "/",
      "/journeys?x=1#frag",
      "/journeys/jrn_1?secret=1",
      "/weird/path?a=b",
      "/recent#h"
    ];
    const referers = [
      undefined,
      "https://example.org/private/path?token=abc",
      "https://news.ycombinator.com/item?id=9#c"
    ];
    let count = 0;
    for (let i = 0; i < 60; i += 1) {
      const ip = `198.51.${String(i)}.${String(i + 1)}`;
      const ua = agents[i % agents.length] ?? SAFARI;
      const messages = handle(
        state,
        record({
          ip,
          ua,
          uri: paths[i % paths.length],
          referer: referers[i % referers.length],
          ts: T0 + i * 1000
        })
      );
      for (const message of messages) {
        count += 1;
        const text = `${message.title}\n${message.body}`;
        expect(text).not.toContain(ip);
        expect(text).not.toContain("SECRETAGENTTOKEN");
        expect(text).not.toContain("Mozilla");
        expect(text).not.toContain("AppleWebKit");
        expect(text).not.toContain("?");
        expect(text).not.toContain("#");
        expect(text).not.toContain("/private");
        expect(text).not.toContain("token");
        expect(text).not.toContain("/item");
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it("changes the client key with the salt, the address and the agent", () => {
    expect(clientKey("a", "1.1.1.1", SAFARI)).not.toBe(clientKey("b", "1.1.1.1", SAFARI));
    expect(clientKey("a", "1.1.1.1", SAFARI)).not.toBe(clientKey("a", "1.1.1.2", SAFARI));
    expect(clientKey("a", "1.1.1.1", SAFARI)).not.toBe(clientKey("a", "1.1.1.1", CHROME_WINDOWS));
  });

  it("counts the same address with a different agent as a new visit", () => {
    const state = createState(T0, newSalt);
    expect(handle(state, record({}))).toHaveLength(1);
    expect(handle(state, record({ ua: CHROME_WINDOWS }))).toHaveLength(1);
  });

  it("pins the dedupe at six hours exactly", () => {
    const state = createState(T0, newSalt);
    handle(state, record({}));
    expect(handle(state, record({ ts: T0 + 6 * HOUR - 1 }))).toHaveLength(0);
    const fresh = createState(T0, newSalt);
    handle(fresh, record({}));
    expect(handle(fresh, record({ ts: T0 + 6 * HOUR }))).toHaveLength(1);
  });

  it("slides the dedupe window: a visit every five hours is notified once", () => {
    // Early in the UTC day so the daily salt rotation does not interfere.
    const base = Date.parse("2026-10-07T00:30:00.000Z");
    const state = createState(base, newSalt);
    expect(handle(state, record({ ts: base }))).toHaveLength(1);
    expect(handle(state, record({ ts: base + 5 * HOUR }))).toHaveLength(0);
    expect(handle(state, record({ ts: base + 10 * HOUR }))).toHaveLength(0);
  });

  it("ignores each kind of tool and robot agent", () => {
    const state = createState(T0, newSalt);
    for (const ua of [
      "curl/8.4.0",
      "Wget/1.21",
      "python-requests/2.31",
      "Go-http-client/2.0",
      "okhttp/4.12",
      "axios/1.6",
      "node-fetch/1.0",
      "libwww-perl/6.6",
      "Scrapy/2.11",
      "Java/17.0.1",
      "Mozilla/5.0 (compatible; MyBot/1.0)",
      "Mozilla/5.0 (compatible; Crawler)",
      "Mozilla/5.0 Spider",
      "Yahoo! Slurp",
      "facebookexternalhit/1.1",
      "Embedly/0.2",
      "LinkPreview/1.0",
      "HeadlessChrome/129",
      "Chrome-Lighthouse"
    ]) {
      expect(handle(state, record({ ua })), ua).toEqual([]);
    }
  });

  it("clears the remembered clients past the limit", () => {
    const state = createState(T0, newSalt);
    const options = { ownHost: "demo.wayscribe.dev", newSalt, maxRemembered: 3 };
    for (let i = 0; i < 4; i += 1) {
      handleRecord(state, record({ ip: `192.0.2.${String(i + 1)}`, ts: T0 + i }), {
        ...options,
        now: T0 + i
      });
    }
    expect(state.seen.size).toBe(4);
    handleRecord(state, record({ ip: "192.0.2.99", ts: T0 + 10 }), { ...options, now: T0 + 10 });
    expect(state.seen.size).toBe(1);
  });

  it("forgets every remembered client when the salt rotates", () => {
    const state = createState(T0, newSalt);
    handle(state, record({}));
    handle(state, record({ ip: "198.51.100.9" }));
    expect(state.seen.size).toBe(2);
    handle(state, record({ ip: "192.0.2.5", ts: T0 + 24 * HOUR }));
    expect(state.seen.size).toBe(1);
  });

  it("gives up on a hanging fetch within the timeout", async () => {
    const log = vi.fn();
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "TimeoutError"));
          });
        })
    );
    const started = Date.now();
    await expect(
      sendToNtfy(
        { title: "t", body: "b" },
        { url: "https://ntfy.sh", topic: "t", fetch: hanging, log, timeoutMs: 50 }
      )
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("encodes the topic in the ntfy URL", async () => {
    const ok = vi.fn(() => Promise.resolve(new Response("ok", { status: 200 })));
    await sendToNtfy(
      { title: "t", body: "b" },
      { url: "https://ntfy.sh", topic: "a b/c", fetch: ok, log: vi.fn() }
    );
    expect(ok).toHaveBeenCalledWith("https://ntfy.sh/a%20b%2Fc", expect.anything());
  });
});
