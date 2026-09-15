import {
  createDestination,
  destinationHeaders,
  findDestination,
  findEventDetail,
  findRun,
  finishRun,
  listDestinations,
  recordAudit,
  startRun,
  type DestinationHeaders,
  type EnvironmentType
} from "@flight-recorder/database";
import { diffPayloads } from "@flight-recorder/payload-diff";
import type { Keyring } from "@flight-recorder/payload-security";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { applyHeaderPolicy } from "../replay/header-policy.js";
import { sendReplay } from "../replay/send.js";
import { resolveAdminProjectId } from "../principal.js";

const ENVIRONMENT_TYPES = new Set(["local", "development", "test"]);
const METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface ReplayRouteOptions {
  adminToken: string;
  keyring: Keyring;
  allowedHosts: readonly string[];
  /** Told the id of a key a read needed and the keyring lacks. */
  warnUnknownKey?: (keyId: string) => void;
}

/**
 * Replay is admin-only (ADR-032).
 *
 * An API key lives in application configuration on servers many people can
 * reach, and it exists to write events. Letting it also make Flight Recorder
 * issue outbound requests to configured destinations would turn a leaked
 * telemetry key into a request-forgery primitive aimed at the operator's own
 * development network.
 */
export function registerReplayRoutes(app: FastifyInstance, options: ReplayRouteOptions): void {
  async function requireAdmin(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<string | undefined> {
    const [scheme, presented] = request.headers.authorization?.split(" ") ?? [];
    if (scheme?.toLowerCase() !== "bearer" || presented === undefined) {
      await reply.code(401).send(error("unauthorized", "An admin token is required.", request.id));
      return undefined;
    }
    if (!constantTimeEquals(presented, options.adminToken)) {
      // The same 401 for a wrong admin token and for a valid API key. Telling
      // a key holder that this endpoint exists but is not for them discloses
      // something and buys nothing.
      await reply.code(401).send(error("unauthorized", "An admin token is required.", request.id));
      return undefined;
    }

    const projectId = await resolveAdminProjectId(
      app.db,
      single(request.headers["x-flight-project-id"])
    );
    if (projectId === undefined) {
      await reply
        .code(404)
        .send(
          error(
            "project_not_found",
            "Specify a project: none was named and there is not exactly one.",
            request.id
          )
        );
      return undefined;
    }
    return projectId;
  }

  app.post("/v1/replay-destinations", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;

    const body = request.body as {
      name?: string;
      baseUrl?: string;
      environmentType?: string;
      headers?: Record<string, string>;
    };

    if (!body.name || !body.baseUrl || !body.environmentType) {
      return reply
        .code(400)
        .send(
          error("invalid_request", "name, baseUrl, and environmentType are required.", request.id)
        );
    }
    if (!ENVIRONMENT_TYPES.has(body.environmentType)) {
      // There is no value of this field that means production. Replay exists to
      // send a recorded input somewhere side effects are acceptable.
      return reply
        .code(400)
        .send(
          error(
            "invalid_environment_type",
            "environmentType must be local, development, or test.",
            request.id
          )
        );
    }

    const created = await createDestination(app.db, options.keyring, {
      projectId,
      name: body.name,
      baseUrl: body.baseUrl,
      environmentType: body.environmentType as EnvironmentType,
      ...(body.headers === undefined ? {} : { headers: body.headers })
    });

    await recordAudit(app.db, {
      projectId,
      actor: "admin",
      action: "replay_destination.created",
      resourceType: "replay_destination",
      resourceId: created.id,
      metadata: { name: created.name, baseUrl: created.baseUrl }
    });

    return reply.code(201).send({ data: created });
  });

  app.get("/v1/replay-destinations", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;
    return reply.send({ data: { items: await listDestinations(app.db, projectId) } });
  });

  app.post("/v1/replays", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;

    const body = request.body as {
      eventId?: string;
      destinationId?: string;
      method?: string;
      path?: string;
    };

    if (!body.eventId || !body.destinationId || !body.path) {
      return reply
        .code(400)
        .send(
          error("invalid_request", "eventId, destinationId, and path are required.", request.id)
        );
    }
    const method = (body.method ?? "POST").toUpperCase();
    if (!METHODS.has(method)) {
      return reply
        .code(400)
        .send(error("invalid_method", "method must be POST, PUT, or PATCH.", request.id));
    }

    // Replay is admin-only (ADR-032), and an admin reads every environment of
    // one project (ADR-029), so the scope carries no environment.
    const event = await findEventDetail(app.db, { projectId }, body.eventId);
    if (event === undefined) {
      return reply.code(404).send(error("not_found", "Event not found.", request.id));
    }
    // ADR-032: a payload that was never captured cannot be replayed. Ingestion
    // applies capture policy before storing, so a metadata-only environment
    // holds nothing to send.
    if (event.inputPayload === null || event.inputPayload === undefined) {
      return reply
        .code(409)
        .send(
          error(
            "no_captured_input",
            "This event has no captured input to replay. Its environment may be set to metadata-only capture.",
            request.id
          )
        );
    }

    const destination = await findDestination(app.db, projectId, body.destinationId);
    if (destination === undefined) {
      return reply.code(404).send(error("not_found", "Destination not found.", request.id));
    }
    if (!destination.enabled) {
      return reply
        .code(409)
        .send(error("destination_disabled", "That destination is disabled.", request.id));
    }

    const configured = await destinationHeaders(app.db, options.keyring, projectId, destination.id);
    const { headers, blocked } = applyHeaderPolicy(
      undefined,
      configured.ok ? configured.headers : {}
    );

    // Recorded before the request is made, so a refusal still leaves a row.
    const runId = await startRun(app.db, {
      projectId,
      journeyEventId: event.id,
      destinationId: destination.id,
      method,
      requestPath: body.path,
      requestPayload: event.inputPayload,
      requestHeaders: headers,
      initiatedBy: "admin"
    });

    // Headers the destination was configured with but that cannot be decrypted
    // are its credentials. Sending without them would reach the destination
    // unauthenticated and look like the destination had broken, so the attempt
    // is refused and recorded like any other refusal.
    if (!configured.ok) {
      if (configured.reason === "headers_key_not_configured") {
        options.warnUnknownKey?.(configured.keyId);
      }
      const refusal = headersRefusal(configured);
      await finishRun(app.db, projectId, runId, { status: "blocked", error: refusal });
      await recordAudit(app.db, {
        projectId,
        actor: "admin",
        action: "replay.blocked",
        resourceType: "replay_run",
        resourceId: runId,
        metadata: { reason: refusal.reason, destination: destination.name }
      });
      return reply.code(422).send({ data: await present(app, projectId, runId, event) });
    }

    const outcome = await sendReplay({
      baseUrl: destination.baseUrl,
      path: body.path,
      method: method as "POST" | "PUT" | "PATCH",
      headers,
      payload: event.inputPayload,
      allowedHosts: options.allowedHosts
    });

    if (!outcome.ok && outcome.blocked) {
      await finishRun(app.db, projectId, runId, {
        status: "blocked",
        error: { reason: outcome.reason, message: outcome.message }
      });
      await recordAudit(app.db, {
        projectId,
        actor: "admin",
        action: "replay.blocked",
        resourceType: "replay_run",
        resourceId: runId,
        metadata: { reason: outcome.reason, destination: destination.name, blockedHeaders: blocked }
      });
      return reply.code(422).send({ data: await present(app, projectId, runId, event) });
    }

    if (!outcome.ok) {
      await finishRun(app.db, projectId, runId, {
        status: "failed",
        durationMs: outcome.durationMs,
        error: { reason: outcome.reason, message: outcome.message }
      });
      await recordAudit(app.db, {
        projectId,
        actor: "admin",
        action: "replay.failed",
        resourceType: "replay_run",
        resourceId: runId,
        metadata: { destination: destination.name }
      });
      return reply.code(200).send({ data: await present(app, projectId, runId, event) });
    }

    await finishRun(app.db, projectId, runId, {
      status: "completed",
      responseStatus: outcome.status,
      responsePayload: outcome.body,
      durationMs: outcome.durationMs
    });
    await recordAudit(app.db, {
      projectId,
      actor: "admin",
      action: "replay.completed",
      resourceType: "replay_run",
      resourceId: runId,
      metadata: {
        destination: destination.name,
        responseStatus: outcome.status,
        blockedHeaders: blocked
      }
    });

    return reply.code(200).send({ data: await present(app, projectId, runId, event) });
  });

  app.get("/v1/replays/:replayId", async (request, reply) => {
    const projectId = await requireAdmin(request, reply);
    if (projectId === undefined) return reply;

    const { replayId } = request.params as { replayId: string };
    const run = await findRun(app.db, projectId, replayId);
    if (run === undefined) {
      return reply.code(404).send(error("not_found", "Replay not found.", request.id));
    }

    const event = await findEventDetail(app.db, { projectId }, run.journeyEventId);
    return reply.send({ data: await present(app, projectId, replayId, event) });
  });
}

