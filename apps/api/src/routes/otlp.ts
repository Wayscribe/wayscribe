import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { isStatementTimeout } from "@wayscribe/database";
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
import { mapExport } from "../otlp/mapping.js";

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

/** Encapsulation keeps the native JSON parser and error envelope unchanged. */
export function registerOtlpRoutes(app: FastifyInstance, options: OtlpOptions): void {
  void app.register((scoped, _pluginOptions, done) => {
    const apiKeys = databaseApiKeys(scoped.db, options.keyring, () => {
      scoped.log.warn(
        "failed to move an API key verifier to the current key; the next request retries"
      );
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
        // Decode the complete body (including count) before authentication/storage.
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
      scoped.log.warn(
        { route: request.routeOptions.url, requestId: request.id },
        "OTLP ingestion unavailable"
      );
      return refusal(reply, encoding, 503, "unavailable");
    });
    scoped.post("/v1/logs", { bodyLimit: options.maxRequestBytes }, async (request, reply) => {
      const encoding = encodingOf(request);
      const auth = await resolveApiKey(request.headers.authorization, apiKeys);
      if (!auth.ok)
        return refusal(
          reply,
          encoding,
          auth.status,
          auth.status === 401 ? "unauthenticated" : "forbidden"
        );
      touchApiKeyUsage(scoped, auth.context.id);
      const records = mapExport(request.body as ReturnType<typeof decodeExport>);
      let rejected = 0;
      for (const record of records) {
        if (!record.ok) {
          scoped.metrics.countEvent("rejected");
          rejected++;
          continue;
        }
        let result;
        try {
          result = await ingestEvent(
            scoped.db,
            options.keyring,
            auth.context,
            record.envelope,
            options.maxEventPayloadBytes,
            options.allowFullPayload
          );
        } catch (error) {
          scoped.metrics.countEvent("rejected");
          if (isStatementTimeout(error) || storageRejection(error).httpStatus >= 500) throw error;
          rejected++;
          continue;
        }
        scoped.metrics.countEvent(eventResult(result));
        if (result.status === "rejected") {
          if (result.httpStatus >= 500 || result.httpStatus === 429)
            return refusal(reply, encoding, 503, "unavailable");
          rejected++;
        }
      }
      return reply
        .code(200)
        .type(contentType(encoding))
        .send(encodeExportResponse({ rejectedLogRecords: rejected }, encoding));
    });
    done();
  });
}
