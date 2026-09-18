import { NextResponse } from "next/server";
import { webConfig } from "../../src/lib/config";

/**
 * What the container's health check probes (apps/web/Dockerfile), so
 * "healthy" means "configured" and not only "answering".
 *
 * It loads the configuration on every probe rather than trusting the check
 * the server made at startup (`src/lib/startup.ts`): a token file can be
 * removed or emptied under a running container, and the next sign-in would
 * fail on it. Probing /login, which reads no configuration at all, is how a
 * web app that could not sign anyone in was reported healthy (F-030).
 *
 * Unauthenticated, as a health check has to be, so a failure names nothing:
 * the process log has the specific message.
 *
 * Read per request, never at build time: `dynamic` keeps Next from rendering
 * this once during the build and serving that answer for ever.
 */
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  try {
    webConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { status: "not_configured" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
  return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
