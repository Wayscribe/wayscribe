/**
 * What every event says about what recorded it: `runtime.language`,
 * `runtime.version` and `runtime.sdk` (F-046, ADR-063 decision 1).
 *
 * Read once, when a recorder is created, and frozen, as `deployment` is, so an
 * event carries it as one property and recording costs nothing more. Nothing
 * comes from the host's settings or environment: the SDK's version and commit
 * are constants baked into the bundle by `scripts/bundle-options.mjs`, and the
 * Node version is the process's own. `hostname` and `processId`, which the
 * protocol also has, are not sent: a hostname is a new identifier on every
 * event, often a person's name on a laptop, and nothing here needs it.
 */

/** Replaced by esbuild's `define` in a built bundle; undeclared when run from source. */
declare const __WAYSCRIBE_SDK_VERSION__: string | undefined;
declare const __WAYSCRIBE_SDK_COMMIT__: string | undefined;

export const SDK_NAME = "@wayscribe/node";

/** The version run from source, where nothing is baked in. Cannot be mistaken for a release. */
export const DEVELOPMENT_VERSION = "0.0.0-development";

/** The protocol's limit on `runtime.version`. */
const MAX_RUNTIME_VERSION_LENGTH = 64;

export interface EventRuntime {
  language: "node";
  version?: string;
  sdk: { name: string; version: string; commit?: string };
}

const SDK: Readonly<EventRuntime["sdk"]> = Object.freeze({
  name: SDK_NAME,
  version:
    typeof __WAYSCRIBE_SDK_VERSION__ === "string" ? __WAYSCRIBE_SDK_VERSION__ : DEVELOPMENT_VERSION,
  ...(typeof __WAYSCRIBE_SDK_COMMIT__ === "string" && __WAYSCRIBE_SDK_COMMIT__ !== ""
    ? { commit: __WAYSCRIBE_SDK_COMMIT__ }
    : {})
});

/** The runtime every event of a recorder carries. Never throws. */
export function readRuntime(): Readonly<EventRuntime> {
  return Object.freeze({
    language: "node",
    ...nodeVersion(),
    sdk: SDK
  });
}

/**
 * `process.versions.node`, or nothing if it cannot be read or would not fit
 * the protocol: a host can replace `process.versions`, and an event is worth
 * more than its Node version.
 */
function nodeVersion(): { version?: string } {
  try {
    const version: unknown = process.versions.node;
    return typeof version === "string" &&
      version !== "" &&
      version.length <= MAX_RUNTIME_VERSION_LENGTH
      ? { version }
      : {};
  } catch {
    return {};
  }
}
