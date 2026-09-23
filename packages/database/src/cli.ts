import type { Keyring } from "@wayscribe/payload-security";
import knex from "knex";
import { commandUsage, preflight, type CommandName } from "./cli-commands.js";
import { createKnexConfig } from "./knex-config.js";

const given = process.argv[2];

// Help, an unknown command, and a flag on a command that takes none are
// answered before DATABASE_URL is read: none of them needs a database.
// preflight also takes out the `--` separators pnpm forwards; see there.
const early = preflight(given, process.argv.slice(3));
if (!early.run) {
  for (const line of early.stdout) console.log(line);
  for (const line of early.stderr) console.error(line);
  process.exitCode = early.code;
} else {
  await run(early.command, early.args);
}

async function run(command: CommandName, args: readonly string[]): Promise<void> {
  if (command === "backup:create" || command === "backup:restore" || command === "backup:verify") {
    const { runBackupCommand } = await import("./backup/command.js");
    process.exitCode = await runBackupCommand(command, args, {
      databaseUrl: process.env["DATABASE_URL"] ?? "",
      env: process.env,
      stdout: (line) => {
        console.log(line);
      },
      stderr: (line) => {
        console.error(line);
      }
    });
    return;
  }
  const databaseUrl = process.env["DATABASE_URL"];

  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "DATABASE_URL is not set. Point it at your PostgreSQL database, or add " +
        "`-f compose.bundled.yaml` to run one alongside."
    );
    process.exitCode = 1;
    return;
  }

  // doctor exists to report an unreachable database, so it gives up on a
  // connection after ten seconds rather than knex's sixty, and says so in its
  // own words rather than under knex's warning.
  const db = knex(
    createKnexConfig(
      databaseUrl,
      command === "doctor" ? { acquireConnectionTimeoutMs: 10_000, quiet: true } : {}
    )
  );

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

  /** Apply the local seed and print what it created, for `seed` and `reset`. */
  async function seed(keyring: Keyring): Promise<void> {
    const { seedLocal } = await import("./seed-local.js");
    const result = await seedLocal(db, keyring, defaultRetentionDays);
    console.log("Local seed applied.");
    console.log(`  project:     ${result.projectId}`);
    console.log(`  environment: ${result.environmentId}`);
    console.log("");
    console.log("  API key (shown once, not recoverable):");
    console.log(`    ${result.apiKey}`);
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
      case "migrate:unlock": {
        // For a lock nothing holds any more. A migration that runs outside a
        // transaction (013 builds its indexes concurrently) takes knex's lock in
        // a transaction that commits at once, so a migrate killed mid-build
        // leaves the lock set and every later migrate refuses with "locked".
        // Run this only when no migrate is running: it does not check.
        await db.migrate.forceFreeMigrationsLock();
        console.log("Migration lock released. Run migrate again.");
        break;
      }
      case "seed": {
        const keyring = await requireKeyring();
        if (keyring === undefined) break;
        await seed(keyring);
        break;
      }
      case "reset": {
        // Checked before anything is dropped, the keyring included: a reset
        // that wiped the schema and then could not seed would leave less than
        // it found.
        const { parseResetArgs } = await import("./reset.js");
        const parsed = parseResetArgs(args, process.env, databaseUrl);
        if (!parsed.ok) {
          console.error(parsed.message);
          process.exitCode = 1;
          break;
        }
        const keyring = await requireKeyring();
        if (keyring === undefined) break;

        // `all`: every batch, not only the last. Migration 019 drops its
        // indexes concurrently on connections of its own, which is why this
        // runs through knex's migrator rather than a DROP SCHEMA.
        const [, reverted] = (await db.migrate.rollback({}, true)) as [number, string[]];
        console.log(
          reverted.length === 0
            ? "Nothing to roll back."
            : `Rolled back ${String(reverted.length)} migrations.`
        );
        const [, applied] = (await db.migrate.latest()) as [number, string[]];
        console.log(`Applied ${String(applied.length)} migrations.`);
        await seed(keyring);
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
          console.error(commandUsage("project:create"));
          process.exitCode = 1;
          break;
        }

        const { createProject, ProjectAdminError } =
          await import("./repositories/project-admin.js");
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

        const { formatIssuedKey, parseKeyCreateArgs } = await import("./key-create.js");
        const parsed = parseKeyCreateArgs(args);
        if (!parsed.ok) {
          console.error(parsed.message);
          process.exitCode = 1;
          break;
        }

        const { issueKey, KeyAdminError } = await import("./repositories/key-admin.js");
        try {
          const issued = await issueKey(db, keyring, {
            projectSlug: parsed.projectSlug,
            environmentName: parsed.environmentName,
            name: parsed.name,
            retentionDays: defaultRetentionDays
          });
          for (const line of formatIssuedKey(issued, parsed.json)) console.log(line);
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
          console.error(commandUsage("key:revoke"));
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
          console.log(
            `${key.keyPrefix}  ${scope.padEnd(30)} ${key.name.padEnd(20)} ${used}${state}`
          );
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
        if (result.stoppedEarly) {
          console.log(
            "The sweep lost its lock (the database connection holding it ended) and stopped early. " +
              "What it deleted stands; run retention:sweep again to continue."
          );
        }
        break;
      }
      case "rotate:reencrypt": {
        const keyring = await requireKeyring();
        if (keyring === undefined) break;

        const { reencryptValues } = await import("./repositories/rotation.js");
        const report = await import("./rotation-report.js");

        // With ENCRYPTION_KEY_PREVIOUS this is a rotation; without it, an upgrade
        // of legacy values under the one key there is. The first line says which.
        const previousKeyId = keyring.previous?.id ?? null;
        const result = await reencryptValues(db, keyring, {
          // Only once the lock is held: a run refused the lock re-encrypts nothing.
          onLocked: () => {
            console.log(report.formatReencryptStart(keyring.current.id, previousKeyId));
          },
          onBatch: (progress) => {
            console.log(report.formatReencryptProgress(progress));
          }
        });
        if (!result.ran) {
          // An operator scripting the rotation needs to know nothing was done.
          console.error(report.LOCK_HELD_MESSAGE);
          process.exitCode = 1;
          break;
        }
        for (const line of report.formatReencryption(result.mode, result.tables)) console.log(line);
        if (result.lockLost) {
          console.error(report.LOCK_LOST_MESSAGE);
          process.exitCode = 1;
        }
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
      case "delete:journey":
      case "delete:identifier":
      case "delete:range":
      case "delete:destination": {
        const { runDeletionCommand } = await import("./deletion-cli.js");
        const report = await runDeletionCommand(command, args, {
          db,
          requireKeyring,
          progress: (line) => {
            console.log(line);
          }
        });
        for (const line of report.stdout) console.log(line);
        for (const line of report.stderr) console.error(line);
        if (report.code !== 0) process.exitCode = report.code;
        break;
      }
      case "doctor": {
        const { doctorExitCode, formatDoctor, parseDoctorArgs, runDoctor } =
          await import("./doctor.js");
        const parsed = parseDoctorArgs(args, process.env);
        if (!parsed.ok) {
          console.error(parsed.message);
          process.exitCode = 1;
          break;
        }
        const results = await runDoctor({
          db,
          env: process.env,
          ...(parsed.apiUrl === undefined ? {} : { apiUrl: parsed.apiUrl }),
          ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
          ...(parsed.apiKeyNotChecked === undefined
            ? {}
            : { apiKeyNotChecked: parsed.apiKeyNotChecked })
        });
        for (const line of formatDoctor(results)) console.log(line);
        process.exitCode = doctorExitCode(results);
        break;
      }
      default: {
        // A command in the registry this switch does not run is a type error
        // here, rather than a command --help lists and the CLI refuses.
        const unhandled: never = command;
        throw new Error(`No handler for ${String(unhandled)}.`);
      }
    }
  } finally {
    await db.destroy();
  }
}
