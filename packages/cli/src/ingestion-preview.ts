import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import {
  batchRequestSchema,
  batchResponseSchema,
  parseEnvelope,
  PROTOCOL_VERSION
} from "@wayscribe/protocol";
import { maskSecretsInText } from "@wayscribe/payload-security";
import type { Io } from "./cli.js";
import { IngestionClient, MAX_INGESTION_REQUEST_BYTES } from "./ingestion-client.js";
import {
  INGESTION_USAGE,
  IngestionError,
  parseIngestionArgs,
  resolveIngestionConfig,
  type IngestionCommand,
  type IngestionConfig
} from "./ingestion-config.js";

export const MAX_PREVIEW_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_PREVIEW_STRING_BYTES = 262_144;
export const MAX_PREVIEW_NODES = 10_000;
export const MAX_PREVIEW_DEPTH = 30;
const policy =
  "Only selected server stored-form fields are shown. Environment capture policy may omit payloads; hasInput/hasOutput/hasError describe capture. Duplicate or missing stored-form results do not establish a capture policy. Output applies secret masking and removes terminal controls. No journey evidence is stored; key usage/verifier bookkeeping may change.";

async function readBatch(path: string): Promise<Buffer> {
  try {
    // O_NONBLOCK lets fstat reject a FIFO without waiting for a writer.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new IngestionError(
          "INVALID_INPUT",
          "Preview requires a regular UTF-8 JSON batch file."
        );
      if (stat.size > MAX_INGESTION_REQUEST_BYTES)
        throw new IngestionError("INPUT_LIMIT", "Batch exceeds the file/request limit.");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65_536, MAX_INGESTION_REQUEST_BYTES + 1 - bytes));
        const { bytesRead } = await file.read(chunk);
        if (bytesRead === 0) return Buffer.concat(chunks);
        bytes += bytesRead;
        if (bytes > MAX_INGESTION_REQUEST_BYTES)
          throw new IngestionError("INPUT_LIMIT", "Batch exceeds the file/request limit.");
        chunks.push(chunk.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(
      "INVALID_INPUT",
      "Preview requires a readable regular UTF-8 JSON batch file."
    );
  }
}

function syntheticBatch(config: IngestionConfig): Buffer {
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    event: {
      id: `evt_${randomUUID()}`,
      journeyId: `jrn_${randomUUID()}`,
      entity: { type: "wayscribe-check", id: randomUUID() },
      operation: "received",
      name: "ingestion-check",
      service: config.service,
      environment: config.environment,
      timestamp: new Date().toISOString()
    }
  };
  if (!parseEnvelope(envelope).ok)
    throw new IngestionError("INVALID_CONFIG", "Check settings do not form a valid public event.");
  return Buffer.from(JSON.stringify({ events: [envelope] }));
}

function eventCount(raw: Buffer): number {
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
    );
    const parsed = batchRequestSchema.safeParse(body);
    if (parsed.success) return parsed.data.events.length;
  } catch {
    /* Only the fixed message below can leave this boundary. */
  }
  throw new IngestionError(
    "INVALID_INPUT",
    "Expected a UTF-8 JSON public batch with at most 100 events."
  );
}

type PreviewOutput = {
  dryRun: true;
  guardPolicy: string;
  results: { status: "accepted" | "rejected"; [key: string]: unknown }[];
};

function checkResponseWork(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  budget.nodes += 1;
  if (
    budget.nodes > MAX_PREVIEW_NODES ||
    depth > MAX_PREVIEW_DEPTH ||
    (typeof value === "string" && Buffer.byteLength(value) > MAX_PREVIEW_STRING_BYTES)
  )
    throw new IngestionError(
      "OUTPUT_LIMIT",
      "Preview exceeds output/work limits. Try a smaller batch."
    );
  if (value === null || typeof value !== "object") return;
  const keys = Object.keys(value);
  if (keys.length > MAX_PREVIEW_NODES - budget.nodes)
    throw new IngestionError(
      "OUTPUT_LIMIT",
      "Preview exceeds output/work limits. Try a smaller batch."
    );
  for (const key of keys) {
    checkResponseWork(key, depth + 1, budget);
    checkResponseWork((value as Record<string, unknown>)[key], depth + 1, budget);
  }
}

