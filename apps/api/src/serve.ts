import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { createMetricsServer } from "./metrics/listener.js";

export interface ServeOptions {
  port: number;
  host: string;
  /** From METRICS_PORT. Undefined starts no metrics listener at all. */
  metricsPort: number | undefined;
}

export interface Serving {
  apiAddress: AddressInfo;
  metricsAddress: AddressInfo | null;
}

/**
 * Start listening: the API on its port, and metrics on theirs when configured.
 *
 * The metrics listener is tied to the app's lifecycle through an `onClose`
 * hook, so closing the API closes it too and shutdown has one thing to call.
 * It is registered before the API listens, because Fastify refuses new hooks
 * once it is ready.
 */
export async function serveApi(app: FastifyInstance, options: ServeOptions): Promise<Serving> {
  const metricsServer =
    options.metricsPort === undefined ? undefined : createMetricsServer(app.metrics, app.log);
  if (metricsServer !== undefined) {
    app.addHook("onClose", async () => {
      await metricsServer.close();
    });
  }

  await app.listen({ port: options.port, host: options.host });
  const apiAddress = app.server.address() as AddressInfo;

  if (metricsServer === undefined || options.metricsPort === undefined) {
    return { apiAddress, metricsAddress: null };
  }
  try {
    const metricsAddress = await metricsServer.listen(options.metricsPort, options.host);
    return { apiAddress, metricsAddress };
  } catch (error) {
    // A metrics port that is taken is a configuration mistake worth stopping
    // for, and an API left listening would keep the process alive regardless.
    await app.close();
    throw error;
  }
}
