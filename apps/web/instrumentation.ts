/**
 * Runs once in the server process before Next serves a request.
 *
 * Installs the socket-address capture the login limiter keys on
 * (`src/lib/socket-address.ts`). Only in the Node.js runtime: the edge runtime
 * has no `node:http` server to wrap, and nothing here runs there.
 */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const [http, { installSocketAddressCapture }] = await Promise.all([
    import("node:http"),
    import("./src/lib/socket-address")
  ]);
  installSocketAddressCapture(http);
}
