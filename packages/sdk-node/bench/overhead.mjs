import { fork } from "node:child_process";
import { cpus, totalmem } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildRecorder, defaultMaxConcurrentSends } from "./build.mjs";

/**
 * What the SDK costs the process it is embedded in.
 *
 *   pnpm --filter @wayscribe/node bench            full run, about ten minutes
 *   pnpm --filter @wayscribe/node bench -- --quick  shorter windows, for checking the harness
 *   pnpm --filter @wayscribe/node bench -- --only=latency,sustained,concurrency
 *   pnpm --filter @wayscribe/node bench -- --only=latency --awake
 *                                                         with a core kept awake (see awake.mjs)
 *
 * Every measurement runs in its own child process against an ingestion stub
 * that is also its own process, so neither the stub nor an earlier scenario
 * shares the event loop or heap being measured. Results print as Markdown.
 *
 * Not part of `pnpm test`: the numbers depend on the machine and on what else
 * it is doing, so they are evidence for a decision and a README table, not an
 * assertion.
 */
const quick = process.argv.includes("--quick");
const awake = process.argv.includes("--awake");
const onlyArgument = process.argv.find((argument) => argument.startsWith("--only="));
const only = new Set(
  onlyArgument === undefined
    ? ["latency", "sustained", "concurrency"]
    : onlyArgument.slice("--only=".length).split(",")
);
const UNREACHABLE = "http://127.0.0.1:1";

function startStub(latencyMs) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./ingestion-stub.mjs", import.meta.url)), [
      String(latencyMs)
    ]);
    child.once("error", reject);
    child.once("message", (message) => {
      if (message?.type !== "listening") return;
      resolve({
        endpoint: `http://127.0.0.1:${String(message.port)}`,
        request: (type) =>
          new Promise((done) => {
            const onMessage = (reply) => {
              if (reply?.type !== type) return;
              child.off("message", onMessage);
              done(reply);
            };
            child.on("message", onMessage);
            child.send({ type });
          }),
        stop: () => {
          child.send({ type: "stop" });
        }
      });
    });
  });
}

function runScenario(args, stub) {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./scenario.mjs", import.meta.url)),
      [JSON.stringify(args)],
      {
        execArgv: [
          "--expose-gc",
          ...(awake ? ["--import", new URL("./awake.mjs", import.meta.url).href] : [])
        ]
      }
    );
    child.on("message", (message) => {
      if (message?.type === "stats" && stub !== undefined) {
        void stub.request("stats").then((stats) => child.send(stats));
      }
      if (message?.type === "result") resolve(message.result);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`scenario ${args.scenario} exited ${String(code)}`));
    });
  });
}

const fixed = (value, digits = 1) => Number(value).toFixed(digits);

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

const log = (text = "") => {
  console.log(text);
};

const cpu = cpus()[0]?.model ?? "unknown CPU";
log(`# Wayscribe SDK overhead${quick ? " (quick)" : ""}${awake ? " (a core kept awake)" : ""}`);
log();
log(
  `${cpu}, ${String(cpus().length)} cores, ${fixed(totalmem() / 2 ** 30, 0)} GiB; ` +
    `Node ${process.version} on ${process.platform}; maxConcurrentSends default ${String(defaultMaxConcurrentSends())}`
);

const bundle = await buildRecorder();
const defaultModule = bundle.module;
process.on("exit", bundle.remove);

