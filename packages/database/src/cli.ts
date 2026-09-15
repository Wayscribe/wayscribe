import type { Keyring } from "@flight-recorder/payload-security";
import knex from "knex";
import { createKnexConfig } from "./knex-config.js";

const command = process.argv[2];
// pnpm forwards a literal `--` separator through to the script when a run is
// filtered to one package, so it arrives as an argument rather than as syntax.
const args = process.argv.slice(3).filter((argument) => argument !== "--");
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl === "") {
  console.error(
    "DATABASE_URL is not set. Point it at your PostgreSQL database, or add " +
      "`-f compose.bundled.yaml` to run one alongside."
  );
  process.exit(1);
}

const db = knex(createKnexConfig(databaseUrl));

/** DEFAULT_RETENTION_DAYS, applied to any environment these commands create. */
const retentionDays = Number.parseInt(process.env["DEFAULT_RETENTION_DAYS"] ?? "7", 10);
const defaultRetentionDays =
  Number.isInteger(retentionDays) && retentionDays > 0 ? retentionDays : 7;

/**
 * The keyring from ENCRYPTION_KEY and ENCRYPTION_KEY_PREVIOUS, or undefined with
 * a failing exit code and the reason printed.
 *
 * Read the way the API reads them, so a key this CLI issues during a rotation
 * verifies against the API running beside it.
 */
