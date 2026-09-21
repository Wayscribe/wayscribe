#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { Buffer } from "node:buffer";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

const closed = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", resolve);
  });

export async function terminateOwnedChild(child, graceMs = 500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = closed(child);
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exit.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), graceMs))
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exit;
}

export async function startOwnedWorker(name, commandSpec, options = {}) {
  const startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  const child = spawn(commandSpec.command, commandSpec.args ?? [], {
    cwd: commandSpec.cwd,
    env: commandSpec.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let retainedBytes = 0;
  let overflow;
  let termination;
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  const failReady = (error) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  };
  const terminateOnce = () => {
    termination ??= terminateOwnedChild(child);
    return termination;
  };
  const append = (stream, chunk) => {
    const remaining = Math.max(0, outputLimitBytes - retainedBytes);
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      retainedBytes += kept.length;
      if (stream === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
    }
    if (chunk.length <= remaining || overflow) return;
    overflow = new Error(`${name} exceeded its ${String(outputLimitBytes)} byte output limit`);
    failReady(overflow);
    void terminateOnce();
  };
  child.stderr.on("data", (chunk) => {
    append("stderr", chunk);
  });
  child.stdout.on("data", (chunk) => {
    append("stdout", chunk);
    if (readySettled) return;
    const newline = stdout.indexOf(10);
    if (newline < 0) return;
    const line = stdout.subarray(0, newline).toString("utf8");
    try {
      const parsed = JSON.parse(line);
      if (
        parsed?.type !== "ready" ||
        !Number.isInteger(parsed.port) ||
        parsed.port < 1 ||
        parsed.port > 65_535 ||
        Object.keys(parsed).length !== 2
      ) {
        throw new Error();
      }
      readySettled = true;
      resolveReady(parsed.port);
    } catch {
      failReady(new Error(`${name} emitted malformed readiness`));
      void terminateOnce();
    }
  });
  child.once("error", (error) => failReady(new Error(`${name} could not start`, { cause: error })));
  void exit.then(({ status }) => {
    failReady(new Error(`${name} exited with status ${String(status)} before readiness`));
  });

  const timer = setTimeout(() => {
    failReady(new Error(`${name} exceeded its readiness deadline`));
    void terminateOnce();
  }, startupTimeoutMs);
  const abort = () => {
    failReady(options.signal?.reason ?? new Error(`${name} was interrupted`));
    void terminateOnce();
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const port = await ready;
    return {
      name,
      child,
      port,
      exit,
      output: () => ({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), overflow })
    };
  } catch (error) {
    await terminateOnce();
    throw error;
  } finally {
    clearTimeout(timer);
    if (child.exitCode !== null || child.signalCode !== null) {
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

export async function waitForOwnedChild(worker, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      worker.exit,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${worker.name} exceeded its exit deadline`)),
          timeoutMs
        );
      })
    ]);
    const { overflow } = worker.output();
    if (overflow) throw overflow;
    if (result.status !== 0) {
      throw new Error(`${worker.name} exited with status ${String(result.status)}`);
    }
  } catch (error) {
    await terminateOwnedChild(worker.child);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runBoundedCommand(name, commandSpec, timeoutMs, outputLimitBytes, signal) {
  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd: commandSpec.cwd,
    env: commandSpec.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let outputBytes = 0;
  let failure;
  const append = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > outputLimitBytes && !failure) {
      failure = new Error(`${name} exceeded its output limit`);
      void terminateOwnedChild(child);
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    failure ??= new Error(`${name} could not start`, { cause: error });
  });
  const exit = closed(child);
  const timer = setTimeout(() => {
    failure = new Error(`${name} exceeded its deadline`);
    void terminateOwnedChild(child);
  }, timeoutMs);
  const abort = () => {
    failure ??= signal?.reason ?? new Error(`${name} was interrupted`);
    void terminateOwnedChild(child);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  await exit;
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  if (failure) throw failure;
  if (child.exitCode !== 0) throw new Error(`${name} exited with status ${String(child.exitCode)}`);
}

function argumentsFrom(argv, environment) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined)
      throw new Error("arguments must be --name value pairs");
    values.set(name, value);
  }
  const options = {
    apiUrl: values.get("--api-url") ?? environment.WAYSCRIBE_URL,
    apiKey: values.get("--api-key") ?? environment.WAYSCRIBE_API_KEY,
    environment: values.get("--environment") ?? environment.WAYSCRIBE_ENVIRONMENT,
    python: values.get("--python") ?? environment.WAYSCRIBE_PYTHON ?? "python3"
  };
  if (!options.apiUrl || !options.apiKey || !options.environment) {
    throw new Error(
      "provide --api-url, --api-key and --environment (or their WAYSCRIBE equivalents)"
    );
  }
  return options;
}

export async function runMixedLanguage(options) {
  const total = new globalThis.AbortController();
  const totalTimer = setTimeout(
    () => total.abort(new Error("mixed-language run exceeded its total deadline")),
    options.totalTimeoutMs ?? 30_000
  );
  const children = [];
  let buildDirectory;
  const externalAbort = () =>
    total.abort(options.signal?.reason ?? new Error("mixed-language run interrupted"));
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  try {
    buildDirectory = await mkdtemp(join(tmpdir(), "wayscribe-mixed-go-"));
    const binary = join(buildDirectory, "go-worker");
    const goEnvironment = {
      ...process.env,
      GOTOOLCHAIN: "local",
      GOWORK: "off",
      GOPROXY: "off",
      GOSUMDB: "off"
    };
    await runBoundedCommand(
      "Go worker build",
      {
        command: "go",
        args: ["build", "-trimpath", "-o", binary, "./go-worker.go"],
        cwd: here,
        env: goEnvironment
      },
      15_000,
      DEFAULT_OUTPUT_LIMIT,
      total.signal
    );
    if (total.signal.aborted) throw total.signal.reason;

    const sdkEnvironment = {
      ...process.env,
      WAYSCRIBE_ENDPOINT: options.apiUrl,
      WAYSCRIBE_API_KEY: options.apiKey,
      WAYSCRIBE_ENVIRONMENT: options.environment
    };
    const go = await startOwnedWorker(
      "Go worker",
      { command: binary, cwd: here, env: sdkEnvironment },
      { startupTimeoutMs: 5_000, outputLimitBytes: DEFAULT_OUTPUT_LIMIT, signal: total.signal }
    );
    children.push(go);
    const goUrl = `http://127.0.0.1:${String(go.port)}/`;
    const pythonEnvironment = { ...sdkEnvironment, GO_WORKER_URL: goUrl };
    delete pythonEnvironment.PYTHONPATH;
    const python = await startOwnedWorker(
      "Python worker",
      {
        command: options.python,
        args: [join(here, "python-worker.py")],
        cwd: here,
        env: pythonEnvironment
      },
      { startupTimeoutMs: 5_000, outputLimitBytes: DEFAULT_OUTPUT_LIMIT, signal: total.signal }
    );
    children.push(python);

    const { runNodeEntry } = await import("./node-entry.mjs");
    const summary = await runNodeEntry({
      apiUrl: options.apiUrl,
      apiKey: options.apiKey,
      environment: options.environment,
      pythonUrl: `http://127.0.0.1:${String(python.port)}/`,
      signal: total.signal
    });
    await Promise.all([waitForOwnedChild(python, 5_000), waitForOwnedChild(go, 5_000)]);
    return summary;
  } finally {
    clearTimeout(totalTimer);
    options.signal?.removeEventListener("abort", externalAbort);
    await Promise.allSettled(children.map((worker) => terminateOwnedChild(worker.child)));
    if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const abort = new globalThis.AbortController();
  const interrupt = () => abort.abort(new Error("mixed-language run interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const options = argumentsFrom(process.argv.slice(2), process.env);
    const result = await runMixedLanguage({ ...options, signal: abort.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "mixed-language run failed"}\n`
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
