import Fastify from "fastify";
import { accountFrom } from "./account.js";
import { optionalEnv } from "./env.js";
import { loopAccount } from "./history.js";

/**
 * Stands in for Salesforce. Not instrumented, for the same reason
 * `demo-target` is not: it is not a service the team owns.
 */
const app = Fastify({ logger: true });
const integrationUrl = optionalEnv("INTEGRATION_URL", "http://demo-integration:3200");

app.get("/health", () => ({ status: "ok" }));

/**
 * Fire one webhook.
 *
 * With no body it sends the reference account of `DEMO_SCENARIO.md` section 3,
 * which is what `pnpm demo:trigger` and the acceptance test do. A JSON body
 * overrides the account's fields, so the demo can produce more than one journey
 * to look at: another customer, or the same account carrying `Phone__c`, which
 * the broken transformation does read and which therefore reaches the target
 * and completes. The stack stays the only source of the data either way.
 */
app.post("/trigger", async (request, reply) => {
  const account = accountFrom(request.body);
  const response = await fetch(`${integrationUrl}/webhooks/salesforce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(account)
  });

  const body: unknown = await response.json();
  return reply.code(response.status).send(body);
});

/**
 * The public demo's live traffic: one new customer every DEMO_LOOP_INTERVAL_MS
 * (60000 there), about a fifth of them without `Phone__c`, so they take the
 * 422, retry, dead-letter path. Unset or 0, as everywhere else, means no loop.
 * A failed trigger is logged and the loop goes on: the integration may still be
 * starting.
 */
const loopIntervalMs = Number.parseInt(optionalEnv("DEMO_LOOP_INTERVAL_MS", "0"), 10);
if (Number.isInteger(loopIntervalMs) && loopIntervalMs > 0) {
  setInterval(() => {
    const account = loopAccount(new Date(), Math.random);
    void fetch(`${integrationUrl}/webhooks/salesforce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(account)
    })
      .then((response) => {
        app.log.info({ status: response.status, account: account.Id }, "loop trigger");
      })
      .catch((error: unknown) => {
        app.log.warn({ err: error }, "loop trigger failed; the next one runs on schedule");
      });
  }, loopIntervalMs);
  app.log.info({ intervalMs: loopIntervalMs }, "loop mode on");
}

await app.listen({ host: "0.0.0.0", port: 3100 });
