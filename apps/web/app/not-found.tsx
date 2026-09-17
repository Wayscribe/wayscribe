import Link from "next/link";
import { connection } from "next/server";

/**
 * The page for a path nothing matches, and for a journey or event that does not
 * exist.
 *
 * Next's default is prerendered once at build time, so its inline scripts carry
 * no nonce and the Content-Security-Policy blocks them, and it styles itself
 * with `style` attributes the policy's `style-src 'self'` refuses. Awaiting
 * `connection()` renders it per request, so its scripts get the response's
 * nonce, and it is styled by the stylesheet like every other page.
 */
export default async function NotFound() {
  await connection();
  return (
    <main id="main">
      <h1>Not found</h1>
      <p className="muted">
        Nothing is recorded here. The journey or event may have been deleted, may belong to another
        project, or the link may be mistyped.
      </p>
      <p>
        <Link href="/">Search</Link>
      </p>
    </main>
  );
}
