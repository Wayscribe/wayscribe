import Fastify from "fastify";
import { contactResponse } from "./contacts.js";

/**
 * Stands in for HubSpot.
 *
 * Deliberately not instrumented: this is a system the team using Wayscribe
 * does not own, and a timeline covering only your own services is the
 * honest picture — as well as proof that the tool needs no cooperation from
 * either end of the integration.
 */
const app = Fastify({ logger: true });

app.get("/health", () => ({ status: "ok" }));

app.post("/contacts", async (request, reply) => {
  const { delayMs, status, body } = contactResponse(request.body);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return reply.code(status).send(body);
});

await app.listen({ host: "0.0.0.0", port: 3300 });
