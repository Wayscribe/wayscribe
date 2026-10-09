import type { ReactElement } from "react";

/** The pinned failed journey's phone number, recreated on every reset (deploy/demo). */
export const DEMO_SEARCH = "+1 555 0100";

/** The Search page with the pinned search already run: a plain link, no script needed. */
export const DEMO_SEARCH_HREF = `/?q=${encodeURIComponent(DEMO_SEARCH)}`;

/**
 * Shown on every page in anonymous read-only mode (ADR-069). Rendered from the
 * mode, not the principal: it describes the instance, not the visitor.
 *
 * It only says what the instance is. The way in, the pinned sample search, is
 * the Search page's call to action, so the banner does not repeat it.
 */
export function DemoBanner(): ReactElement {
  return (
    <aside className="demo-banner" aria-label="About this demo">
      <p>
        <strong>Public demo. Read-only, sample data.</strong>{" "}
        <a href="mailto:pilots@wayscribe.dev">Ask about a pilot</a> ·{" "}
        <a href="https://wayscribe.dev">wayscribe.dev</a>
      </p>
    </aside>
  );
}
