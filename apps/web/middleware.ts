import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./src/lib/security-headers";

/**
 * A Content-Security-Policy with a fresh nonce on every page response.
 *
 * The policy is sent to the browser and also set on the request Next renders,
 * which is where Next looks for the nonce to put on its own scripts
 * (`src/lib/security-headers.ts` says why a nonce and not `'unsafe-inline'`).
 */
export function middleware(request: NextRequest): NextResponse {
  return withContentSecurityPolicy(request, process.env.NODE_ENV === "development");
}

export function withContentSecurityPolicy(
  request: NextRequest,
  development: boolean
): NextResponse {
  // 128 random bits, base64: the nonce only has to be unguessable per response.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const policy = contentSecurityPolicy(nonce, development);

  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  // Static assets carry no document to protect, and would pay for a nonce on
  // every file. Everything else, pages, route handlers and not-found, gets one.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
