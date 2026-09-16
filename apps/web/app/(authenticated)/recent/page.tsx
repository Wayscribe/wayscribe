import { redirect } from "next/navigation";
import { recentRedirectHref } from "../../../src/lib/journey-filters";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The Recent page grew into Journeys. Old links and bookmarks keep working:
 * the query string is carried over, and a link that named no status keeps
 * showing failures, which is what Recent showed by default
 * (`recentRedirectHref` says why).
 */
export default async function RecentPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<never> {
  redirect(recentRedirectHref(await searchParams));
}
