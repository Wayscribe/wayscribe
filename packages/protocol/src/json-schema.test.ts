import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./envelope.js";
import { PROTOCOL_ERROR_CODES } from "./errors.js";
import { REGENERATE_COMMAND, buildJsonSchemas, serializeSchema } from "./json-schema.js";
import { PROTOCOL_VERSION } from "./version.js";

const schemaDirectory = fileURLToPath(new URL(`../schemas/${PROTOCOL_VERSION}/`, import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("../fixtures/", import.meta.url));

const built = buildJsonSchemas();

const readSchemaFile = (name: string): string =>
  readFileSync(`${schemaDirectory}${name}.schema.json`, "utf8");

describe("the generated schema files", () => {
  it("has one committed file per built schema, and no others", () => {
    const committed = readdirSync(schemaDirectory)
      .filter((name) => name.endsWith(".schema.json"))
      .map((name) => name.replace(".schema.json", ""))
      .sort();
    expect(committed).toEqual(Object.keys(built).sort());
  });

  it.each(Object.keys(built))("%s.schema.json matches the generator byte for byte", (name) => {
    // Byte for byte rather than a parsed comparison: the files are read by
    // tools outside this repository, and a reordering or a formatting change
    // is a change to what is published.
    const schema = built[name];
    expect(schema).toBeDefined();
    expect(
      readSchemaFile(name),
      `${name}.schema.json is out of date. Regenerate it with: ${REGENERATE_COMMAND}`
    ).toBe(serializeSchema(schema ?? {}));
  });

  it("names each file by its own basename and refers to siblings the same way", () => {
    expect(built["event"]?.["$id"]).toBe("event.schema.json");
    const envelope = built["envelope"] as { properties: { event: { $ref: string } } };
    expect(envelope.properties.event.$ref).toBe("event.schema.json");
  });

  it("gives every file a title and a description, neither naming the product", () => {
    for (const [name, schema] of Object.entries(built)) {
      expect(schema["title"], `${name} has no title`).toBeTypeOf("string");
      expect(schema["description"], `${name} has no description`).toBeTypeOf("string");
      const text = `${String(schema["title"])} ${String(schema["description"])}`.toLowerCase();
      // The product is about to be renamed; a name in a published artefact is
      // a thing to rewrite later (ADR-049).
      expect(text, `${name} names the product`).not.toMatch(/flight.?recorder/);
    }
  });

  it("emits no pattern containing \\d", () => {
    // ASCII digits in ECMAScript, Unicode decimal digits in Python and .NET.
    // A validator in one of those would accept a timestamp in Arabic-Indic
    // digits that Zod refuses, so the generator rewrites it to [0-9].
    for (const [name, schema] of Object.entries(built)) {
      for (const pattern of patternsIn(schema)) {
        expect(pattern, `${name} has a pattern containing \\d`).not.toContain(String.raw`\d`);
      }
    }
  });

  it("still emits the timestamp pattern it rewrote", () => {
    // The control: a rewrite that emitted no pattern at all would satisfy the
    // assertion above.
    const event = built["event"] as { properties: Record<string, { pattern?: string }> };
    expect(event.properties["timestamp"]?.pattern).toContain("[0-9]{4}");
  });

  it("serializes with two spaces and a trailing newline", () => {
    const text = serializeSchema({ a: 1 });
    expect(text).toBe('{\n  "a": 1\n}\n');
  });
});

/**
 * Zod and Ajv have to agree about every fixture this repository ships.
 *
 * The Zod side is `parseEnvelope`, not `envelopeSchema`, because that is what
 * ingestion calls: it checks the version before the event, which is where
 * `unsupported_protocol_version` comes from. The Ajv side is the generated
 * `envelope.schema.json` with `event.schema.json` in the same instance.
 *
 * The comparison is accept versus reject only. JSON Schema has no way to say
 * which of two refusals applies, so the test also asserts that a rejected case
 * expects one of the two codes that come out of the schema at all; every other
 * refusal in this system happens outside it and must be accepted by both.
 */
describe("Zod and Ajv agree", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false });
  ajv.addSchema(built["event"] ?? {});
  const validate: ValidateFunction = ajv.compile(built["envelope"] ?? {});

  const SCHEMA_CODES: string[] = [
    PROTOCOL_ERROR_CODES.invalidEvent,
    PROTOCOL_ERROR_CODES.unsupportedProtocolVersion
  ];

  interface BoundaryCase {
    name: string;
    why: string;
    envelope: unknown;
    valid: boolean;
    code?: string;
  }

  const boundaries = JSON.parse(
    readFileSync(`${fixtureDirectory}v0.1-boundaries.json`, "utf8")
  ) as BoundaryCase[];

  const files = readdirSync(fixtureDirectory)
    .filter((name) => name.startsWith("v0.1-") && name !== "v0.1-boundaries.json")
    .sort();

  const cases: BoundaryCase[] = [
    ...files.map((file) => ({
      name: file,
      why: "a committed protocol fixture",
      envelope: JSON.parse(readFileSync(`${fixtureDirectory}${file}`, "utf8")) as unknown,
      valid: file.includes("valid-") && !file.includes("invalid-"),
      ...(file.includes("invalid-") ? { code: PROTOCOL_ERROR_CODES.invalidEvent } : {})
    })),
    ...boundaries
  ];

  it("has a boundary file with cases in it", () => {
    expect(boundaries.length).toBeGreaterThan(20);
    expect(files.length).toBe(5);
  });

  it.each(cases.map((one) => [one.name, one] as const))("%s", (_name, one) => {
    const zod = parseEnvelope(one.envelope);
    expect(zod.ok, `Zod disagrees with the fixture: ${one.why}`).toBe(one.valid);
    expect(validate(one.envelope), `Ajv disagrees with Zod: ${one.why}`).toBe(one.valid);

    if (one.valid) return;
    expect(one.code, `${one.name} is invalid and names no code`).toBeDefined();
    expect(SCHEMA_CODES, `${one.name} expects a code the schema cannot produce`).toContain(
      one.code
    );
    if (!zod.ok) expect(zod.code).toBe(one.code);
  });
});

function patternsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) patternsIn(child, found);
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "pattern" && typeof child === "string") found.push(child);
    else patternsIn(child, found);
  }
  return found;
}
