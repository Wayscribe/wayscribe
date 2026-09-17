import { performance } from "node:perf_hooks";
import process from "node:process";
import { buildRecorder } from "./build.mjs";

/**
 * What capture costs per recorded event, for the secret-name warning (ADR-055).
 *
 *   pnpm --filter @wayscribe/node exec node bench/secret-names.mjs
 *
 * Times `journey.record()`, which is where capture runs, synchronously, on a
 * realistic webhook: a Stripe-shaped event of about 5.6 KB with its request
 * headers, recorded as input and output with metadata. Run it on a build
 * without the warning and on one with it and compare. Not part of `pnpm test`:
 * the numbers depend on the machine.
 *
 * The recorder points at a port nothing listens on, with a flush interval
 * longer than the run and a buffer larger than it, so what is timed is
 * capture and the queue push, not the network.
 */
const RUNS = 7;
const EVENTS_PER_RUN = 20_000;
const WARMUP = 5_000;

function webhook(extraNames) {
  const lines = Array.from({ length: 20 }, (_unused, index) => ({
    id: `li_${String(index).padStart(14, "0")}`,
    object: "line_item",
    amount: 1999 + index,
    currency: "usd",
    description: "Replacement filter cartridge, pack of two",
    price: { id: `price_${String(index)}`, unit_amount: 1999, recurring: null },
    quantity: (index % 7) + 1,
    metadata: { sku: `SKU-${String(index).padStart(6, "0")}` }
  }));
  return {
    headers: {
      host: "hooks.example.com",
      "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
      "content-type": "application/json; charset=utf-8",
      "stripe-signature":
        "t=1726500000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd",
      authorization: "Bearer not-a-real-token-000000"
    },
    body: {
      id: "evt_1PzExample",
      object: "event",
      api_version: "2024-06-20",
      created: 1726500000,
      type: "invoice.paid",
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: "example" },
      data: {
        object: {
          id: "in_1PzExample",
          object: "invoice",
          customer: "cus_Example",
          customer_email: "dana@example.com",
          amount_paid: 45_976,
          status: "paid",
          lines: { object: "list", data: lines, has_more: false },
          ...extraNames
        }
      }
    }
  };
}

/** Microseconds per `record()` over `count` calls on a fresh recorder. */
async function timeRecords(createRecorder, payload, count) {
  const recorder = createRecorder({
    endpoint: "http://127.0.0.1:1",
    apiKey: "wsk_bench_not_a_key",
    serviceName: "bench",
    environment: "bench",
    flushIntervalMs: 3_600_000,
    maxBufferedEvents: count
  });
  const journey = recorder.startJourney({ entity: { type: "invoice", id: "in_1PzExample" } });
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    journey.record({
      operation: "received",
      name: "stripe-webhook",
      input: payload,
      output: payload.body.data,
      metadata: { attempt: 1, route: "/hooks/stripe" }
    });
  }
  const elapsed = performance.now() - started;
  await recorder.shutdown({ timeoutMs: 50 });
  return (elapsed * 1_000) / count;
}

async function measure(createRecorder, payload) {
  await timeRecords(createRecorder, payload, WARMUP);
  const perEvent = [];
  for (let run = 0; run < RUNS; run += 1) {
    perEvent.push(await timeRecords(createRecorder, payload, EVENTS_PER_RUN));
  }
  perEvent.sort((left, right) => left - right);
  return perEvent[Math.floor(perEvent.length / 2)];
}

// `--module=<file>` measures an SDK bundle built elsewhere, such as one from
// the commit before a change, with the same payload and the same loop.
const given = process.argv.find((argument) => argument.startsWith("--module="));
const built = given === undefined ? await buildRecorder() : undefined;
try {
  const moduleUrl = built?.module ?? new URL(given.slice("--module=".length), "file:///").href;
  const { createRecorder } = await import(moduleUrl);
  const size = JSON.stringify(webhook({})).length;
  const clean = await measure(createRecorder, webhook({}));
  const flagged = await measure(
    createRecorder,
    webhook({ sessionCredential: "cred-0000", payment_settings: { authToken: "tok-0000" } })
  );
  process.stdout.write(
    [
      `payload: ${String(size)} bytes of JSON, recorded as input and output with metadata`,
      `median of ${String(RUNS)} runs of ${String(EVENTS_PER_RUN)} record() calls`,
      `no secret-looking names:      ${clean.toFixed(1)} microseconds per event`,
      `two unredacted secret names:  ${flagged.toFixed(1)} microseconds per event`,
      ""
    ].join("\n")
  );
} finally {
  built?.remove();
}
