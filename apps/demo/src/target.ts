import Fastify from "fastify";

/**
 * Stands in for HubSpot.
 *
 * Deliberately not instrumented: this is a system the team using Flight
 * Recorder does not own, and a timeline covering only your own services is the
 * honest picture — as well as proof that the tool needs no cooperation from
 * either end of the integration.
 */
const app = Fastify({ logger: true });

app.get("/health", () => ({ status: "ok" }));

app.post("/contacts", (request, reply) => {
  const body = request.body as { externalId?: string; phone?: string | null };

  if (body.phone === null || body.phone === undefined || body.phone === "") {
    return reply.code(422).send({
      error: { code: "phone_required", message: "A phone number is required." }
    });
  }

  return reply.code(201).send({ id: `contact_${body.externalId ?? "unknown"}` });
});

await app.listen({ host: "0.0.0.0", port: 3300 });
