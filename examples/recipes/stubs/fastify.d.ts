// A stand-in for the parts of Fastify 5's types the recipe uses. With `fastify`
// installed, delete this file.
declare module "fastify" {
  import type { IncomingHttpHeaders } from "node:http";

  export interface FastifyRequest {
    body: unknown;
    headers: IncomingHttpHeaders;
  }

  export interface FastifyReply {
    code(statusCode: number): FastifyReply;
    send(payload?: unknown): FastifyReply;
  }

  export interface FastifyInstance {
    get(path: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): this;
    post(
      path: string,
      handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>
    ): this;
    addHook(name: "onClose", hook: (instance: FastifyInstance) => Promise<void>): this;
    listen(options: { port: number; host?: string }): Promise<string>;
    close(): Promise<void>;
  }

  export default function fastify(options?: { logger?: boolean }): FastifyInstance;
}
