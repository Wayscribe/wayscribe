import {
  deleteJourney,
  deleteReplayDestination,
  eraseIdentifier,
  findJourneysByIdentifier,
  type BatchProgress
} from "@wayscribe/database";
import type { Keyring } from "@wayscribe/payload-security";
import type { FastifyInstance } from "fastify";
import { adminGuard, errorBody } from "../admin.js";

/** The protocol's ceiling on an identifier, so anything that could be stored can be erased. */
const MAX_VALUE_LENGTH = 512;
/** The protocol's ceiling on a journey id. A longer one cannot exist. */
const MAX_JOURNEY_ID_LENGTH = 128;
/** Generous for a name; bounds what a request can make the database compare. */
const MAX_NAME_LENGTH = 512;
/**
 * Journeys listed by a dry run. `total` still counts every match, so an
 * operator sees when the list is cut short.
 */
const DRY_RUN_LIMIT = 1_000;
const NULL_BYTE = String.fromCharCode(0);

export interface DeletionRouteOptions {
  adminToken: string;
  keyring: Keyring;
}

/**
 * Deleting captured data: one journey, everything matching an identifier, or
 * a replay destination.
 *
 * Admin only, through the same gate as replay. An API key ingests and never
 * deletes; a leaked one must not be able to remove the record of what it sent.
 * Every deletion writes its audit row in the same transaction as the delete
 * (`packages/database/src/repositories/deletion.ts`).
 *
 * Input is checked here, before the repository: PostgreSQL rejects a string
 * containing a null byte with an error, which would otherwise surface as a 500.
 */
export function registerDeletionRoutes(app: FastifyInstance, options: DeletionRouteOptions): void {
  const requireAdmin = adminGuard(app, options.adminToken);

  app.delete("/v1/journeys/:journeyId", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;

    const { journeyId } = request.params as { journeyId: string };
    if (!isStorableText(journeyId, MAX_JOURNEY_ID_LENGTH)) {
      return reply
        .code(400)
        .send(errorBody("invalid_request", "journeyId is not a valid journey id.", request.id));
    }

    const result = await deleteJourney(app.db, { projectId, journeyId, actor: "admin" });
    if (!result.ok) {
      // The same answer as a read of a journey outside the project, so it
      // reveals nothing about other projects.
      return reply.code(404).send(errorBody("not_found", "Journey not found.", request.id));
    }
    return reply.code(204).send();
  });

  app.post("/v1/erasures", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;

    const parsed = parseErasure(request.body);
    if (!parsed.ok) {
      return reply.code(400).send(errorBody("invalid_request", parsed.message, request.id));
    }
    const { value, environment, dryRun } = parsed;
    const selection = { projectId, value, environment };

    if (dryRun) {
      const found = await findJourneysByIdentifier(app.db, options.keyring, selection, {
        limit: DRY_RUN_LIMIT
      });
      if (!found.ok) {
        const [status, body] = refusal(found.reason, request.id);
        return reply.code(status).send(body);
      }
      return reply.send({
        data: {
          journeys: found.journeys.map((journey) => ({
            id: journey.id,
            environment: journey.environment,
            entityType: journey.entityType,
            eventCount: journey.eventCount,
            lastEventAt: journey.lastEventAt.toISOString()
          })),
          total: found.total
        }
      });
    }

    let progress: BatchProgress = { batch: 0, deletedJourneys: 0, deletedEvents: 0 };
    let result: Awaited<ReturnType<typeof eraseIdentifier>>;
    try {
      result = await eraseIdentifier(
        app.db,
        options.keyring,
        { ...selection, actor: "admin" },
        {
          onBatch: (committed) => {
            progress = committed;
          }
        }
      );
    } catch (error) {
      // Nothing committed: an ordinary failure, answered as one.
      if (progress.deletedJourneys === 0) throw error;
      // Batches committed before the failure, each with the audit row brought
      // up to date and left incomplete. The operator needs those numbers and
      // the instruction more than an opaque 500 that hides a partial deletion.
      app.log.error({ err: error, requestId: request.id }, "erasure stopped part way");
      return reply.send({
        data: {
          deletedJourneys: progress.deletedJourneys,
          deletedEvents: progress.deletedEvents,
          complete: false,
          message: `The erasure stopped after deleting ${String(progress.deletedJourneys)} journeys. Run it again to delete the rest; the audit row records what was deleted and that it did not finish.`
        }
      });
    }

    if (!result.ok) {
      const [status, body] = refusal(result.reason, request.id);
      return reply.code(status).send(body);
    }
    return reply.send({
      data: {
        deletedJourneys: result.deletedJourneys,
        deletedEvents: result.deletedEvents,
        complete: true
      }
    });
  });

  app.delete("/v1/replay-destinations/:destinationId", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;

    const { destinationId } = request.params as { destinationId: string };
    if (!isStorableText(destinationId, MAX_NAME_LENGTH)) {
      return reply
        .code(400)
        .send(errorBody("invalid_request", "destinationId is not a valid id.", request.id));
    }

    const result = await deleteReplayDestination(app.db, {
      projectId,
      destinationId,
      actor: "admin"
    });
    if (!result.ok) {
      return reply.code(404).send(errorBody("not_found", "Destination not found.", request.id));
    }
    return reply.code(204).send();
  });
}

type ParsedErasure =
  | { ok: true; value: string; environment: string | undefined; dryRun: boolean }
  | { ok: false; message: string };

function parseErasure(body: unknown): ParsedErasure {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "A JSON body with value is required." };
  }
  const { value, environment, dryRun } = body as Record<string, unknown>;

  if (typeof value !== "string" || !isStorableText(value, MAX_VALUE_LENGTH)) {
    return {
      ok: false,
      message: `value must be a string of at most ${String(MAX_VALUE_LENGTH)} characters without null bytes.`
    };
  }
  // Checked here as well as in the repository, so the answer is a 400 with a
  // reason rather than depending on how a result is mapped.
  if (value.trim() === "") {
    return { ok: false, message: "value is empty once surrounding whitespace is removed." };
  }
  if (
    environment !== undefined &&
    (typeof environment !== "string" ||
      environment === "" ||
      !isStorableText(environment, MAX_NAME_LENGTH))
  ) {
    return { ok: false, message: "environment must be a non-empty environment name." };
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    return { ok: false, message: "dryRun must be true or false." };
  }

  return { ok: true, value, environment, dryRun: dryRun ?? false };
}

function refusal(
  reason: "environment_not_found" | "empty_value",
  requestId: string
): [number, unknown] {
  return reason === "environment_not_found"
    ? [
        404,
        errorBody(
          "environment_not_found",
          "No environment with that name in this project.",
          requestId
        )
      ]
    : [
        400,
        errorBody(
          "invalid_request",
          "value is empty once surrounding whitespace is removed.",
          requestId
        )
      ];
}

/** Text PostgreSQL can compare: bounded, and without the null byte it rejects outright. */
function isStorableText(value: string, maxLength: number): boolean {
  return value.length <= maxLength && !value.includes(NULL_BYTE);
}
