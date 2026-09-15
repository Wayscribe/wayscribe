import { NextResponse, type NextRequest } from "next/server";

/**
 * Refuse a state-changing request that a browser sent from another origin.
 *
 * The session cookie is `SameSite=strict`, which stops another *site* from
 * sending it. It does not stop another *origin on the same site*: a sibling
 * subdomain, or another port on localhost, is same-site, so a form there that
 * posts here arrives with the operator's session, and every handler behind this
 * check can delete, replay, or switch project.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be set by page script, so
 * when it is present it decides: `same-origin`, or `none` for a navigation the
 * user started, is allowed and anything else is refused. Without it, an older
 * browser, `Origin` is compared with the host the client asked for, honouring
 * `x-forwarded-host`, as a proxy that rewrites `Host` sets. The host alone is compared, not
 * the scheme, so a proxy that terminates TLS without setting
 * `x-forwarded-proto` does not refuse every form.
 *
 * A request with neither header is allowed. Browsers send at least one on a
 * cross-origin POST, and a client that sends neither is not a browser, so it has
 * no ambient session cookie to abuse.
 *
 * Returns the refusal to send, or null to carry on.
 */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return fetchSite === "same-origin" || fetchSite === "none" ? null : refusal();
  }

  const origin = request.headers.get("origin");
  if (origin === null) return null;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host === null || host === "") return refusal();

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // Includes `Origin: null`, which a browser sends from sandboxed and
    // privacy-sensitive contexts: nothing to compare, so nothing to trust.
    return refusal();
  }
  return originHost === host ? null : refusal();
}

function refusal(): NextResponse {
  // A page, not JSON: every caller is a plain HTML form, and a browser would
  // otherwise show a raw error object.
  return new NextResponse(
    '<!doctype html><meta charset="utf-8"><title>Refused</title>' +
      "<p>This request came from another site, so Flight Recorder refused it.</p>",
    {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    }
  );
}
