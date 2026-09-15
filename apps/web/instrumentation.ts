/**
 * Runs once in the server process before Next serves a request.
 *
 * Installs the socket-address capture the login limiter keys on
 * (`src/lib/socket-address.ts`). Only in the Node.js runtime: the edge runtime,
 * which runs the middleware, has no `node:http` server to wrap. The test is
 * written `process.env.NEXT_RUNTIME` exactly, because that is the form Next
 * replaces at build time, which is what keeps `node:http` out of the edge
 * bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
