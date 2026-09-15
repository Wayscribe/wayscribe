import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The address of the socket a request arrived on, for the request's handling.
 *
 * A Next.js route handler is given a `Request` and nothing of the connection
 * behind it: `NextRequest.ip` is gone in Next 15, and Next fills
 * `X-Forwarded-For` from the socket only when the client did not send one, so
 * that header is the client's to choose. The login limiter needs something the
 * client cannot choose.
 *
 * `installSocketAddressCapture` wraps `http.Server.prototype.emit` so every
 * `request` event runs inside an `AsyncLocalStorage` holding the socket's
 * address, and everything that request's handling awaits, the route handler
 * included, can read it. It is installed from `instrumentation.ts`, which Next
 * runs once in the server process before serving.
 *
 * The storage lives on `globalThis` under a registered symbol, because the
 * instrumentation file and each route are bundled separately and a module-level
 * instance would be a different object in each.
 */
const STORAGE = Symbol.for("flight-recorder.web.socket-address");
const INSTALLED = Symbol.for("flight-recorder.web.socket-address.installed");

type Registry = typeof globalThis & {
  [STORAGE]?: AsyncLocalStorage<string>;
  [INSTALLED]?: boolean;
};

export function socketAddressStorage(): AsyncLocalStorage<string> {
  const registry = globalThis as Registry;
  const existing: AsyncLocalStorage<string> | undefined = registry[STORAGE];
  if (existing !== undefined) return existing;
  const created = new AsyncLocalStorage<string>();
  registry[STORAGE] = created;
  return created;
}

/** The socket address of the request being handled, or undefined outside one. */
export function currentSocketAddress(): string | undefined {
  return socketAddressStorage().getStore();
}

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;

/** Idempotent: a second call, from a reload in development, does not wrap twice. */
export function installSocketAddressCapture(http: typeof import("node:http")): void {
  const registry = globalThis as Registry;
  if (registry[INSTALLED] === true) return;
  registry[INSTALLED] = true;

  const storage = socketAddressStorage();
  // Typed loosely: the overloads Node declares for `emit` cannot be assigned a
  // single wrapper, and this one forwards every event unchanged.
  const prototype = http.Server.prototype as unknown as { emit: Emit };
  const emit = prototype.emit;
  prototype.emit = function emitWithSocketAddress(
    this: unknown,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event !== "request") return emit.call(this, event, ...args);
    const address = (args[0] as { socket?: { remoteAddress?: string } } | undefined)?.socket
      ?.remoteAddress;
    return address === undefined
      ? emit.call(this, event, ...args)
      : storage.run(address, () => emit.call(this, event, ...args));
  };
}
