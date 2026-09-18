import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import { sessionAdminToken } from "../../src/lib/config";
import { SESSION_COOKIE_NAME, verifySession } from "../../src/lib/session";
import { SiteNav } from "../components/SiteNav";
import { VersionFooter } from "../components/VersionFooter";

/**
 * The auth gate for every page in this route group.
 *
 * This lives in a layout rather than in Next middleware because middleware runs
 * on the Edge runtime, which has no `node:crypto` — and session verification
 * needs HKDF and a timing-safe comparison. A route-group layout runs on Node and
 * still gives one gate rather than a check each page could forget.
 *
 * The login page sits outside this group, so it stays reachable.
 *
 * It also carries the nav, the two ways in and the glossary, and under every
 * page the version line: what this web app and the API are running.
 */
export default async function AuthenticatedLayout({
  children
}: {
  children: ReactNode;
}): Promise<ReactElement> {
  const cookie = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  // No token means nothing can be verified, so nothing is: verifying against an
  // empty key would admit a cookie signed with an empty key, turning a
  // misconfiguration into a way in.
  const adminToken = sessionAdminToken();
  const session =
    adminToken === null || cookie === undefined
      ? null
      : verifySession(adminToken, cookie, Date.now());

  if (session === null) redirect("/login");

  return (
    <>
      <SiteNav />
      {children}
      <VersionFooter />
    </>
  );
}