function selectPreview(body: unknown, count: number): PreviewOutput {
  const data = typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
  if (
    typeof data !== "object" ||
    data === null ||
    !("results" in data) ||
    !Array.isArray(data.results) ||
    data.results.length !== count
  )
    throw new IngestionError("INVALID_RESPONSE", "Invalid or unconfirmed dry-run server response.");
  checkResponseWork(body);
  const parsed = batchResponseSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.data.dryRun !== true ||
    parsed.data.data.results.length !== count
  )
    throw new IngestionError("INVALID_RESPONSE", "Invalid or unconfirmed dry-run server response.");
  const results = parsed.data.data.results.map((result, index) => {
    if (
      (result.status === "rejected" && (result.stored || result.duplicate === true)) ||
      (result.status === "accepted" && result.error) ||
      (result.duplicate === true && result.stored)
    )
      throw new IngestionError("INVALID_RESPONSE", "Inconsistent dry-run server response.");
    const stored = result.stored;
    return {
      position: index,
      eventId: result.eventId,
      status: result.status,
      ...(result.duplicate === undefined ? {} : { duplicate: result.duplicate }),
      ...(result.error === undefined ? {} : { error: result.error }),
      preview:
        result.status === "rejected"
          ? "rejected"
          : result.duplicate === true
            ? "duplicate"
            : stored === undefined
              ? "unavailable"
              : "stored-form",
      ...(stored === undefined
        ? {}
        : {
            stored: {
              event: {
                id: stored.event.id,
                journeyId: stored.event.journeyId,
                operation: stored.event.operation,
                name: stored.event.name,
                service: stored.event.service,
                eventTimestamp: stored.event.eventTimestamp,
                hasInput: stored.event.hasInput,
                hasOutput: stored.event.hasOutput,
                hasError: stored.event.hasError,
                inputPayload: stored.event.inputPayload,
                outputPayload: stored.event.outputPayload,
                payloadDiff: stored.event.payloadDiff,
                error: stored.event.error,
                aliases: stored.event.aliases
              },
              journey: {
                journeyId: stored.journey.journeyId,
                environment: stored.journey.environment,
                entity: stored.journey.entity,
                status: stored.journey.status,
                aliases: stored.journey.aliases,
                services: stored.journey.services
              }
            }
          })
    };
  });
  return { dryRun: true, guardPolicy: policy, results };
}

/** Guard keys as well as values, before serialization; never cut serialized JSON. */
function guardedJson(value: unknown, apiKey: string): string {
  let nodes = 0;
  let guardedBytes = 0;
  const limit = (): never => {
    throw new IngestionError(
      "OUTPUT_LIMIT",
      "Preview exceeds output/work limits. Try a smaller batch."
    );
  };
  const text = (raw: string): string => {
    if (Buffer.byteLength(raw) > MAX_PREVIEW_STRING_BYTES) limit();
    const exact = (v: string): string =>
      apiKey === ""
        ? v
        : v
            .split(apiKey)
            .join(
              "[REDACTED]".includes(apiKey)
                ? "[MASKED]".includes(apiKey)
                  ? ""
                  : "[MASKED]"
                : "[REDACTED]"
            );
    // Strip controls including bidi overrides after removing escape sequences.
    const cleaned = stripVTControlCharacters(exact(raw)).replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
      ""
    );
    const guarded = exact(maskSecretsInText(cleaned));
    guardedBytes += Buffer.byteLength(guarded);
    if (guardedBytes > MAX_PREVIEW_OUTPUT_BYTES) limit();
    return guarded;
  };
  const visit = (item: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_PREVIEW_NODES || depth > MAX_PREVIEW_DEPTH) limit();
    if (typeof item === "string") return text(item);
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) {
      if (item.length > MAX_PREVIEW_NODES - nodes) limit();
      return item.map((entry) => visit(entry, depth + 1));
    }
    const keys = Object.keys(item);
    if (keys.length > MAX_PREVIEW_NODES - nodes) limit();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      nodes += 1;
      if (nodes > MAX_PREVIEW_NODES) limit();
      const guardedKey = text(key);
      if (Object.hasOwn(output, guardedKey))
        throw new IngestionError(
          "OUTPUT_LIMIT",
          "Preview keys collide after masking. Try a smaller batch."
        );
      const entry = (item as Record<string, unknown>)[key];
      const probe = `${JSON.stringify(guardedKey)}:"output-guard-probe"`;
      output[guardedKey] =
        entry !== null && maskSecretsInText(probe) !== probe
          ? text("[REDACTED]")
          : visit(entry, depth + 1);
    }
    return output;
  };
  const result = JSON.stringify(visit(value, 0), null, 2);
  if (Buffer.byteLength(result) + 1 > MAX_PREVIEW_OUTPUT_BYTES) limit();
  if (apiKey !== "" && result.includes(apiKey))
    throw new IngestionError(
      "UNSAFE_OUTPUT",
      "Preview cannot be displayed without exposing the ingestion key."
    );
  return result;
}

export async function runIngestionCommand(
  command: IngestionCommand,
  args: readonly string[],
  io: Io
): Promise<number> {
  // This only controls the error format; credentials are never consulted for help/errors.
  let json = args.includes("--json");
  let key = "";
  try {
    const parsed = parseIngestionArgs(command, args);
    json = parsed.json;
    if (parsed.help) {
      io.out(INGESTION_USAGE);
      return 0;
    }
    const config = resolveIngestionConfig(command, parsed.flags, io.env);
    key = config.apiKey;
    const raw = command === "check" ? syntheticBatch(config) : await readBatch(parsed.file ?? "");
    const count = eventCount(raw);
    const client = new IngestionClient(config);
    if (command === "check") await client.ready();
    const preview = selectPreview(await client.dryRun(raw), count);
    // Human mode uses the same structured selection, with its policy explanation.
    io.out(guardedJson(preview, key));
    return preview.results.some((result) => result.status === "rejected") ? 1 : 0;
  } catch (error) {
    const safe =
      error instanceof IngestionError
        ? error
        : new IngestionError("PREVIEW_FAILED", "Could not safely render the dry-run preview.");
    const output = guardedJson({ error: { code: safe.code, message: safe.message } }, key);
    if (json) io.out(output);
    else io.err(output);
    return safe.code === "INVALID_ARGUMENTS" ? 2 : 1;
  }
}
