import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  eslint: {
    // Linting is a dedicated workspace-wide stage (`pnpm lint`) and a separate CI
    // job. Letting `next build` run ESLint again means two passes with different
    // configurations disagreeing with each other.
    ignoreDuringBuilds: true
  }
};

export default config;
