import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { isStatementTimeout, type ApiKeyContext } from "@wayscribe/database";
import type { Keyring } from "@wayscribe/payload-security";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { databaseApiKeys, resolveApiKey } from "../auth.js";
import { touchApiKeyUsage } from "../api-key-usage.js";
import { ingestEvent } from "../ingestion/ingest-event.js";
import { eventResult, storageRejection } from "../ingestion/storage-result.js";
import {
  decodeExport,
  encodeExportResponse,
  encodeStatus,
  OtlpDecodeError,
  OTLP_STATUS_MESSAGES,
  type OtlpEncoding
} from "../otlp/codec.js";
import { otlpFallbackEventIds } from "../otlp/event-id.js";
import { mapExport, type MappedLog } from "../otlp/mapping.js";
import { isTransientDatabaseError } from "../otlp/transient.js";

const unzip = promisify(gunzip);
interface OtlpOptions {
  keyring: Keyring;
  maxEventPayloadBytes: number;
  allowFullPayload: boolean;
  maxRequestBytes: number;
}
const encodingOf = (request: FastifyRequest): OtlpEncoding =>
  request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
  "application/x-protobuf"
    ? "protobuf"
    : "json";
const contentType = (encoding: OtlpEncoding): string =>
  encoding === "protobuf" ? "application/x-protobuf" : "application/json";
function refusal(
  reply: FastifyReply,
  encoding: OtlpEncoding,
  status: number,
  kind: keyof typeof OTLP_STATUS_MESSAGES
): FastifyReply {
  return reply
    .code(status)
    .type(contentType(encoding))
    .send(encodeStatus(OTLP_STATUS_MESSAGES[kind], encoding));
}

/**
 * The first attempt of a retry that straddles a key rotation stored its
 * content-derived id under the previous key; reuse that id so the retry is a
 * duplicate rather than a second copy of the record.
 */
async function storedAlternateId(
  db: FastifyInstance["db"],
  projectId: string,
  record: Extract<MappedLog, { ok: true }>
): Promise<string | undefined> {
  if (record.alternateIds === undefined || record.alternateIds.length === 0) return undefined;
  const row: unknown = await db("journey_events")
    .where({ project_id: projectId })
    .whereIn("id", [...record.alternateIds])
    .first("id");
  return (row as { id?: string } | undefined)?.id;
}

