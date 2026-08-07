import knex from "knex";
import { createKnexConfig } from "./knex-config.js";

const command = process.argv[2];
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const db = knex(createKnexConfig(databaseUrl));

try {
  switch (command) {
    case "migrate": {
      const [batch, applied] = (await db.migrate.latest()) as [number, string[]];
      console.log(
        applied.length === 0
          ? "Already up to date."
          : `Batch ${String(batch)} applied:\n${applied.map((name) => `  ${name}`).join("\n")}`
      );
      break;
    }
    case "rollback": {
      const [batch, reverted] = (await db.migrate.rollback()) as [number, string[]];
      console.log(
        reverted.length === 0
          ? "Nothing to roll back."
          : `Batch ${String(batch)} rolled back:\n${reverted.map((name) => `  ${name}`).join("\n")}`
      );
      break;
    }
    case "seed": {
      const masterKey = process.env["ENCRYPTION_KEY"];
      if (masterKey === undefined || masterKey === "") {
        console.error("ENCRYPTION_KEY is not set.");
        process.exitCode = 1;
        break;
      }
      const { seedLocal } = await import("./seed-local.js");
      const result = await seedLocal(db, masterKey);
      console.log("Local seed applied.");
      console.log(`  project:     ${result.projectId}`);
      console.log(`  environment: ${result.environmentId}`);
      console.log("");
      console.log("  API key (shown once, not recoverable):");
      console.log(`    ${result.apiKey}`);
      break;
    }
    default: {
      console.error(`Unknown command: ${command ?? "(none)"}`);
      console.error("Usage: tsx src/cli.ts <migrate|rollback|seed>");
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await db.destroy();
}
