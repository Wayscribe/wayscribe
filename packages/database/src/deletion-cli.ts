import type { Keyring } from "@flight-recorder/payload-security";
import type { Knex } from "knex";
import {
  formatBatchProgress,
  parseIdArgs,
  parseIdentifierArgs,
  parseRangeArgs,
  reportDestination,
  reportErasure,
  reportErasureStopped,
  reportJourneyDeletion,
  reportMatches,
  reportRange,
  type Report
} from "./deletion-report.js";
import {
  deleteJourney,
  deleteRange,
  deleteReplayDestination,
  eraseIdentifier,
  findJourneysByIdentifier,
  findJourneysInRange,
  type BatchProgress
} from "./repositories/deletion.js";

export const DELETION_COMMANDS = [
  "delete:journey",
  "delete:identifier",
  "delete:range",
  "delete:destination"
] as const;

/** The CLI's actor in the audit log, distinguishing it from the API's "admin". */
const ACTOR = "cli";
/** Rows in a dry-run table. The total still counts every match. */
const DRY_RUN_LIMIT = 1_000;

export interface DeletionCommandDeps {
  db: Knex;
  /** Prints why and returns undefined when ENCRYPTION_KEY is missing or malformed. */
  requireKeyring: () => Promise<Keyring | undefined>;
  /** A line as each batch commits, so a long run shows it is moving. */
  progress: (line: string) => void;
}

/**
 * Run one of the deletion commands and return what to print.
 *
 * The actor recorded is `cli`. Anyone who can run this already holds
 * DATABASE_URL, which is more than the admin token grants.
 */
export async function runDeletionCommand(
  command: (typeof DELETION_COMMANDS)[number],
  args: readonly string[],
  deps: DeletionCommandDeps
): Promise<Report> {
  const { db } = deps;
  const onBatch = (progress: BatchProgress): void => {
    deps.progress(formatBatchProgress(progress));
  };

  switch (command) {
    case "delete:journey": {
      const parsed = parseIdArgs(args, "Usage: delete:journey <project-slug> <journey-id>");
      if (!parsed.ok) return usage(parsed.message);
      const { projectSlug, id: journeyId } = parsed;
      const project = await findProject(db, projectSlug);
      if (!project.ok) return project.report;
      const result = await deleteJourney(db, { projectId: project.id, journeyId, actor: ACTOR });
      return reportJourneyDeletion(result, projectSlug, journeyId);
    }

    case "delete:identifier": {
      const parsed = parseIdentifierArgs(args);
      if (!parsed.ok) return usage(parsed.message);
      const keyring = await deps.requireKeyring();
      if (keyring === undefined) return { stdout: [], stderr: [], code: 1 };
      const project = await findProject(db, parsed.projectSlug);
      if (!project.ok) return project.report;

      const selection = {
        projectId: project.id,
        value: parsed.value,
        environment: parsed.environment
      };
      const context = {
        projectSlug: parsed.projectSlug,
        scope: parsed.environment ?? "all environments",
        command
      };
      if (parsed.dryRun) {
        const found = await findJourneysByIdentifier(db, keyring, selection, {
          limit: DRY_RUN_LIMIT
        });
        return reportMatches(found, context);
      }

      let progress: BatchProgress = { batch: 0, deletedJourneys: 0, deletedEvents: 0 };
      try {
        const result = await eraseIdentifier(
          db,
          keyring,
          { ...selection, actor: ACTOR },
          {
            onBatch: (committed) => {
              progress = committed;
              onBatch(committed);
            }
          }
        );
        return reportErasure(result, context);
      } catch (error) {
        // With nothing committed this is an ordinary failure; with batches
        // committed the operator needs the counts and the instruction.
        if (progress.deletedJourneys === 0) throw error;
        return reportErasureStopped(progress, error);
      }
    }

    case "delete:range": {
      const parsed = parseRangeArgs(args);
      if (!parsed.ok) return usage(parsed.message);
      const project = await findProject(db, parsed.projectSlug);
      if (!project.ok) return project.report;

      const selection = {
        projectId: project.id,
        environment: parsed.environment,
        after: parsed.after,
        before: parsed.before
      };
      const context = { projectSlug: parsed.projectSlug, scope: parsed.environment, command };
      if (parsed.dryRun) {
        return reportMatches(
          await findJourneysInRange(db, selection, { limit: DRY_RUN_LIMIT }),
          context
        );
      }
      return reportRange(
        await deleteRange(db, { ...selection, actor: ACTOR }, { onBatch }),
        context
      );
    }

    case "delete:destination": {
      const parsed = parseIdArgs(args, "Usage: delete:destination <project-slug> <destination-id>");
      if (!parsed.ok) return usage(parsed.message);
      const { projectSlug, id: destinationId } = parsed;
      const project = await findProject(db, projectSlug);
      if (!project.ok) return project.report;
      const result = await deleteReplayDestination(db, {
        projectId: project.id,
        destinationId,
        actor: ACTOR
      });
      return reportDestination(result, projectSlug, destinationId);
    }
  }
}

async function findProject(
  db: Knex,
  slug: string
): Promise<{ ok: true; id: string } | { ok: false; report: Report }> {
  const row: unknown = await db("projects").where({ slug }).first("id");
  const project = row as { id: string } | undefined;
  if (project !== undefined) return { ok: true, id: project.id };

  const rows: unknown = await db("projects").select("slug").orderBy("slug");
  const slugs = (rows as { slug: string }[]).map((existing) => existing.slug);
  return {
    ok: false,
    report: usage(
      `No project with slug "${slug}". Existing projects: ${slugs.length === 0 ? "(none)" : slugs.join(", ")}`
    )
  };
}

function usage(message: string): Report {
  return { stdout: [], stderr: [message], code: 1 };
}
