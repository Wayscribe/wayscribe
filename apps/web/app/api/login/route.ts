import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { clientAddress } from "../../../src/lib/client-address";
import { redirectTarget } from "../../../src/lib/redirect-url";
import { webConfig } from "../../../src/lib/config";
import { LoginLimiter } from "../../../src/lib/login-limiter";
import { rejectCrossOrigin } from "../../../src/lib/same-origin";
import { SESSION_COOKIE_NAME, signSession } from "../../../src/lib/session";
import { currentSocketAddress } from "../../../src/lib/socket-address";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

// Module scope: one limiter per server process, which is exactly the scope it
// claims to cover (ADR-029).
const limiter = new LoginLimiter();

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Before the limiter: a cross-origin page must not be able to spend the
  // operator's attempts, or sign the browser into a session of its choosing.
  const refused = rejectCrossOrigin(request);
  if (refused !== null) return refused;

  const config = webConfig();
  const now = Date.now();
  // The socket's address, never a header the client wrote, unless the operator
  // has said how many proxies stand in front of this app.
  const key = clientAddress(
    currentSocketAddress(),
    request.headers.get("x-forwarded-for"),
    config.TRUSTED_PROXY_COUNT
  );

  // The login form is a plain HTML POST, so failures must redirect back to the
  // page. Returning JSON would render a raw error object in the browser.
  if (limiter.isLocked(key, now)) {
    return NextResponse.redirect(redirectTarget(request, "/login?error=throttled"), {
      status: 303
    });
  }

  const form = await request.formData();
  // FormData.get returns string | File | null. A multipart post could send a
  // File, and stringifying one yields "[object File]" — which would then be
  // compared against the admin token as if it were a real attempt.
  const field = form.get("token");
  const presented = typeof field === "string" ? field : "";

  if (!constantTimeEquals(presented, config.ADMIN_TOKEN)) {
    limiter.recordFailure(key, now);
    // One outcome regardless of cause: a near-miss must not read differently
    // from a wild guess.
    return NextResponse.redirect(redirectTarget(request, "/login?error=invalid"), {
      status: 303
    });
  }

  limiter.recordSuccess(key);

  // Empty project means "the API resolves it", which it does when exactly one
  // project exists. Multi-project selection belongs in the session payload when
  // it arrives.
  const response = NextResponse.redirect(redirectTarget(request, "/"), { status: 303 });
  response.cookies.set(
    SESSION_COOKIE_NAME,
    signSession(config.ADMIN_TOKEN, { projectId: "", expiresAt: now + SESSION_DURATION_MS }),
    {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_DURATION_MS / 1000
    }
  );
  return response;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
