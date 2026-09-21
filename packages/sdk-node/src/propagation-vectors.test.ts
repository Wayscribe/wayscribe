import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractHttpContext,
  extractPayload,
  extractSqsContext,
  hasJourney,
  injectHttpHeaders,
  injectPayload,
  injectSqsAttributes,
  type HttpHeadersInput,
  type PropagatedContext,
  type PropagationLevel
} from "./propagation.js";

type Carrier = "http" | "sqs" | "payload";
type Action = "inject" | "extract";

interface Vector {
  name: string;
  carrier: Carrier;
  action: Action;
  input: Record<string, unknown>;
  expected: unknown;
}

interface Fixture {
  version: number;
  cases: Vector[];
}

const fixture = JSON.parse(
  readFileSync(new URL("../../protocol/fixtures/propagation.json", import.meta.url), "utf8")
) as Fixture;

const contextOf = (input: Record<string, unknown>): PropagatedContext =>
  input["context"] as PropagatedContext;

const levelOf = (input: Record<string, unknown>): PropagationLevel =>
  input["level"] as PropagationLevel;

const run = (vector: Vector): unknown => {
  const { input } = vector;

  if (vector.action === "inject") {
    if (vector.carrier === "http") {
      return injectHttpHeaders(
        input["carrier"] as Record<string, string>,
        contextOf(input),
        levelOf(input)
      );
    }
    if (vector.carrier === "sqs") {
      return injectSqsAttributes(
        input["carrier"] as Record<string, unknown>,
        contextOf(input),
        levelOf(input)
      );
    }

    const envelope = injectPayload(input["data"], contextOf(input), levelOf(input));
    expect(hasJourney(envelope)).toBe(true);
    return envelope;
  }

  if (vector.carrier === "http") {
    return extractHttpContext(input["carrier"] as HttpHeadersInput) ?? null;
  }
  if (vector.carrier === "sqs") {
    return extractSqsContext(input["carrier"]) ?? null;
  }

  const extracted = extractPayload(input["carrier"]);
  return { context: extracted.context ?? null, data: extracted.data };
};

describe("language-neutral propagation vectors", () => {
  it("uses fixture schema version 1", () => {
    expect(fixture.version).toBe(1);
  });

  it.each(fixture.cases)("$name", (vector) => {
    expect(run(vector)).toEqual(vector.expected);
  });
});
