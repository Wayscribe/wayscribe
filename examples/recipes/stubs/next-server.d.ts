// A stand-in for `after` from `next/server` (stable since Next.js 15.1). Route
// handlers themselves take and return the standard `Request` and `Response`,
// which Node's own types declare, so nothing else from Next.js is needed. With
// `next` installed, delete this file.
declare module "next/server" {
  export function after(task: () => unknown): void;
}
