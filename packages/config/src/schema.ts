import { z } from "zod";

/**
 * A master key, with surrounding whitespace removed before anything measures it.
 *
 * Secrets files and `kubectl create secret --from-file` commonly carry a
 * trailing newline. Kept, it changes the key's fingerprint, so the same key in
 * both variables would pass the keyring's same-key check, and a key one
 * character short would pass the length check.
 */
const encryptionKey = z.string().trim().min(32);

const encryptionKeys = {
  ENCRYPTION_KEY: encryptionKey,
  // Set only during a rotation's grace period. Blank counts as unset: Compose
  // passes an unset variable through as an empty string, and that means "no
  // rotation", not "a key too short to use".
  ENCRYPTION_KEY_PREVIOUS: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    encryptionKey.optional()
  )
};

export const encryptionKeysSchema = z.object(encryptionKeys);

/** Blank counts as unset, for the reason given at ENCRYPTION_KEY_PREVIOUS. */
const blankAsUnset = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/**
 * PostgreSQL stores statement_timeout as a 32-bit count of milliseconds, so a
 * larger value would be refused by the database on the first connection rather
 * than here, where the message can name the variable.
 */
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

/** More hops than any real deployment has; a larger value is a typo. */
const MAX_TRUSTED_PROXIES = 10;

const statementTimeout = {
  // Every statement the API's pool runs is cancelled after this long, so one
  // slow search cannot hold a connection that ingestion needs. 0 disables it.
  DATABASE_STATEMENT_TIMEOUT_MS: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(0).max(MAX_STATEMENT_TIMEOUT_MS).default(15_000)
  )
};

export const statementTimeoutSchema = z.object(statementTimeout);

export type EncryptionKeys = z.infer<typeof encryptionKeysSchema>;

export const serverEnvSchema = z
  .object({
    // Named rather than left to "Invalid URL": Wayscribe expects you to
    // bring your own database, so an unset value is the most likely mistake and
    // the message has to say what to do about it.
    DATABASE_URL: z.url({
      protocol: /^postgres(ql)?$/,
      error: (issue) =>
        issue.input === undefined || issue.input === ""
          ? "not set. Point it at your PostgreSQL database, or add " +
            "`-f compose.bundled.yaml` to run one alongside."
          : "must be a postgresql:// URL."
    }),
    APP_URL: z.url(),
    API_URL: z.url(),
    ...encryptionKeys,
    // Trimmed for the reason ENCRYPTION_KEY is: a token read from a file, or
    // pasted, commonly carries a trailing newline or a leading byte-order mark.
    // Kept, it would make a token the API compares against the Authorization
    // header, and the web app signs sessions with, that nobody could type at
    // the login form, with nothing said about why. apps/web/src/lib/config.ts
    // trims it the same way, and the two have to stay identical.
    ADMIN_TOKEN: z.string().trim().min(32),
    DEFAULT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    MAX_EVENT_PAYLOAD_BYTES: z.coerce.number().int().positive().default(262_144),
    ALLOW_FULL_PAYLOAD_CAPTURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    REPLAY_ALLOWED_HOSTS: z
      .string()
      .transform((value) =>
        value
          .split(",")
          .map((host) => host.trim())
          .filter((host) => host.length > 0)
      )
      .pipe(z.array(z.string()).min(1)),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    // How many reverse proxies in front of the API append to X-Forwarded-For.
    // 0 keys a client on its socket address and ignores the header, which any
    // client can set; the authentication throttle keys on the result.
    TRUSTED_PROXY_COUNT: z.preprocess(
      blankAsUnset,
      z.coerce.number().int().min(0).max(MAX_TRUSTED_PROXIES).default(0)
    ),
    ...statementTimeout,
    // Unset means no metrics listener at all. A separate port rather than a path
    // on PORT, so exposing ingestion never exposes metrics by accident (ADR-047).
    METRICS_PORT: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(65_535).optional())
  })
  .refine((env) => env.METRICS_PORT === undefined || env.METRICS_PORT !== env.PORT, {
    path: ["METRICS_PORT"],
    message: "must differ from PORT. Metrics are served on their own port, never beside ingestion."
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;
