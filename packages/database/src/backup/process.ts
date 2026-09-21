import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { BackupError } from "./connection.js";

export class Deadline {
  readonly expiresAt: number;
  constructor(
    timeoutMs: number,
    readonly signal?: AbortSignal
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
      throw new BackupError("invalid_arguments");
    this.expiresAt = Date.now() + timeoutMs;
  }
  remaining(): number {
    if (this.signal?.aborted) throw new BackupError("aborted");
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0) throw new BackupError("timeout");
    return remaining;
  }
  watch(stop: (error: BackupError) => void): () => void {
    let remaining: number;
    try {
      remaining = this.remaining();
    } catch (error) {
      stop(error as BackupError);
      return () => undefined;
    }
    const timer = setTimeout(() => {
      stop(new BackupError("timeout"));
    }, remaining);
    const abort = (): void => {
      stop(new BackupError("aborted"));
    };
    this.signal?.addEventListener("abort", abort, { once: true });
    return () => {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
    };
  }
  async wait<T>(promise: Promise<T>, cancel: () => void = () => undefined): Promise<T> {
    let unwatch = (): void => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      unwatch = this.watch((error) => {
        cancel();
        reject(error);
      });
    });
    try {
      return await Promise.race([promise, stopped]);
    } finally {
      unwatch();
    }
  }
}
export interface ChildOptions {
  env: NodeJS.ProcessEnv;
  deadline: Deadline;
  inputFd?: number;
  outputFd?: number;
  captureOutput?: boolean;
}
/** No shell, bounded output, and a single TERM/KILL sequence followed by reaping. */
export async function runChild(
  executable: string,
  args: readonly string[],
  options: ChildOptions
): Promise<string> {
  options.deadline.remaining();
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], {
      env: options.env,
      stdio: [
        options.inputFd ?? "ignore",
        options.outputFd ?? (options.captureOutput ? "pipe" : "ignore"),
        "pipe"
      ],
      shell: false
    });
    let failure: BackupError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let output = Buffer.alloc(0);
    const terminate = (error: BackupError): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 200);
    };
    const unwatch = options.deadline.watch(terminate);
    // Discard diagnostics immediately. They can contain recorded payloads and identifiers.
    child.stderr?.on("data", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (output.length + chunk.length > 4096) {
        terminate(new BackupError("tool_failed"));
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.on("error", () => {
      failure ??= new BackupError("tool_unavailable");
    });
    child.on("close", (code) => {
      unwatch();
      if (escalation) clearTimeout(escalation);
      if (failure) reject(failure);
      else if (code !== 0) reject(new BackupError("tool_failed"));
      else resolveResult(output.toString("utf8"));
    });
  });
}
export async function resolveTool(
  name: "pg_dump" | "pg_restore",
  env: NodeJS.ProcessEnv,
  deadline: Deadline
): Promise<string> {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    deadline.remaining();
    const path = resolve(directory, name);
    try {
      await access(path, constants.X_OK);
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue;
    }
    // eslint-disable-next-line no-restricted-syntax -- PostgreSQL tool switches, not Wayscribe CLI flags.
    const version = await runChild(path, ["--version"], { env, deadline, captureOutput: true });
    const major = Number(new RegExp(`^${name} \\(PostgreSQL\\) (\\d+)`).exec(version)?.[1]);
    if (!Number.isInteger(major) || major < 18) throw new BackupError("tool_version");
    return path;
  }
  throw new BackupError("tool_unavailable");
}
