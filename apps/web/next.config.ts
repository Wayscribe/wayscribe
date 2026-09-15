import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // `X-Powered-By: Next.js` tells a scanner which advisories to try, and a
  // browser nothing.
  poweredByHeader: false,
  eslint: {
    // Linting is a dedicated workspace-wide stage (`pnpm lint`) and a separate CI
    // job. Letting `next build` run ESLint again means two passes with different
    // configurations disagreeing with each other.
    ignoreDuringBuilds: true
  },
  // Every route. The Content-Security-Policy is set per response by
  // `middleware.ts`, because it carries a nonce.
  headers: () => Promise.resolve([{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }])
};

export default config;
