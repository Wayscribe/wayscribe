import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./diagnostics.js";
import { createRecorder, type RecorderConfig } from "./index.js";
import { forgetSecretWarning } from "./journey-id.js";
import { extractHttpContext } from "./propagation.js";

/**
 * A journey id derived from the entity under a secret the host holds.
 *
 * The same record lands in the same journey on every run and every machine,
 * which is what a job that has no store of its own needs, and the id cannot be
 * guessed by anybody without the secret, which an unkeyed hash of the entity
 * would allow (INGESTION_CONTRACT.md section 5).
 */

interface Vector {
  name: string;
  secret: string;
  environment: string;
  entity: { type: string; id: string };
  journeyId: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../../protocol/fixtures/journey-id-derivation.json", import.meta.url),
    "utf8"
  )
) as { vectors: Vector[]; refused: Omit<Vector, "journeyId">[] };

const base: RecorderConfig = {
  endpoint: "http://127.0.0.1:1",
  apiKey: "fr_test",
  serviceName: "svc",
  environment: "production"
};

const SECRET = "a secret of at least thirty-two bytes, for tests";

function recorderWith(settings: Partial<RecorderConfig>): {
  recorder: ReturnType<typeof createRecorder>;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const recorder = createRecorder({
    ...base,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    ...settings
  });
  return { recorder, diagnostics };
}

