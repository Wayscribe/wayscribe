import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Flight Recorder",
  description: "Record-level debugging for distributed workflows"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
