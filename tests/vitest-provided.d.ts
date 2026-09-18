// What vitest.integration.config.ts hands the integration tests through
// `provide`, so `inject("postgresImage")` is typed. Included by the tsconfig of
// every package with integration tests; their build configs leave it out.
import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The PostgreSQL major version under test, from TEST_POSTGRES_VERSION. */
    postgresVersion: string;
    /** The image Testcontainers starts, `postgres:<version>-alpine`. */
    postgresImage: string;
    /**
     * The run's shared server, as a superuser URL, set by
     * packages/database/src/testing/postgres-global-setup.ts.
     */
    postgresServerUri: string;
  }
}
