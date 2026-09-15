import { fork } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildRecorder } from "./build.mjs";

/**
 * A fleet of SDK processes against one API instance with a bounded database
 * pool, at two values of maxConcurrentSends.
 *
 *   pnpm --filter @flight-recorder/node bench:fleet
 *
 * `overhead.mjs` sends from one process to a stub that serves any number of
 * requests at once, which is why it favours more concurrency. This is the
 * case it leaves out: every ingestion request holds a database connection, so
 * the whole fleet shares instances times pool size. When the sum of caps
 * exceeds that, requests wait for a connection past `requestTimeoutMs`, the
 * SDK abandons and resends batches the server goes on to store, and the
 * duplicates are load on a server that is already behind.
 *
 * A model, not the API: the pool, per-event cost, and client-abort behaviour
 * are copied from apps/api, and nothing else about it is.
 */
const settings = {
  processes: 10,
  pool: 10,
  // 10 connections at 4 ms per event: about 2,500 events a second.
  serviceMs: 4,
  rate: 200,
  seconds: 30,
  burstFactor: 5,
  burstStart: 5,
  burstSeconds: 10
};

function child(file, args) {
  return fork(fileURLToPath(new URL(file, import.meta.url)), args);
}

function once(process_, type) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      process_.off("message", onMessage);
      resolve(message);
    };
    process_.on("message", onMessage);
  });
}

async function run(module, maxConcurrentSends) {
  const server = child("./fleet-server.mjs", [String(settings.pool), String(settings.serviceMs)]);
  const { port } = await once(server, "listening");
  const clients = Array.from({ length: settings.processes }, () =>
    child("./fleet-client.mjs", [
      JSON.stringify({
        module,
        endpoint: `http://127.0.0.1:${String(port)}`,
        maxConcurrentSends,
        rate: settings.rate,
        seconds: settings.seconds,
        burstFactor: settings.burstFactor,
        burstStart: settings.burstStart,
        burstSeconds: settings.burstSeconds
      })
    ])
  );
  const results = await Promise.all(clients.map((client) => once(client, "done")));
  const statsReply = once(server, "stats");
  server.send({ type: "stats" });
  const stats = await statsReply;
  server.send({ type: "stop" });

  const sum = (pick) => results.reduce((total, result) => total + pick(result), 0);
  return {
    maxConcurrentSends,
    produced: sum((result) => result.produced),
    sdkSent: sum((result) => result.counters.sent),
    sdkDropped: sum((result) => result.counters.dropped),
    sdkTransportErrors: sum((result) => result.counters.transportErrors),
    sdkBreakerOpened: sum((result) => result.counters.breakerOpened),
    serverUnique: stats.unique,
    serverStored: stats.stored,
    serverDuplicates: stats.duplicates,
    serverRequests: stats.requests,
    repliesNobodyWaitedFor: stats.unanswered,
    peakPoolWaiters: stats.peakWaiters
  };
}

const bundle = await buildRecorder();
process.on("exit", bundle.remove);

const capacity = (settings.pool * 1_000) / settings.serviceMs;
console.log(
  `${String(settings.processes)} processes at ${String(settings.rate)} events/s each, ` +
    `x${String(settings.burstFactor)} from ${String(settings.burstStart)} s for ${String(settings.burstSeconds)} s, ` +
    `${String(settings.seconds)} s; one API instance, pool ${String(settings.pool)}, ` +
    `${String(settings.serviceMs)} ms per event (about ${String(capacity)} events/s)`
);
for (const cap of [4, 8]) {
  console.log(JSON.stringify(await run(bundle.module, cap)));
}
