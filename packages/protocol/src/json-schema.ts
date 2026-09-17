import { z } from "zod";
import { journeyEventSchema } from "./event.js";
import {
  batchRequestSchema,
  batchResponseSchema,
  errorBodySchema,
  eventAcceptedSchema,
  eventResultSchema,
  storedEventSchema,
  storedJourneySchema
} from "./ingestion.js";
import { PROTOCOL_VERSION } from "./version.js";

/**
 * A generated JSON Schema document. Deliberately loose: these are written out
 * as JSON and read back by validators in other languages, so the type says
 * "JSON object" and the tests say what is in it.
 */
export type JsonSchema = Record<string, unknown>;

/** JSON Schema draft 2020-12: what Zod targets, what Ajv's 2020 entry point
 * validates, and what OpenAPI 3.1 aligns with, so the files can be consumed
 * unchanged by a generator or a documentation tool. */
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Every schema file, keyed by its basename without the `.schema.json` suffix.
 *
 * One module builds them and one function serializes them, so the generator
 * script and the drift test cannot disagree about formatting. Nothing here is
 * hand-edited: `pnpm --filter @wayscribe/protocol run schemas` rewrites
 * the committed files and `json-schema.test.ts` fails when they differ.
 */
export function buildJsonSchemas(): Record<string, JsonSchema> {
  return {
    event: document({
      id: "event.schema.json",
      title: "Journey event",
      description:
        "One recorded step in a journey: which entity it concerned, which service handled it, what happened, and when. Limits this schema cannot express, such as the serialized size of the whole envelope and the depth and key counts of a payload, are in the ingestion contract.",
      body: generate(journeyEventSchema)
    }),
    envelope: document({
      id: "envelope.schema.json",
      title: "Event envelope",
      description:
        "The body of a single-event ingestion request, and one element of a batch: a protocol version and one event.",
      body: envelopeBody()
    }),
    "batch-request": document({
      id: "batch-request.schema.json",
      title: "Batch ingestion request",
      description:
        "The body of a batch ingestion request. Each element is an envelope, and each is refused or accepted on its own, so an element that fails does not refuse the request.",
      body: generate(batchRequestSchema)
    }),
    "batch-response": document({
      id: "batch-response.schema.json",
      title: "Batch ingestion response",
      description:
        "One verdict per sent event, in the order they were sent and matched by position. The response is 202 whether or not every event was accepted, because the transport succeeded, so a client has to read this body.",
      body: refer(generate(batchResponseSchema), [
        [["properties", "data", "properties", "results", "items"], "event-result.schema.json"]
      ])
    }),
    "event-result": document({
      id: "event-result.schema.json",
      title: "Per-event verdict",
      description: "What happened to one event of a batch.",
      body: refer(generate(eventResultSchema), [
        [["properties", "stored", "properties", "event"], "stored-event.schema.json"],
        [["properties", "stored", "properties", "journey"], "stored-journey.schema.json"]
      ])
    }),
    "event-accepted": document({
      id: "event-accepted.schema.json",
      title: "Single-event ingestion response",
      description: "The body of an accepted single-event ingestion request.",
      body: generate(eventAcceptedSchema)
    }),
    "error-body": document({
      id: "error-body.schema.json",
      title: "Error body",
      description:
        "Every refusal, from any route, in one shape. A client that does not recognize the code branches on the HTTP status.",
      body: generate(errorBodySchema)
    }),
    "stored-event": document({
      id: "stored-event.schema.json",
      title: "Stored event",
      description:
        "One event as a read returns it, which is what a dry run previews. This is not the wire event: capture, redaction and masking have been applied, and unknown fields are gone.",
      body: generate(storedEventSchema)
    }),
    "stored-journey": document({
      id: "stored-journey.schema.json",
      title: "Stored journey",
      description:
        "One journey as a read returns it, with its aliases and the services that touched it.",
      body: generate(storedJourneySchema)
    })
  };
}

/**
 * Replace an inlined subschema with a sibling `$ref`.
 *
 * Zod inlines a nested schema, which would publish the stored event's shape
 * three times and let the copies drift as surely as two hand-written files
 * would. Throws when the path is not there, so a schema change that moves one
 * of these properties fails the generator rather than quietly shipping the
 * inlined copy again.
 */