/** Encapsulation keeps the native JSON parser and error envelope unchanged. */
export function registerOtlpRoutes(app: FastifyInstance, options: OtlpOptions): void {
  void app.register((scoped, _pluginOptions, done) => {
    const apiKeys = databaseApiKeys(scoped.db, options.keyring, () => {
      scoped.log.warn(
        "failed to move an API key verifier to the current key; the next request retries"
      );
    });
    const fallbackEventIds = otlpFallbackEventIds(options.keyring);
    const authenticated = new WeakMap<FastifyRequest, ApiKeyContext>();
    // onRequest runs before the body is read, so an unauthenticated request
    // never costs a read, an inflate or a decode.
    scoped.addHook("onRequest", async (request, reply) => {
      const auth = await resolveApiKey(request.headers.authorization, apiKeys);
      if (!auth.ok) {
        return refusal(
          reply,
          encodingOf(request),
          auth.status,
          auth.status === 401 ? "unauthenticated" : "forbidden"
        );
      }
      authenticated.set(request, auth.context);
      return undefined;
    });
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser(
      ["application/json", "application/x-protobuf"],
      { parseAs: "buffer", bodyLimit: options.maxRequestBytes },
      async (request: FastifyRequest, body: Buffer) => {
        const coding = request.headers["content-encoding"]?.trim().toLowerCase() ?? "identity";
        if (coding !== "identity" && coding !== "gzip")
          throw Object.assign(new Error("unsupported"), { statusCode: 415 });
        let bytes = body;
        if (coding === "gzip") {
          try {
            bytes = await unzip(bytes, { maxOutputLength: options.maxRequestBytes });
          } catch (error) {
            const tooLarge = (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
            throw Object.assign(new Error("invalid"), { statusCode: tooLarge ? 413 : 400 });
          }
        }
        // Authenticated already; decode the complete body (including count) before storage.
        return decodeExport(bytes, encodingOf(request));
      }
    );
    scoped.setErrorHandler((error: unknown, request, reply) => {
      const encoding = encodingOf(request);
      if (error instanceof OtlpDecodeError) {
        return refusal(
          reply,
          encoding,
          error.code === "otlp_limit_exceeded" ? 413 : 400,
          error.code === "otlp_limit_exceeded" ? "oversized" : "invalid"
        );
      }
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 413) return refusal(reply, encoding, 413, "oversized");
      if (status === 415) return refusal(reply, encoding, 415, "unsupported");
      if (status === 400) return refusal(reply, encoding, 400, "invalid");
      if (isStatementTimeout(error)) scoped.metrics.countQueryTimeout(request.routeOptions.url);
      // Only the error's class and code are logged: its message can carry SQL or values.
      const facts = {
        route: request.routeOptions.url,
        requestId: request.id,
        errorName: (error as { name?: unknown } | null)?.name,
        errorCode: (error as { code?: unknown } | null)?.code
      };
      if (isTransientDatabaseError(error)) {
        scoped.log.warn(facts, "OTLP ingestion unavailable");
        return refusal(reply, encoding, 503, "unavailable");
      }
      // Not 503: a Collector retries 503 unchanged, so a deterministic failure would never end.
      scoped.log.error(facts, "OTLP ingestion failed");
      return refusal(reply, encoding, 500, "internal");
    });
    scoped.post("/v1/logs", { bodyLimit: options.maxRequestBytes }, async (request, reply) => {
      const encoding = encodingOf(request);
      const context = authenticated.get(request);
      if (context === undefined) return refusal(reply, encoding, 401, "unauthenticated");
      touchApiKeyUsage(scoped, context.id);
      const records = mapExport(request.body as ReturnType<typeof decodeExport>, {
        environment: context.environmentName,
        fallbackEventIds
      });
      let rejected = 0;
      const refusals = new Map<string, number>();
      const refuse = (code: string): void => {
        scoped.metrics.countEvent("rejected");
        rejected++;
        refusals.set(code, (refusals.get(code) ?? 0) + 1);
      };
      for (const record of records) {
        if (!record.ok) {
          refuse(record.code);
          continue;
        }
        const storedId = await storedAlternateId(scoped.db, context.projectId, record);
        if (storedId !== undefined) record.envelope.event.id = storedId;
        let result;
        try {
          result = await ingestEvent(
            scoped.db,
            options.keyring,
            context,
            record.envelope,
            options.maxEventPayloadBytes,
            options.allowFullPayload
          );
        } catch (error) {
          const storage = storageRejection(error);
          if (isStatementTimeout(error) || storage.httpStatus >= 500) {
            scoped.metrics.countEvent("rejected");
            throw error;
          }
          if (storage.status === "rejected") refuse(storage.code ?? "rejected");
          continue;
        }
        if (result.status === "rejected") {
          if (result.httpStatus === 429 || result.httpStatus === 503) {
            scoped.metrics.countEvent("rejected");
            return refusal(reply, encoding, 503, "unavailable");
          }
          if (result.httpStatus >= 500) {
            scoped.metrics.countEvent("rejected");
            return refusal(reply, encoding, 500, "internal");
          }
          refuse(result.code ?? "rejected");
          continue;
        }
        scoped.metrics.countEvent(eventResult(result));
      }
      if (rejected > 0) {
        // Codes only: fixed identifiers, never record values.
        scoped.log.info(
          {
            route: request.routeOptions.url,
            requestId: request.id,
            rejected,
            refusals: Object.fromEntries(refusals)
          },
          "OTLP log records rejected"
        );
      }
      return reply
        .code(200)
        .type(contentType(encoding))
        .send(encodeExportResponse({ rejectedLogRecords: rejected, refusals }, encoding));
    });
    done();
  });
}
