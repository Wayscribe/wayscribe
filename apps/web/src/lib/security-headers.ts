/**
 * Response headers that hold on every route, set in `next.config.ts`.
 *
 * The Content-Security-Policy is not among them: it carries a per-response
 * nonce, so `middleware.ts` sets it.
 */
export const STATIC_SECURITY_HEADERS = [
  // Belt and braces with `frame-ancestors 'none'`, for browsers that predate it.
  { key: "X-Frame-Options", value: "DENY" },
  // A journey URL names a journey id and a search URL the searched identifier;
  // neither belongs in a Referer sent to a link's destination.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" }
];

/**
 * The Content-Security-Policy for one response.
 *
 * Scripts are allowed from this origin and, inline, by nonce. The production
 * build does inline scripts: App Router streams the React Server Components
 * payload as `<script>self.__next_f.push(...)</script>` in every page, and
 * bootstraps with inline scripts too, so `script-src 'self'` alone blocks
 * hydration. `'unsafe-inline'` would allow them and every script an injection
 * could add, so the nonce is used instead: Next reads it from this policy on
 * the request (the middleware forwards it) and puts it on each script it
 * renders. That needs every page rendered per request, which they are; the one
 * page Next would otherwise prerender, not-found, is made dynamic.
 *
 * Styles are `'self'` only. The app's CSS is a stylesheet and it uses no
 * `style` attributes; Next's default not-found page did, and is replaced.
 *
 * Development adds `'unsafe-eval'`, which React's development build uses to
 * reconstruct server stacks. It is never sent by a production build.
 */
export function contentSecurityPolicy(nonce: string, development: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ");
}
