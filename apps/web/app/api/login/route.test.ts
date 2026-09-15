import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { socketAddressStorage } from "../../../src/lib/socket-address";
import { POST } from "./route";

const ADMIN_TOKEN = ["admin-token", "for-tests", "00000000000000"].join("-");
const WRONG = ["admin-token", "for-tests", "99999999999999"].join("-");

function loginRequest(token: string, forwardedFor?: string): NextRequest {
  return new NextRequest("http://0.0.0.0:3000/api/login", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      "content-type": "application/x-www-form-urlencoded",
      ...(forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor })
    },
    body: new URLSearchParams({ token }).toString()
  });
}

/** A login as the server receives it: from a socket, with whatever header the client chose. */
const login = (socket: string, token: string, forwardedFor?: string): Promise<Response> =>
  socketAddressStorage().run(socket, () => POST(loginRequest(token, forwardedFor)));

const outcome = (response: Response): string | null =>
  new URL(response.headers.get("location") ?? "http://x/").searchParams.get("error");

/**
 * The limiter is module state, shared by every test in this file, so each test
 * uses addresses of its own.
 */
describe("POST /api/login throttling", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
    vi.stubEnv("API_URL", "http://api:8080");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keys on the socket, so a new X-Forwarded-For per guess buys nothing", async () => {
    // The limiter was keyed on X-Forwarded-For, which the client writes: a
    // guesser sending a different value each time was never throttled.
    for (let i = 0; i < 5; i += 1) {
      const response = await login("203.0.113.50", WRONG, `198.51.100.${String(i)}`);
      expect(outcome(response)).toBe("invalid");
    }
    const locked = await login("203.0.113.50", ADMIN_TOKEN, "198.51.100.77");
    expect(outcome(locked)).toBe("throttled");

    // Another socket is not locked out with it.
    const other = await login("203.0.113.51", ADMIN_TOKEN, "198.51.100.0");
    expect(response303(other)).toBe("http://localhost:3000/");
  });

  it("honours X-Forwarded-For that many hops from the right with TRUSTED_PROXY_COUNT", async () => {
    vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
    const proxy = "10.0.0.9";
    for (let i = 0; i < 5; i += 1) {
      await login(proxy, WRONG, `spoofed-${String(i)}, 198.51.100.60`);
    }
    expect(outcome(await login(proxy, ADMIN_TOKEN, "whatever, 198.51.100.60"))).toBe("throttled");
    // A neighbour behind the same proxy signs in.
    expect(response303(await login(proxy, ADMIN_TOKEN, "198.51.100.61"))).toBe(
      "http://localhost:3000/"
    );
  });
});

function response303(response: Response): string | null {
  expect(response.status).toBe(303);
  return response.headers.get("location");
}