// 1 and 2: added latency per wrapped call.
if (only.has("latency")) {
  const local = await startStub(0);
  const slow = await startStub(200);
  const endpoints = [
    ["local stub", local.endpoint],
    ["unreachable", UNREACHABLE],
    ["200 ms stub", slow.endpoint]
  ];
  const rows = [];
  for (const [label, endpoint] of endpoints) {
    for (const wrapper of ["sync", "async"]) {
      for (const bytes of [1_024, 65_536]) {
        // A 64 KiB payload costs a real fraction of a millisecond to capture,
        // so it runs at a rate one core can sustain; otherwise the pacing
        // falls behind and every sample includes queueing in the harness.
        const rate = bytes > 1_024 ? 250 : 2_000;
        const calls = quick ? 1_000 : bytes > 1_024 ? 2_500 : 10_000;
        const result = await runScenario({
          scenario: "latency",
          module: defaultModule,
          endpoint,
          wrapper,
          bytes,
          rate,
          calls,
          warmup: quick ? 200 : 1_000
        });
        rows.push([
          label,
          wrapper === "sync" ? "`transform` (sync)" : "`persist` (async)",
          bytes > 1_024 ? "64 KiB" : "1 KiB",
          `${fixed(result.baseline.p50, 1)} / ${fixed(result.baseline.p99, 1)}`,
          `${fixed(result.wrapped.p50, 1)} / ${fixed(result.wrapped.p99, 1)}`,
          `${fixed(result.wrapped.p50 - result.baseline.p50, 1)} / ${fixed(result.wrapped.p99 - result.baseline.p99, 1)}`,
          String(result.counters.sent),
          String(result.counters.dropped)
        ]);
        process.stderr.write(".");
      }
    }
  }
  process.stderr.write("\n");
  local.stop();
  slow.stop();
  log();
  log("## Latency per call (microseconds, p50 / p99)");
  log();
  log(
    `Samples per row: ${quick ? "1,000" : "10,000 at 1 KiB and 2,500 at 64 KiB, so a 64 KiB p99 is the 25th slowest call"}.`
  );
  log();
  log(
    table(
      ["endpoint", "wrapper", "payload", "unwrapped", "wrapped", "added", "sent", "dropped"],
      rows
    )
  );
}

// 3: heap and event-loop delay under sustained load.
if (only.has("sustained")) {
  const seconds = quick ? 10 : 60;
  const stub = await startStub(0);
  const rows = [];
  for (const wrapped of [false, true]) {
    const result = await runScenario({
      scenario: "sustained",
      module: defaultModule,
      endpoint: stub.endpoint,
      wrapped,
      bytes: 1_024,
      rate: 2_000,
      seconds
    });
    rows.push([
      wrapped ? "wrapped" : "unwrapped",
      fixed(result.achievedRate, 0),
      `${fixed(result.heapStartMiB)} → ${fixed(result.heapEndMiB)}`,
      fixed(result.heapPeakMiB),
      fixed(result.rssMiB, 0),
      `${fixed(result.loopDelayMs.p50, 2)} / ${fixed(result.loopDelayMs.p99, 2)} / ${fixed(result.loopDelayMs.max, 2)}`,
      result.counters === undefined ? "" : String(result.counters.sent),
      result.counters === undefined ? "" : String(result.counters.dropped)
    ]);
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  stub.stop();
  log();
  log(
    `## ${String(seconds)} seconds at 2,000 calls per second (1 KiB, alternating sync and async)`
  );
  log();
  log(
    table(
      [
        "run",
        "calls/s achieved",
        "heap after GC, start → end (MiB)",
        "heap peak, sampled once a second (MiB)",
        "RSS (MiB)",
        "event-loop delay beyond 10 ms, p50 / p99 / max (ms)",
        "sent",
        "dropped"
      ],
      rows
    )
  );
}

// 4: send concurrency.
if (only.has("concurrency")) {
  const seconds = quick ? 5 : 15;
  const rows = [];
  for (const latencyMs of [50, 200]) {
    for (const rate of [2_000, 8_000]) {
      for (const maxConcurrentSends of [1, 2, 4, 8]) {
        const stub = await startStub(latencyMs);
        const result = await runScenario(
          {
            scenario: "concurrency",
            module: defaultModule,
            maxConcurrentSends,
            endpoint: stub.endpoint,
            bytes: 1_024,
            rate,
            seconds
          },
          stub
        );
        stub.stop();
        rows.push([
          `${String(latencyMs)} ms`,
          rate.toLocaleString("en-US"),
          String(maxConcurrentSends),
          fixed(result.throughput, 0),
          String(result.counters.dropped),
          `${fixed((100 * result.counters.dropped) / result.produced, 1)}%`,
          String(result.peakInFlight),
          fixed(result.loopDelayP99Ms, 2),
          String(result.counters.sent)
        ]);
        process.stderr.write(".");
      }
    }
  }
  process.stderr.write("\n");
  log();
  log(`## Send concurrency (${String(seconds)} s per run, 1 KiB events, batch size 50)`);
  log();
  log(
    "One process against a stub that serves any number of requests at once. It shows what a cap costs a single process, not what a fleet sharing one API's database pool can take."
  );
  log();
  log(
    table(
      [
        "server latency",
        "events/s produced",
        "maxConcurrentSends",
        "stored/s",
        "dropped",
        "dropped share",
        "peak requests in flight",
        "event-loop delay p99 (ms)",
        "stored by shutdown"
      ],
      rows
    )
  );
}
