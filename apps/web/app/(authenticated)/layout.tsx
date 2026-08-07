import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SESSION_COOKIE_NAME, verifySession } from "../../src/lib/session";

/**
 * The auth gate for every page in this route group.
 *
 * This lives in a layout rather than in Next middleware because middleware runs
 * on the Edge runtime, which has no `node:crypto` — and session verification
 * needs HKDF and a timing-safe comparison. A route-group layout runs on Node and
 * still gives one gate rather than a check each page could forget.
 *
 * The login page sits outside this group, so it stays reachable.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const adminToken = process.env["ADMIN_TOKEN"] ?? "";
  const session = cookie === undefined ? null : verifySession(adminToken, cookie, Date.now());

  if (session === null) redirect("/login");

  return <>{children}</>;
}
