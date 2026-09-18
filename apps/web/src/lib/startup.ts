import { loadWebConfig } from "./config";

/** What the startup check does to the process; the process itself unless a test says otherwise. */
export interface StartupHost {
  exit: (code: number) => void;
  error: (message: string) => void;
}

const processHost: StartupHost = {
  exit: (code) => process.exit(code),
  error: (message) => {
    console.error(message);
  }
};

/**
 * Load the configuration once, before the server takes a request, and stop the
 * process with the specific message when it does not load.
 *
 * Called from `instrumentation-node.ts`, which Next runs once when the server
 * starts. Without it nothing loaded the configuration until a request needed
 * it, and every way of reaching it first caught the error: the auth gate read a
 * misconfigured token as "not signed in" and redirected to the login page,
 * which reads no configuration and rendered. So a container given both
 * `ADMIN_TOKEN` and `ADMIN_TOKEN_FILE`, or a file that is not there, started,
 * was reported healthy, and answered the first sign-in with a 500 (F-030). The
 * API refuses to start on the same mistakes, and now this app does too.
 *
 * Writes the message alone, with no stack: the message names the setting and
 * never its value, and a stack of minified chunk names says nothing an
 * operator can act on. Returns whether the process may go on, for a host
 * whose `exit` returns.
 */
export function refuseToStartMisconfigured(
  source: Record<string, string | undefined>,
  host: StartupHost = processHost
): boolean {
  try {
    loadWebConfig(source);
    return true;
  } catch (error) {
    host.error(error instanceof Error ? error.message : String(error));
    host.exit(1);
    return false;
  }
}
