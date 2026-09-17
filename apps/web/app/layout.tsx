import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Wayscribe",
  description: "Record-level debugging for distributed workflows"
};

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