function refer(schema: JsonSchema, replacements: [string[], string][]): JsonSchema {
  for (const [path, ref] of replacements) {
    let parent: JsonSchema = schema;
    for (const segment of path.slice(0, -1)) {
      const next: unknown = parent[segment];
      if (typeof next !== "object" || next === null) {
        throw new Error(`No subschema at ${path.join(".")}: stopped at ${segment}.`);
      }
      parent = next as JsonSchema;
    }
    const last = path[path.length - 1] ?? "";
    if (!(last in parent)) throw new Error(`No subschema at ${path.join(".")}.`);
    // The description written on the Zod schema is kept: it says what the
    // property means here, which the referenced document cannot.
    const existing = parent[last] as JsonSchema;
    const description = existing["description"];
    parent[last] = typeof description === "string" ? { $ref: ref, description } : { $ref: ref };
  }
  return schema;
}

/**
 * `JSON.stringify` at two spaces with a trailing newline, and keys in the order
 * the generator produced them, so a diff shows a real change rather than a
 * reordering.
 */
export function serializeSchema(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** The command that rewrites the committed files, quoted by the drift test. */
export const REGENERATE_COMMAND = "pnpm --filter @wayscribe/protocol run schemas";

/**
 * The envelope is composed rather than emitted.
 *
 * `envelopeSchema` types `protocolVersion` as a 1-to-16-character string and
 * `event` as `unknown`, because `parseEnvelope` checks the version itself,
 * before the event, so that a future version answers
 * `unsupported_protocol_version` rather than a pile of field errors from
 * schemas that never applied to it. Emitting that schema verbatim would publish
 * a contract under which version 9.9 with no event at all is valid.
 */
function envelopeBody(): JsonSchema {
  return {
    type: "object",
    properties: {
      protocolVersion: { const: PROTOCOL_VERSION },
      event: { $ref: "event.schema.json" }
    },
    required: ["protocolVersion", "event"]
  };
}

interface DocumentParts {
  id: string;
  title: string;
  description: string;
  body: JsonSchema;
}

/**
 * One file: the dialect, its own `$id`, a title and a description, then the
 * schema.
 *
 * The `$id` is the file's own basename and every `$ref` is a sibling basename.
 * A relative `$id` resolves against whatever URI the file was retrieved from,
 * so the same bytes work read from disk, served from a documentation site, or
 * copied into another repository. An absolute `$id` would have to name a host
 * that does not exist yet, and would be wrong twice: once when a domain is
 * registered and again if it ever changes. `title` and `description` carry no
 * product name for the same reason.
 */
function document(parts: DocumentParts): JsonSchema {
  const { $schema: _dialect, ...body } = parts.body;
  return {
    $schema: DIALECT,
    $id: parts.id,
    title: parts.title,
    description: parts.description,
    ...body
  };
}

function generate(schema: z.ZodType): JsonSchema {
  // `io: "input"` describes what a sender may send. The output schema emits
  // `additionalProperties: false`, which would publish a contract saying an
  // unknown field is refused; it is accepted and dropped (ADR-049).
  //
  // `unrepresentable: "throw"` so that a future schema construct Zod cannot
  // express fails the generator rather than being silently approximated.
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw"
  });
  return rewritePatterns(generated) as JsonSchema;
}

/**
 * Rewrite `\d` to `[0-9]` in every generated `pattern`.
 *
 * `\d` is ASCII digits in ECMAScript and Unicode decimal digits in Python's
 * `re` and in .NET, so a validator in one of those languages would accept a
 * timestamp written in Arabic-Indic digits that Zod rejects, and the two
 * implementations of one contract would disagree about a valid event. The
 * rewrite is semantics-preserving under ECMAScript and removes the divergence
 * everywhere else.
 */
function rewritePatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewritePatterns);
  if (typeof value !== "object" || value === null) return value;

  const result: JsonSchema = {};
  for (const [key, child] of Object.entries(value as JsonSchema)) {
    result[key] =
      key === "pattern" && typeof child === "string"
        ? child.replaceAll(String.raw`\d`, "[0-9]")
        : rewritePatterns(child);
  }
  return result;
}
