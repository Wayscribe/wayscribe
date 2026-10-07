import Link from "next/link";
import type { ReactElement } from "react";

/** The pinned failed journey's phone number, recreated on every reset (deploy/demo). */
export const DEMO_SEARCH = "+1 555 0100";

/**
 * Shown on every page in anonymous read-only mode (ADR-069). Rendered from the
 * mode, not the principal: it describes the instance, not the visitor.
 */
export function DemoBanner(): ReactElement {
  return (
    <aside className="demo-banner" aria-label="About this demo">
      <p>
        <strong>Public demo. Read-only, sample data.</strong> Try a search for{" "}
        <Link href={`/?q=${encodeURIComponent(DEMO_SEARCH)}`}>{DEMO_SEARCH}</Link>, open the failed
        journey, and read what its transform step changed.{" "}
        <a href="mailto:pilots@wayscribe.dev">Ask about a pilot</a> ·{" "}
        <a href="https://wayscribe.dev">wayscribe.dev</a>
      </p>
    </aside>
  );
}
