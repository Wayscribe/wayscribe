/** The parts of a `spawnSync` result that say whether the program ran and how it ended. */
export type SpawnOutcome = {
  error?: (Error & { code?: string }) | undefined;
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr?: string | null | undefined;
};

const STDERR_TAIL = 2000;

/**
 * Why a spawned program failed, as a sentence, or undefined when it exited
 * cleanly. A program that never started (not installed) or was killed has no
 * stderr to show, so those are named first; only a program that ran and exited
 * non-zero gets the tail of its stderr.
 */
export function spawnFailure(
  command: string,
  args: readonly string[],
  result: SpawnOutcome
): string | undefined {
  if (result.error !== undefined) {
    if (result.error.code === "ENOENT") {
      // A bare name is looked up on PATH; a path (an FFMPEG override) is simply not there.
      return /[\\/]/.test(command) ? `${command} not found.` : `${command} not found on PATH.`;
    }
    return `${command} could not run: ${result.error.message}`;
  }
  if (result.signal !== null) return `${command} was killed by ${result.signal}.`;
  if (result.status === null) return `${command} ended without an exit status.`;
  if (result.status === 0) return undefined;
  const stderr = (result.stderr ?? "").slice(-STDERR_TAIL);
  return `${[command, ...args].join(" ")} exited with status ${String(result.status)}:\n${stderr === "" ? "(no output)" : stderr}`;
}
