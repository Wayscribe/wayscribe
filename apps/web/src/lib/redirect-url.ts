import type { NextRequest } from "next/server";

/**
 * Build an absolute redirect target from the host the client actually asked for.
 *
 * `new URL(path, request.url)` looks like the obvious way to do this and is
 * wrong here. Next's standalone server binds to `HOSTNAME`, which is `0.0.0.0`
 * in a container, and `request.url` reports that bind address rather than the
 * `Host` header — so every redirect sent a browser to `http://0.0.0.0:3000`.
 *
 * Nothing caught it for a while because the tests asserted on the 303 rather
 * than following it, and a developer clicking through in one browser tab does
 * not notice a Location header they never read.
 *
 * `x-forwarded-host` and `x-forwarded-proto` are honoured so the same code
 * works behind a reverse proxy, which is how this is meant to be exposed.
 */
export function redirectTarget(request: NextRequest, path: string): URL {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");

  if (host === null || host === "") {
    // No Host header at all: fall back rather than throw. A redirect to a
    // relative-looking URL is better than a 500 on a login attempt.
    return new URL(path, request.url);
  }

  const proto =
    request.headers.get("x-forwarded-proto") ??
    (request.url.startsWith("https:") ? "https" : "http");

  const base = new URL(`${proto}://${host}`);
  const target = new URL(path, base);
  // Every caller passes a path on this application. One that resolves to
  // another host (`//evil.test`, `/\evil.test`, an absolute URL) is a caller
  // handing through unchecked input, and becomes the home page rather than an
  // open redirect.
  return target.origin === base.origin ? target : new URL("/", base);
}
