import type { Metadata } from "next";
import type { ReactNode } from "react";
import { siteMetadata } from "../src/lib/site-metadata";
import "./globals.css";

// At request time, so WEB_PUBLIC_URL is the container's, not the build's.
export function generateMetadata(): Metadata {
  return siteMetadata();
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* The first thing a keyboard reaches, so the nav need not be tabbed
            through on every page. Every page's <main> carries id="main". */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
