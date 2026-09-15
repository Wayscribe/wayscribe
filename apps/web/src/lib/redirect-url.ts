import { NextResponse } from "next/server";

const CHECK_ORIGIN = "https://redirect-check.invalid";

/**
 * A 303 See Other to a path on this application, with a path-only Location.
 *
 * Every redirect the route handlers send goes back to this application, so the
 * Location names no scheme and no host, and the browser resolves it against
 * the origin it is actually on. Two absolute versions came before this, and
 * both were wrong behind something:
 *
 * - `new URL(path, request.url)` used Next's bind address, `0.0.0.0` in a
 *   container, so every redirect sent a browser to `http://0.0.0.0:3000`.
 * - Building the origin from `Host` and `X-Forwarded-Proto` sent `http://`
 *   behind a TLS-terminating proxy that forwards `Host` alone, as a bare nginx
 *   `proxy_pass` does. The browser followed a downgrade, and a form post's
 *   redirect to another scheme is blocked outright by `form-action 'self'`,
 *   so sign-in, choosing a project, replay and delete all stopped working.
 *
 * `NextResponse.redirect` insists on an absolute URL, so the response is built
 * here. The path is resolved against a throwaway origin and must stay on it,
 * and a pathname that begins with two separators is refused, because a
 * Location of `//evil.test` is another host. Anything else becomes `/`. The
 * fragment is dropped; the query and the encoded path are kept as they are.
 */
export function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: localPath(path) } });
}

function localPath(path: string): string {
  if (!path.startsWith("/")) return "/";
  let resolved: URL;
  try {
    resolved = new URL(path, CHECK_ORIGIN);
  } catch {
    return "/";
  }
  if (resolved.origin !== CHECK_ORIGIN || /^[/\\]{2}/.test(resolved.pathname)) return "/";
  const local = `${resolved.pathname}${resolved.search}`;
  return new URL(local, CHECK_ORIGIN).origin === CHECK_ORIGIN ? local : "/";
}
