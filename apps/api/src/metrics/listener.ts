import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiMetrics } from "./api-metrics.js";

/** The content type Prometheus expects for the text format. */
export const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export interface MetricsServer {
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

/**
 * The metrics listener: `GET /metrics` and nothing else.
 *
 * A bare `node:http` server rather than a second Fastify instance. It has one
 * route, no body, and no authentication, and keeping it outside Fastify means
 * the API's hooks never count a scrape as a request.
 */
export function createMetricsServer(
  metrics: ApiMetrics,
  log: { error: (fields: Record<string, unknown>, message: string) => void }
): MetricsServer {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.\n");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    metrics.render().then(
      (body) => {
        response.writeHead(200, { "content-type": EXPOSITION_CONTENT_TYPE });
        response.end(request.method === "HEAD" ? undefined : body);
      },
      (error: unknown) => {
        log.error({ err: error }, "metrics render failed");
        response.writeHead(500).end();
      }
    );
  });

  return {
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        // A scraper holds its connection open between scrapes; without this,
        // close waits for it and shutdown hangs for the keep-alive timeout.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      })
  };
}
