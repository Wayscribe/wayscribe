import Fastify from "fastify";
import { TEST_ACCOUNT } from "./account.js";
import { optionalEnv } from "./env.js";

/**
 * Stands in for Salesforce. Not instrumented, for the same reason
 * `demo-target` is not: it is not a service the team owns.
 */
const app = Fastify({ logger: true });
const integrationUrl = optionalEnv("INTEGRATION_URL", "http://demo-integration:3200");

app.get("/health", () => ({ status: "ok" }));

app.post("/trigger", async (_request, reply) => {
  const response = await fetch(`${integrationUrl}/webhooks/salesforce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(TEST_ACCOUNT)
  });

  const body: unknown = await response.json();
  return reply.code(response.status).send(body);
});

await app.listen({ host: "0.0.0.0", port: 3100 });
