import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { readBoundedJsonResponse } from "./node-entry.mjs";
import { startOwnedWorker, waitForOwnedChild } from "./run.mjs";

const nodeWorker = (source) => ({
  command: process.execPath,
  args: ["--input-type=module", "--eval", source],
  cwd: process.cwd(),
  env: process.env
});

test("a worker that exits before readiness is refused", async () => {
  await assert.rejects(
    startOwnedWorker("early worker", nodeWorker("process.exit(7)"), {
      startupTimeoutMs: 1_000,
      outputLimitBytes: 4_096
    }),
    /early worker exited with status 7 before readiness/
  );
});

test("a malformed readiness line is refused and the owned worker is reaped", async () => {
  let child;
  await assert.rejects(async () => {
    child = await startOwnedWorker(
      "malformed worker",
      nodeWorker('console.log("ready on 4000"); setInterval(() => {}, 1000)'),
      { startupTimeoutMs: 1_000, outputLimitBytes: 4_096 }
    );
  }, /malformed worker emitted malformed readiness/);
  assert.equal(child, undefined);
});

test("a hanging owned worker is terminated and reaped after its exit deadline", async () => {
  const worker = await startOwnedWorker(
    "hanging worker",
    nodeWorker(
      'process.on("SIGTERM",()=>{}); console.log(JSON.stringify({type:"ready",port:43123})); setInterval(() => {}, 1000)'
    ),
    { startupTimeoutMs: 1_000, outputLimitBytes: 4_096 }
  );
  const pid = worker.child.pid;

  await assert.rejects(waitForOwnedChild(worker, 100), /hanging worker exceeded its exit deadline/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("a malformed worker response is refused", async () => {
  await assert.rejects(
    readBoundedJsonResponse(new globalThis.Response("not json"), "Python worker"),
    /Python worker returned malformed JSON/
  );
});

test("a flooding worker retains only the output limit and is terminated once", async () => {
  const outputLimitBytes = 4_096;
  const worker = await startOwnedWorker(
    "flooding worker",
    nodeWorker(
      'process.on("SIGTERM",()=>{}); console.log(JSON.stringify({type:"ready",port:43124})); setTimeout(() => setInterval(() => process.stdout.write("x".repeat(8192)), 5), 20)'
    ),
    { startupTimeoutMs: 1_000, outputLimitBytes }
  );
  const originalKill = worker.child.kill.bind(worker.child);
  const signals = [];
  worker.child.kill = (signal) => {
    signals.push(signal);
    return originalKill(signal);
  };

  await assert.rejects(
    waitForOwnedChild(worker, 2_000),
    /flooding worker exceeded its 4096 byte output limit/
  );
  const output = worker.output();
  assert.ok(
    Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= outputLimitBytes
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
