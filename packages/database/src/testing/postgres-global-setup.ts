import type { TestProject } from "vitest/node";
import { startContainer } from "./postgres.js";

/**
 * Starts the integration suite's one PostgreSQL server before any file runs,
 * hands its URL to the files as `postgresServerUri`, and stops it after the
 * last. `postgres.ts` says why there is one server and how files share it.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await startContainer(project.getProvidedContext().postgresImage);
  project.provide("postgresServerUri", container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
