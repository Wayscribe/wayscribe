import Link from "next/link";
import { LinkPending } from "./LinkPending";

/**
 * The glossary, as the repository hosts it.
 *
 * Not a path on this app: `docs/` is not in the web image, which carries only
 * Next's standalone bundle (apps/web/Dockerfile), so a local link would 404 in
 * every real installation.
 */
export const GLOSSARY_URL =
  "https://gitlab.com/jojithedev/flight-recorder/-/blob/main/docs/GLOSSARY.md";

/**
 * The nav above every signed-in page: the two ways in, Search for an
 * identifier and Journeys for browsing without one, and off to the side the
 * glossary, for a reader who meets a term the page does not explain.
 */
export function SiteNav() {
  return (
    <nav className="site-nav" aria-label="Main">
      <Link href="/">
        Search
        <LinkPending />
      </Link>
      <Link href="/journeys">
        Journeys
        <LinkPending />
      </Link>
      <a className="site-nav-aside muted" href={GLOSSARY_URL}>
        Glossary
      </a>
    </nav>
  );
}
