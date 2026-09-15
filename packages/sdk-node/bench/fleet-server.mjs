import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout } from "node:timers";

/**
 * One API instance, modelled on apps/api's batch route: events in a request are
 * stored one after another, each holding one of `pool` database connections
 * for `serviceMs`, connections are handed out first come first served, and a
 * client that gives up does not stop the handler, which is what Fastify does.
 *
 * It counts unique event ids and duplicates, so work the server did for a
 * request the client had already abandoned is visible.
 */
const pool = Number(process.argv[2] ?? "10");
const serviceMs = Number(process.argv[3] ?? "4");

let free = pool;
const waiters = [];
const acquire = () => {
  if (free > 0) {
    free -= 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
};
const release = () => {
  const next = waiters.shift();
  if (next === undefined) free += 1;
  else next();
};
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const seen = new Set();
let stored = 0;
let duplicates = 0;
let requests = 0;
let unanswered = 0;
let peakWaiters = 0;

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    requests += 1;
    let gone = false;
    response.on("close", () => {
      if (!response.writableFinished) gone = true;
    });
    const { events } = JSON.parse(Buffer.concat(chunks).toString());
    const results = [];
    for (const entry of events) {
      await acquire();
      peakWaiters = Math.max(peakWaiters, waiters.length);
      await sleep(serviceMs);
      release();
      stored += 1;
      if (seen.has(entry.event.id)) duplicates += 1;
      else seen.add(entry.event.id);
      results.push({ eventId: entry.event.id, status: "accepted", duplicate: false });
    }
    if (gone || response.destroyed) {
      unanswered += 1;
      return;
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { results } }));
  });
});
server.keepAliveTimeout = 60_000;
server.listen(0, "127.0.0.1", () => {
  process.send?.({ type: "listening", port: server.address().port });
});

process.on("message", (message) => {
  if (message?.type === "stats") {
    process.send?.({
      type: "stats",
      unique: seen.size,
      stored,
      duplicates,
      requests,
      unanswered,
      peakWaiters,
      at: performance.now()
    });
  }
  if (message?.type === "stop") process.exit(0);
});
