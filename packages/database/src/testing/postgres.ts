import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { inject } from "vitest";

/**
 * PostgreSQL for the integration suite: one server for the whole run, and a
 * fresh, empty database on it for each test file.
 *
 * Every file used to start a container of its own, 60 starts a run. On a busy
 * machine one of them would fail now and then with "Timed out after 10000ms
 * while waiting for container ports to be bound to the host", a different
 * file each time. That 10 seconds is fixed inside Testcontainers
 * (`inspectContainerUntilPortsExposed`), and neither `withStartupTimeout` nor
 * any setting reaches it. So the suite starts one server
 * (`postgres-global-setup.ts`), with a longer startup timeout and up to three
 * attempts, and each file asks it for a database of its own.
 *
 * A database made with CREATE DATABASE from `template1`, as here, is what the
 * server a container starts with holds: no tables, no migrations, the same
 * encoding and locale. Each file migrates it, exactly as it migrated its own
 * container, and `stop()` drops it WITH (FORCE), which also ends any
 * connection the file left open. The integration config runs one file at a
 * time, so no two files share the server at once.
 *
 * What a database cannot hold is shared across the server: roles, and other
 * databases. A file that creates either gets a server of its own
 * (`startPostgres({ dedicated: true })`), so that nothing it makes can meet
 * another file: `doctor`, `migration-status`, `key-warnings` and
 * `statement-timeout` do.
 */

/** How long a container may take to report ready, once its ports are bound. */
export const STARTUP_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;

/** What the tests use of a server: a connection URL, and the call that ends it. */
export interface TestDatabase {
  getConnectionUri(): string;
  stop(): Promise<void>;
}

/**
 * A PostgreSQL container, retried when it fails to start. `configure` applies
 * any setting the caller needs, such as a password, to each attempt.
 */
export async function startContainer(
  image: string,
  configure: (container: PostgreSqlContainer) => PostgreSqlContainer = (container) => container
): Promise<StartedPostgreSqlContainer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await configure(new PostgreSqlContainer(image))
        .withStartupTimeout(STARTUP_TIMEOUT_MS)
        .start();
    } catch (error) {
      // A container that failed to start is removed by Testcontainers' reaper
      // when the run ends.
      lastError = error;
      console.warn(
        `PostgreSQL container attempt ${String(attempt)} of ${String(ATTEMPTS)} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw lastError;
}

/**
 * A fresh, empty database for one test file, on the run's shared server, or
 * a server of its own when `dedicated` is set.
 */
export async function startPostgres(options: { dedicated?: boolean } = {}): Promise<TestDatabase> {
  if (options.dedicated === true) {
    const container = await startContainer(inject("postgresImage"));
    return {
      getConnectionUri: () => container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      }
    };
  }

  const server = inject("postgresServerUri");
  const name = `test_${randomBytes(8).toString("hex")}`;
  await onServer(server, `create database ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const uri = url.toString();
  let dropped = false;
  return {
    getConnectionUri: () => uri,
    stop: async () => {
      if (dropped) return;
      dropped = true;
      await onServer(server, `drop database if exists ${name} with (force)`);
    }
  };
}

async function onServer(uri: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: uri });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
