import type { ReadableStreamReadResult } from "node:stream/web";
import { MAX_BATCH_EVENTS } from "@wayscribe/protocol";
import { IngestionError, type IngestionConfig } from "./ingestion-config.js";

// Public batch count × documented default event budget, plus route headroom.
const DEFAULT_EVENT_BYTES = 262_144;
export const MAX_INGESTION_REQUEST_BYTES = MAX_BATCH_EVENTS * DEFAULT_EVENT_BYTES + 65_536;
export const MAX_INGESTION_RESPONSE_BYTES = 4 * 1024 * 1024;
export const INGESTION_DEADLINE_MS = 5_000;

/** Deliberately has no live ingestion method and never follows redirects. */
export class IngestionClient {
  constructor(private readonly config: IngestionConfig) {}

  async ready(): Promise<void> {
    const body = await this.request("/ready");
    if (
      typeof body !== "object" ||
      body === null ||
      !("status" in body) ||
      body.status !== "ready"
    ) {
      throw new IngestionError("NOT_READY", "The ingestion server is not ready.");
    }
  }

  async dryRun(rawBatch: Uint8Array): Promise<unknown> {
    if (rawBatch.byteLength > MAX_INGESTION_REQUEST_BYTES)
      throw new IngestionError("INPUT_LIMIT", "Batch exceeds the file/request limit.");
    return this.request("/v1/events/batch?dryRun=true", rawBatch);
  }

  private async request(path: string, body?: Uint8Array): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, INGESTION_DEADLINE_MS);
    let response: Response | undefined;
    try {
      response = await fetch(this.config.url + path, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : {
              body: Buffer.from(body),
              headers: {
                authorization: `Bearer ${this.config.apiKey}`,
                "content-type": "application/json"
              }
            }),
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400)
        throw new IngestionError("REDIRECT_REFUSED", "Ingestion redirects are refused.");
      if (response.status !== 200)
        throw new IngestionError(
          "HTTP_REFUSED",
          "The server refused the dry-run request or readiness check."
        );
      const reader = response.body?.getReader();
      if (!reader) throw new IngestionError("INVALID_RESPONSE", "Invalid dry-run server response.");
      const buffer = Buffer.alloc(MAX_INGESTION_RESPONSE_BYTES);
      let bytes = 0;
      try {
        for (;;) {
          const chunk = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_INGESTION_RESPONSE_BYTES)
            throw new IngestionError(
              "RESPONSE_LIMIT",
              "Server response exceeds the limit. Try a smaller batch."
            );
          buffer.set(chunk.value, bytes - chunk.value.byteLength);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes))
        );
      } catch {
        throw new IngestionError("INVALID_RESPONSE", "Invalid dry-run server response.");
      }
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      throw new IngestionError(
        "REQUEST_FAILED",
        "Ingestion request failed or exceeded its deadline."
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response?.body?.cancel().catch(() => undefined);
    }
  }
}