async function requireKeyring(): Promise<Keyring | undefined> {
  const { keyringFromEnvironment } = await import("./keyring-env.js");
  try {
    return keyringFromEnvironment(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return undefined;
  }
}

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
      const keyring = await requireKeyring();
      if (keyring === undefined) break;
      const { seedLocal } = await import("./seed-local.js");
      const result = await seedLocal(db, keyring, defaultRetentionDays);
      console.log("Local seed applied.");
      console.log(`  project:     ${result.projectId}`);
      console.log(`  environment: ${result.environmentId}`);
      console.log("");
      console.log("  API key (shown once, not recoverable):");
      console.log(`    ${result.apiKey}`);
      break;
    }
    case "seed-demo": {
      const keyring = await requireKeyring();
      if (keyring === undefined) break;
      const apiKey = process.env["DEMO_API_KEY"];
      if (apiKey === undefined || apiKey === "") {
        console.error("DEMO_API_KEY is not set.");
        process.exitCode = 1;
        break;
      }
      const { seedDemo } = await import("./seed-demo.js");
      const result = await seedDemo(db, keyring, apiKey, defaultRetentionDays);
      console.log(`Demo seed applied for project ${result.projectId} (${result.keyPrefix}).`);
      break;
    }
    case "project:create": {
      const [slug, ...nameParts] = args;
      const name = nameParts.join(" ");
      if (slug === undefined || name === "") {
        console.error(
          'Usage: project:create <slug> <name>    e.g. project:create acme "Acme Payments"'
        );
        process.exitCode = 1;
        break;
      }

      const { createProject, ProjectAdminError } = await import("./repositories/project-admin.js");
      try {
        const project = await createProject(db, { slug, name });
        console.log(`Created project ${project.name} (${project.slug}).`);
        console.log("");
        console.log("  Issue a key for it with:");
        console.log(`    key:create ${project.slug} production ${project.slug}-worker`);
      } catch (error) {
        if (!(error instanceof ProjectAdminError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
      break;
    }
    case "project:list": {
      const { listProjects } = await import("./repositories/project-admin.js");
      const projects = await listProjects(db);
      if (projects.length === 0) {
        console.log("No projects yet. Create one with: project:create <slug> <name>");
        break;
      }
      console.log("SLUG".padEnd(24) + "NAME");
      for (const project of projects) console.log(project.slug.padEnd(24) + project.name);
      break;
    }
    case "key:create": {
      const keyring = await requireKeyring();
      if (keyring === undefined) break;

      const [projectSlug, environmentName, name] = args;
      if (projectSlug === undefined || environmentName === undefined) {
        console.error("Usage: key:create <project-slug> <environment> [name]");
        process.exitCode = 1;
        break;
      }

      const { issueKey, KeyAdminError } = await import("./repositories/key-admin.js");
      try {
        const issued = await issueKey(db, keyring, {
          projectSlug,
          environmentName,
          name: name ?? `${environmentName}-key`,
          retentionDays: defaultRetentionDays
        });
        console.log(`Key issued for ${issued.projectSlug}/${issued.environmentName}.`);
        console.log("");
        console.log("  API key (shown once, not recoverable):");
        console.log(`    ${issued.apiKey}`);
        console.log("");
        console.log(`  prefix: ${issued.keyPrefix}`);
      } catch (error) {
        if (!(error instanceof KeyAdminError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
      break;
    }
    case "key:revoke": {
      const keyPrefix = args[0];
      if (keyPrefix === undefined) {
        console.error("Usage: key:revoke <key-prefix>    (see `key:list`)");
        process.exitCode = 1;
        break;
      }

      const { revokeKey, KeyAdminError } = await import("./repositories/key-admin.js");
      try {
        const revoked = await revokeKey(db, keyPrefix);
        console.log(
          `Revoked ${revoked.keyPrefix} (${revoked.name}) on ${revoked.projectSlug}/${revoked.environmentName}.`
        );
        console.log("Requests presenting it are refused from now on.");
      } catch (error) {
        if (!(error instanceof KeyAdminError)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
      break;
    }
    case "key:list": {
      const { listKeys } = await import("./repositories/key-admin.js");
      const keys = await listKeys(db, args[0]);
      if (keys.length === 0) {
        console.log("No API keys. Create one with `key:create <project-slug> <environment>`.");
        break;
      }
      console.log("PREFIX        PROJECT/ENVIRONMENT            NAME                 LAST USED");
      for (const key of keys) {
        const scope = `${key.projectSlug}/${key.environmentName}`;
        const used = key.lastUsedAt?.toISOString().slice(0, 19).replace("T", " ") ?? "never";
        const state = key.revokedAt === null ? "" : "  [REVOKED]";
        console.log(`${key.keyPrefix}  ${scope.padEnd(30)} ${key.name.padEnd(20)} ${used}${state}`);
      }
      break;
    }
    case "retention:sweep": {
      const { sweepExpiredJourneys } = await import("./repositories/retention.js");
      const result = await sweepExpiredJourneys(db);
      console.log(
        result.ran
          ? `Deleted ${String(result.journeysDeleted)} journeys in ${String(result.batches)} batches across ${String(result.environmentsExamined)} environments.`
          : "Another process holds the retention lock; nothing was examined."
      );
      break;
    }
    case "rotate:reencrypt": {
      const keyring = await requireKeyring();
      if (keyring === undefined) break;

      const { reencryptValues } = await import("./repositories/rotation.js");
      const report = await import("./rotation-report.js");
      if (keyring.previous === null) {
        console.error(report.NO_PREVIOUS_KEY_MESSAGE);
        process.exitCode = 1;
        break;
      }

      console.log(report.formatReencryptStart(keyring.current.id, keyring.previous.id));
      const result = await reencryptValues(db, keyring, {
        onBatch: (progress) => {
          console.log(report.formatReencryptProgress(progress));
        }
      });
      if (!result.ran) {
        // An operator scripting the rotation needs to know nothing was done.
        console.error(
          result.reason === "lock_held" ? report.LOCK_HELD_MESSAGE : report.NO_PREVIOUS_KEY_MESSAGE
        );
        process.exitCode = 1;
        break;
      }
      for (const line of report.formatReencryption(result.tables)) console.log(line);
      break;
    }
    case "rotate:status": {
      const keyring = await requireKeyring();
      if (keyring === undefined) break;

      const { rotationStatus } = await import("./repositories/rotation.js");
      const { formatRotationStatus } = await import("./rotation-report.js");
      const status = await rotationStatus(db, keyring);
      for (const line of formatRotationStatus(status)) console.log(line);
      // So a script can wait on it: 0 once nothing is left under another key.
      if (!status.complete) process.exitCode = 1;
      break;
    }
    default: {
      console.error(`Unknown command: ${command ?? "(none)"}`);
      console.error(
        "Usage: tsx src/cli.ts <migrate|rollback|seed|seed-demo|project:create|project:list|key:create|key:revoke|key:list|retention:sweep|rotate:reencrypt|rotate:status>"
      );
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await db.destroy();
}
