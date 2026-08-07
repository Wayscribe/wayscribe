import { z } from "zod";

export const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  APP_URL: z.url(),
  API_URL: z.url(),
  ENCRYPTION_KEY: z.string().min(32),
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