/** What an operator reads when a destination's headers cannot be decrypted. */
function headersRefusal(configured: Exclude<DestinationHeaders, { ok: true }>): {
  reason: string;
  message: string;
} {
  if (configured.reason === "headers_key_not_configured") {
    return {
      reason: configured.reason,
      message:
        `This destination's headers were encrypted under key ${configured.keyId}, which is not configured. ` +
        "Set ENCRYPTION_KEY_PREVIOUS to that key and run rotate:reencrypt, or recreate the destination with its headers."
    };
  }
  return {
    reason: configured.reason,
    message:
      "This destination's headers could not be decrypted with any configured key. Recreate the destination with its headers."
  };
}

/**
 * A run plus the comparison that makes it useful.
 *
 * The original recorded output against the replay response. Both sides
 * genuinely share a shape here, which is what makes this the comparison
 * ADR-030 said the transformation diff could not be.
 */
async function present(
  app: FastifyInstance,
  projectId: string,
  runId: string,
  event: { outputPayload?: unknown } | undefined
): Promise<unknown> {
  const run = await findRun(app.db, projectId, runId);
  if (run === undefined) return null;

  const original = event?.outputPayload;
  const comparison =
    run.status === "completed" && original !== null && original !== undefined
      ? diffPayloads(original, run.responsePayload)
      : null;

  return {
    id: run.id,
    eventId: run.journeyEventId,
    destinationId: run.destinationId,
    method: run.method,
    path: run.requestPath,
    requestPayload: run.requestPayload,
    requestHeaders: run.requestHeaders,
    status: run.status,
    responseStatus: run.responseStatus,
    responsePayload: run.responsePayload,
    durationMs: run.durationMs,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    comparison
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function error(code: string, message: string, requestId: string): unknown {
  return { error: { code, message, requestId } };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Length is not secret; timingSafeEqual throws on a mismatch.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
