"use client";

/**
 * The last line of defence.
 *
 * There was no error boundary anywhere in this application, so anything a page
 * threw — most commonly the API being unreachable while it booted — rendered a
 * blank HTTP 500 whose entire visible text was "Flight Recorder". A debugging
 * tool that cannot explain its own failure is a poor advertisement for itself.
 *
 * Deliberately does not show the error message. A server-side message can carry
 * connection strings and internals, and the recovery advice below is more
 * useful than the stack trace anyway. The digest is enough to correlate with
 * the server log.
 */
export default function Error({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p className="muted">
        This page could not be loaded. The most common cause is the Flight Recorder API not being
        reachable — it may still be starting, or it may be pointed at a database that is not up yet.
      </p>

      <h2>What to check</h2>
      <ul>
        <li>
          <span className="mono">docker compose ps</span> — is the <span className="mono">api</span>{" "}
          service running?
        </li>
        <li>
          <span className="mono">curl localhost:8080/ready</span> — a 503 with{" "}
          <span className="mono">migrations_pending</span> means run{" "}
          <span className="mono">pnpm db:migrate</span>.
        </li>
        <li>
          Do the web and API containers hold the same <span className="mono">ADMIN_TOKEN</span>?
        </li>
      </ul>

      <p>
        <button type="button" onClick={reset}>
          Try again
        </button>
      </p>

      {error.digest === undefined ? null : <p className="muted mono">Reference: {error.digest}</p>}
    </main>
  );
}
