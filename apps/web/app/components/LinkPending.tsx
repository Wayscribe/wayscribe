"use client";

import { useLinkStatus } from "next/link";
import type { ReactElement } from "react";

/**
 * A small marker inside a `<Link>` while the page it leads to is loading.
 *
 * Pages are rendered in full before they are sent (the Journeys page says why),
 * so a client-side navigation otherwise shows nothing until the next page
 * arrives. Must be rendered inside a `<Link>`: `useLinkStatus` reads the
 * nearest one. Renders nothing while idle, so a link's text is unchanged, and
 * nothing at all without JavaScript, when links are ordinary page loads.
 *
 * Hidden from assistive technology: it is a visual cue, and Next announces the
 * new page when it arrives. The stylesheet delays it briefly, so a fast
 * navigation does not flash it.
 */
export function LinkPending(): ReactElement | null {
  const { pending } = useLinkStatus();
  return pending ? <span className="link-pending" aria-hidden="true" /> : null;
}