describe("journeyIdFor", () => {
  it.each(fixture.vectors.map((vector) => [vector.name, vector] as const))(
    "reproduces the vector: %s",
    (_name, vector) => {
      const { recorder, diagnostics } = recorderWith({
        environment: vector.environment,
        journeyIdSecret: vector.secret
      });
      expect(recorder.journeyIdFor(vector.entity)).toBe(vector.journeyId);
      expect(diagnostics).toEqual([]);
    }
  );

  it("is stable across recorders, which is the point", () => {
    const entity = { type: "job_posting", id: "greenhouse:1" };
    const first = recorderWith({ journeyIdSecret: SECRET }).recorder.journeyIdFor(entity);
    const second = recorderWith({ journeyIdSecret: SECRET }).recorder.journeyIdFor(entity);
    expect(first).toBe(second);
  });

  it("produces an id propagation and the protocol accept", () => {
    const { recorder } = recorderWith({ journeyIdSecret: SECRET });
    const id = recorder.journeyIdFor({ type: "customer", id: "顧客-42" });
    expect(id).toMatch(/^jrn_[0-9a-f]{32}$/);
    // The protocol's journey id limit, and the propagation grammar's.
    expect(id.length).toBeLessThanOrEqual(128);
    expect(extractHttpContext({ "x-flight-journey-id": id })).toEqual({ journeyId: id });
  });

  it("can be used to continue a journey", () => {
    const { recorder } = recorderWith({ journeyIdSecret: SECRET });
    const entity = { type: "job_posting", id: "lever:9" };
    const journey = recorder.continueJourney({ journeyId: recorder.journeyIdFor(entity), entity });
    expect(journey.context().journeyId).toBe(recorder.journeyIdFor(entity));
  });

  describe("without a usable secret", () => {
    it("does not throw, returns a fresh random id, and reports a configuration error", () => {
      const { recorder, diagnostics } = recorderWith({});
      const entity = { type: "customer", id: "1" };
      const first = recorder.journeyIdFor(entity);
      const second = recorder.journeyIdFor(entity);
      expect(first).toMatch(/^jrn_/);
      expect(first).not.toBe(second);
      expect(recorder.counters().configurationErrors).toBe(2);
      expect(diagnostics.map((d) => [d.kind, d.code])).toEqual([
        ["configuration_error", "journey_id_secret_missing"],
        ["configuration_error", "journey_id_secret_missing"]
      ]);
      expect(diagnostics[0]?.reason).toContain("journeyIdSecret");
    });

    it("reports a short secret once when the recorder is created, and never uses it", () => {
      const short = "only twenty-nine bytes long..";
      const { recorder, diagnostics } = recorderWith({ journeyIdSecret: short });
      expect(recorder.counters().configurationErrors).toBe(1);
      expect(diagnostics[0]).toMatchObject({
        code: "journey_id_secret_unusable",
        detail: { setting: "journeyIdSecret" }
      });
      expect(diagnostics[0]?.reason).toContain("32 bytes");
      // The secret itself is never repeated back.
      expect(JSON.stringify(diagnostics)).not.toContain(short);

      const entity = { type: "customer", id: "1" };
      expect(recorder.journeyIdFor(entity)).not.toBe(recorder.journeyIdFor(entity));
      expect(recorder.counters().configurationErrors).toBe(3);
    });

    it("counts bytes, not characters", () => {
      // Sixteen characters of three bytes each: 48 bytes.
      const { recorder } = recorderWith({ journeyIdSecret: "秘".repeat(16) });
      expect(recorder.counters().configurationErrors).toBe(0);
      const entity = { type: "customer", id: "1" };
      expect(recorder.journeyIdFor(entity)).toBe(recorder.journeyIdFor(entity));
    });

    it("treats a secret that is not a string as missing", () => {
      const { recorder } = recorderWith({
        journeyIdSecret: Buffer.alloc(64) as unknown as string
      });
      expect(recorder.counters().configurationErrors).toBe(1);
      expect(() => recorder.journeyIdFor({ type: "a", id: "b" })).not.toThrow();
    });

    it("reports an entity that is not a pair of strings the same way", () => {
      const { recorder, diagnostics } = recorderWith({ journeyIdSecret: SECRET });
      const id = recorder.journeyIdFor({ type: "customer", id: 42 } as unknown as {
        type: string;
        id: string;
      });
      expect(id).toMatch(/^jrn_/);
      expect(diagnostics.map((d) => [d.kind, d.code])).toEqual([
        ["configuration_error", "entity_invalid"]
      ]);
      expect(() => recorder.journeyIdFor(undefined as never)).not.toThrow();
    });
  });

  describe("an entity that cannot be encoded faithfully", () => {
    it("refuses a lone surrogate rather than deriving the id of its replacement", () => {
      // UTF-8 encoding turns an unpaired surrogate into U+FFFD, so "a\uD800"
      // and "a\uFFFD" would derive one id. Such an id is unstorable on the
      // server anyway.
      const { recorder, diagnostics } = recorderWith({ journeyIdSecret: SECRET });
      const replaced = recorder.journeyIdFor({ type: "customer", id: "a\uFFFD" });
      expect(recorder.journeyIdFor({ type: "customer", id: "a\uFFFD" })).toBe(replaced);

      const lone = { type: "customer", id: "a\uD800" };
      const first = recorder.journeyIdFor(lone);
      expect(first).not.toBe(replaced);
      expect(first).not.toBe(recorder.journeyIdFor(lone));
      expect(diagnostics.map((d) => d.kind)).toEqual([
        "configuration_error",
        "configuration_error"
      ]);
      expect(diagnostics[0]?.reason).toContain("unpaired surrogate");
    });

    it("refuses one in the entity type too", () => {
      const { recorder } = recorderWith({ journeyIdSecret: SECRET });
      recorder.journeyIdFor({ type: "\uDC00x", id: "1" });
      expect(recorder.counters().configurationErrors).toBe(1);
    });

    it.each(fixture.refused.map((one) => [one.name, one] as const))(
      "refuses the fixture's entity: %s",
      (_name, one) => {
        const { recorder } = recorderWith({
          environment: one.environment,
          journeyIdSecret: one.secret
        });
        const id = recorder.journeyIdFor(one.entity);
        expect(id).toMatch(/^jrn_/);
        expect(fixture.vectors.map((vector) => vector.journeyId)).not.toContain(id);
        expect(recorder.counters().configurationErrors).toBe(1);
      }
    );
  });

  describe("the warning a missing secret prints", () => {
    const printed = (): { lines: string[]; restore: () => void } => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      return {
        lines,
        restore: () => {
          spy.mockRestore();
        }
      };
    };

    beforeEach(() => {
      forgetSecretWarning();
    });

    it("prints one line per process, with logDiagnostics off", () => {
      const { lines, restore } = printed();
      try {
        const first = recorderWith({}).recorder;
        first.journeyIdFor({ type: "a", id: "1" });
        first.journeyIdFor({ type: "a", id: "2" });
        recorderWith({ journeyIdSecret: "too short" }).recorder.journeyIdFor({
          type: "a",
          id: "3"
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("configuration_error");
        expect(lines[0]).toContain("journeyIdSecret");
        expect(lines[0]).toContain("once per process");
      } finally {
        restore();
      }
    });

    it("prints for a short secret at creation, and never the secret", () => {
      const { lines, restore } = printed();
      try {
        recorderWith({ journeyIdSecret: "a short secret value" });
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain("a short secret value");
      } finally {
        restore();
      }
    });

    it("prints nothing when the secret is fine or never needed", () => {
      const { lines, restore } = printed();
      try {
        recorderWith({ journeyIdSecret: SECRET }).recorder.journeyIdFor({ type: "a", id: "1" });
        recorderWith({}).recorder.startJourney({ entity: { type: "a", id: "1" } });
        expect(lines).toEqual([]);
      } finally {
        restore();
      }
    });

    it("prints nothing for an entity it refuses: that is not a missing secret", () => {
      const { lines, restore } = printed();
      try {
        recorderWith({ journeyIdSecret: SECRET }).recorder.journeyIdFor({
          type: "a",
          id: "\uD800"
        });
        expect(lines).toEqual([]);
      } finally {
        restore();
      }
    });
  });

  it("reads no environment variable", () => {
    process.env["JOURNEY_ID_SECRET"] = SECRET;
    try {
      const { recorder } = recorderWith({});
      const entity = { type: "customer", id: "1" };
      expect(recorder.journeyIdFor(entity)).not.toBe(recorder.journeyIdFor(entity));
    } finally {
      delete process.env["JOURNEY_ID_SECRET"];
    }
  });
});
