import type { ReactNode } from "react";

export const metadata = {
  title: "Flight Recorder",
  description: "Record-level debugging for distributed workflows"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
