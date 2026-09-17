/**
 * Shown while the Journeys list is still fetching from the API.
 *
 * The list page awaits the API before it renders, so without this a slow or
 * distant API left the browser on the previous page, or on a blank one, until
 * the whole response was ready.
 *
 * It sits in the `(list)` group, which holds this page alone, and not beside
 * the group's layout, because a loading boundary streams everything beneath
 * it: the response starts as a 200 before the page has decided anything, so a
 * journey page's `notFound()` could no longer answer 404. The journey pages
 * keep their status codes by having no boundary above them. Search wraps only
 * its results in a boundary of its own, for the same reason.
 */
export default function Loading() {
  return (
    <main id="main">
      <p className="muted" role="status">
        Loading journeys…
      </p>
    </main>
  );
}
