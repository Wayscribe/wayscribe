import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The derivation fixture, checked against the algorithm it states rather than
 * against the Node SDK.
 *
 * The vectors were computed outside this repository's code. This test
 * recomputes them from the fixture's own `algorithm` description, which is what
 * an implementer in another language reads, so a vector that drifted from the
 * description fails here even if an SDK drifted with it.
 */

interface Fixture {
  algorithm: { label: string; prefix: string; minimumSecretBytes: number };
  vectors: {
    name: string;
    secret: string;
    environment: string;
    entity: { type: string; id: string };
    journeyId: string;
  }[];
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/journey-id-derivation.json", import.meta.url), "utf8")
) as Fixture;

function field(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

describe("journey id derivation vectors", () => {
  it.each(fixture.vectors.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      expect(Buffer.byteLength(vector.secret, "utf8")).toBeGreaterThanOrEqual(
        fixture.algorithm.minimumSecretBytes
      );
      const mac = createHmac("sha256", Buffer.from(vector.secret, "utf8"))
        .update(
          Buffer.concat(
            [fixture.algorithm.label, vector.environment, vector.entity.type, vector.entity.id].map(
              field
            )
          )
        )
        .digest("hex");
      expect(vector.journeyId).toBe(`${fixture.algorithm.prefix}${mac.slice(0, 32)}`);
    }
  );

  it("has no two vectors with one id, and pins the ambiguity a separator would have", () => {
    const ids = fixture.vectors.map((vector) => vector.journeyId);
    expect(new Set(ids).size).toBe(ids.length);
    const naive = fixture.vectors.map(
      (vector) => `${vector.environment}${vector.entity.type}${vector.entity.id}${vector.secret}`
    );
    expect(new Set(naive).size).toBeLessThan(naive.length);
  });
});
