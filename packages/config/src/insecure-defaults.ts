/**
 * Secrets that ship in the repository so `docker compose up` works with nothing
 * configured.
 *
 * They are published, so anyone can read them. A stack running on one of these
 * has an admin token that grants project-wide read of every recorded payload to
 * whoever knows the value — which is everyone.
 *
 * They exist because the alternative is a demo that cannot start, and a tool
 * nobody can run teaches nobody anything. What is not acceptable is running on
 * them *silently*, which is what happened before: `.env` was documented but
 * never loaded, so an operator who followed the setup believed they had
 * configured secrets and had not.
 */
/** The API key `infrastructure/compose.demo.yaml` commits for the demo services. */
export const PUBLISHED_DEMO_API_KEY = "wsk_demo0000000000000000000000000000";

const PUBLISHED_DEFAULTS = new Set([
  "replace-for-local-development-0000",
  "local-admin-token-000000000000000",
  PUBLISHED_DEMO_API_KEY
]);

export interface InsecureDefault {
  variable: string;
  message: string;
}

/**
 * Which configured secrets are published values.
 *
 * Returns findings rather than throwing or logging: the caller owns the
 * decision about how loudly to complain, and a library that writes to stderr on
 * import is a library that cannot be tested.
 */
export function findInsecureDefaults(env: Record<string, string | undefined>): InsecureDefault[] {
  const findings: InsecureDefault[] = [];

  for (const variable of ["ENCRYPTION_KEY", "ENCRYPTION_KEY_PREVIOUS", "ADMIN_TOKEN"]) {
    // Trimmed before comparing. The configuration trims the two keys, so a
    // trailing newline there does not hide a published value that is in use.
    // It does not trim ADMIN_TOKEN, but a published token with stray whitespace
    // around it is no more secret, so that is flagged as well.
    const value = env[variable]?.trim();
    if (value !== undefined && PUBLISHED_DEFAULTS.has(value)) {
      findings.push({
        variable,
        message:
          variable === "ENCRYPTION_KEY_PREVIOUS"
            ? // The generic advice would replace the key the stored data is
              // still under, which makes that data unreadable.
              "ENCRYPTION_KEY_PREVIOUS, the key being rotated out, is a published development default, so data still under it is readable by anyone. " +
              "Do not replace it: finish rotate:reencrypt, then remove it (docs/OPERATIONS.md §6)."
            : `${variable} is a published development default. Anyone can read it. Set your own before this stack holds anything real: openssl rand -hex 32`
      });
    }
  }

  return findings;
}
