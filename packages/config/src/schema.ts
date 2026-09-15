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

export type EncryptionKeys = z.infer<typeof encryptionKeysSchema>;

export const serverEnvSchema = z.object({
  // Named rather than left to "Invalid URL": Flight Recorder expects you to
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
  ADMIN_TOKEN: z.string().min(32),
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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
