import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import process from "node:process";
import { setTimeout } from "node:timers";

/**
 * Answers `POST /v1/events/batch` the way ingestion does: 202 with one
 * accepted verdict per event, after a fixed delay.
 *
 * Run as its own process, so the stub's parsing and serialising never lands on
 * the event loop being measured.
 *
 * The delay does not grow with concurrency, which a real ingestion server's
 * does once its database pool is busy. Throughput measured against this stub
 * is therefore the most extra concurrency could ever buy, not what it buys.
 */
const latencyMs = Number(process.argv[2] ?? "0");

let accepted = 0;
let inFlight = 0;
let peakInFlight = 0;

const server = createServer((request, response) => {
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let events = [];
    try {
      events = JSON.parse(Buffer.concat(chunks).toString()).events ?? [];
    } catch {
      events = [];
    }
    const results = events.map((entry) => ({
      eventId: entry?.event?.id ?? null,
      status: "accepted",
      duplicate: false
    }));
    setTimeout(() => {
      accepted += results.length;
      inFlight -= 1;
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { results } }));
    }, latencyMs);
  });
});

server.keepAliveTimeout = 60_000;

server.listen(0, "127.0.0.1", () => {
  process.send?.({ type: "listening", port: server.address().port });
});

process.on("message", (message) => {
  if (message?.type === "stats") {
    process.send?.({ type: "stats", accepted, peakInFlight });
  }
  if (message?.type === "reset") {
    accepted = 0;
    peakInFlight = inFlight;
    process.send?.({ type: "reset" });
  }
  if (message?.type === "stop") {
    server.close();
    process.exit(0);
  }
});
