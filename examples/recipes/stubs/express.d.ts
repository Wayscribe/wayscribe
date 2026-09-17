// A stand-in for the parts of Express 5's types the recipe uses, so this
// repository can type-check the recipe without installing Express. With
// `express` and `@types/express` installed, delete this file: the recipe is
// written to compile against the real types too.
declare module "express" {
  import type { IncomingHttpHeaders, Server } from "node:http";

  export interface Request {
    body: unknown;
    headers: IncomingHttpHeaders;
  }

  export interface Response {
    status(code: number): Response;
    json(body: unknown): Response;
  }

  export type RequestHandler = (request: Request, response: Response) => void | Promise<void>;

  export interface Express {
    use(middleware: unknown): Express;
    get(path: string, handler: RequestHandler): Express;
    post(path: string, handler: RequestHandler): Express;
    listen(port: number): Server;
  }

  interface ExpressFactory {
    (): Express;
    json(): unknown;
  }

  const express: ExpressFactory;
  export default express;
}
