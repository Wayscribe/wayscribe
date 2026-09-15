import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";

/**
 * The conformance case format, its expansion, and its comparison.
 *
 * One module, exported as `@flight-recorder/protocol/conformance`, because
 * three consumers read these files: the API's integration tests, the Node SDK's
 * unit tests, and the SDK-through-the-dry-run tests. Three implementations of
 * the matcher would be three subtly different contracts.
 *
 * An implementation in another language reimplements this. It is about a
 * hundred lines, and `docs/INGESTION_CONTRACT.md` specifies the format, the tag
 * list and the matcher rules, so it is read in the same document as the routes.
 */

const matcherSchema = z.union([
  z.object({ $matches: z.string() }),
  z.object({ $absent: z.literal(true) })
]);

const expectedResultSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  duplicate: z.boolean().optional(),
  eventId: z.union([z.string(), matcherSchema, z.null()]).optional(),
  error: z.object({ code: z.string(), httpStatus: z.number().int() }).optional(),
  stored: z
    .object({
      event: z.record(z.string(), z.unknown()),
      journey: z.record(z.string(), z.unknown())
    })
    .partial()
    .optional()
});

const recorderCallSchema = z.object({
  call: z.enum([
    "record",
    "transform",
    "persist",
    "publish",
    "deliver",
    "identify",
    "fail",
    "finish"
  ]),
  name: z.string().optional(),
  repeat: z.number().int().positive().optional(),
  args: z.record(z.string(), z.unknown()).optional()
});

/**
 * A case file, validated on load.
 *
 * `strict()` at every level, so a typo in a key is a failing test rather than a
 * silently skipped expectation. That is the failure mode this whole suite
 * exists to prevent: a fixture that asserts nothing passes forever.
 */
export const conformanceCaseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** Where the expected behaviour is written down: an ADR, a document section. */
    source: z.string().min(1),
    layer: z.enum(["wire", "sdk", "otlp"]),
    /** `["*"]`, or the languages that can express the case's values. */
    languages: z.array(z.string().min(1)).min(1),
    setup: z
      .object({
        environment: z
          .object({
            captureMode: z.enum([
              "metadata-only",
              "allowlisted-fields",
              "redacted-payload",
              "full-payload"
            ]),
            allowFullPayload: z.boolean().optional(),
            redactionPaths: z.array(z.string()).optional(),
            captureAllowlist: z.array(z.string()).optional()
          })
          .strict()
          .optional(),
        /** Ingested for real, with this environment's key, before the case runs. */
        existing: z.array(z.unknown()).optional(),
        /** Ingested for real with a second environment's key. */
        otherEnvironment: z.array(z.unknown()).optional()
      })
      .strict()
      .optional(),
    /**
     * A wire case: the request body, verbatim.
     *
     * `events` is typed as anything rather than as an array, because two cases
     * exist to pin what the route does with a body whose `events` is not one.
     */
    send: z.object({ events: z.unknown() }).strict().optional(),
    /** An sdk case: the recorder calls to make. */
    calls: z.array(recorderCallSchema.strict()).optional(),
    /** An sdk case: the recorder settings it needs. */
    recorder: z.record(z.string(), z.unknown()).optional(),
    expect: z
      .object({
        /** A whole-request refusal: nothing is stored and no results are returned. */
        request: z.object({ status: z.number().int(), code: z.string() }).strict().optional(),
        results: z.array(expectedResultSchema.strict()).optional(),
        /** An sdk case: the event the SDK is expected to put on the wire. */
        wire: z.record(z.string(), z.unknown()).optional()
      })
      .strict()
      .refine(
        (value) => value.request !== undefined || value.results !== undefined,
        "expect must carry either request or results"
      )
  })
  .strict()
  .refine(
    (value) => (value.layer === "wire" ? value.send !== undefined : true),
    "a wire case must carry send"
  )
  .refine(
    (value) => (value.layer === "sdk" ? value.calls !== undefined : true),
    "an sdk case must carry calls"
  )
  .refine(
    (value) => (value.send === undefined) !== (value.calls === undefined),
    "a case carries exactly one of send and calls"
  );

export type ConformanceCase = z.infer<typeof conformanceCaseSchema>;

/**
 * Load every case in a directory, validated and sorted by id.
 *
 * Sorted so that a run's order does not depend on the filesystem, which makes a
 * failure reproducible and a diff of the reported list readable.
 */
export function loadConformanceCases(directory: string): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const raw: unknown = JSON.parse(readFileSync(`${directory}/${file}`, "utf8"));
    const parsed = conformanceCaseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${file} is not a valid conformance case: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`
      );
    }
    cases.push(parsed.data);
  }
  return cases;
}

/** Whether a harness for this language can run the case. */
export function appliesTo(one: ConformanceCase, language: string): boolean {
  return one.languages.includes("*") || one.languages.includes(language);
}

export interface ExpandOptions {
  /** Replaces `{{run}}`, so ids do not collide between runs of the same case. */
  run: string;
  /**
   * Whether the tagged host values an `sdk` case may carry are expanded.
   *
   * Off for a `wire` case: its `send` is a request body, and a body cannot hold
   * a `Date` or a `BigInt`, so a tag there is a mistake rather than a value.
   */
  host?: boolean;
}

const RUN_TOKEN = "{{run}}";

/**
 * Expand a case's builders, host tags and `{{run}}` tokens into real values.
 *
 * Two passes: the first builds everything, the second resolves `$cycle` and
 * `$ref`, which are JSON pointers into the finished structure and cannot be
 * resolved while it is still being built.
 */
export function expand(value: unknown, options: ExpandOptions): unknown {
  const deferred: { parent: Record<string, unknown> | unknown[]; key: string; pointer: string }[] =
    [];
  const built = build(value, options, deferred);
  for (const { parent, key, pointer } of deferred) {
    const target = resolvePointer(built, pointer);
    if (Array.isArray(parent)) parent[Number(key)] = target;
    else parent[key] = target;
  }
  return built;
}

function build(
  value: unknown,
  options: ExpandOptions,
  deferred: { parent: Record<string, unknown> | unknown[]; key: string; pointer: string }[]
): unknown {
  if (typeof value === "string") return value.replaceAll(RUN_TOKEN, options.run);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const [index, child] of value.entries()) {
      result.push(placeOrDefer(child, options, deferred, result, String(index)));
    }
    return result;
  }
  if (typeof value !== "object" || value === null) return value;

  const tagged = singleTag(value as Record<string, unknown>);
  if (tagged !== undefined) return buildTag(tagged.tag, tagged.value, options, deferred);

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const name = key.replaceAll(RUN_TOKEN, options.run);
    // Defined rather than assigned, so a case can carry a `__proto__` key: the
    // defect these fixtures exist to pin.
    Object.defineProperty(result, name, {
      value: placeOrDefer(child, options, deferred, result, name),
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return result;
}

function placeOrDefer(
  child: unknown,
  options: ExpandOptions,
  deferred: { parent: Record<string, unknown> | unknown[]; key: string; pointer: string }[],
  parent: Record<string, unknown> | unknown[],
  key: string
): unknown {
  const tagged =
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? singleTag(child as Record<string, unknown>)
      : undefined;
  if (tagged !== undefined && (tagged.tag === "$cycle" || tagged.tag === "$ref")) {
    if (options.host !== true) throw new Error(`${tagged.tag} is only allowed in an sdk case.`);
    deferred.push({ parent, key, pointer: String(tagged.value) });
    return undefined;
  }
  return build(child, options, deferred);
}

/** The one key of a single-key tagged object, or undefined for an ordinary one. */
function singleTag(value: Record<string, unknown>): { tag: string; value: unknown } | undefined {
  const keys = Object.keys(value);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !key.startsWith("$")) return undefined;
  if (MATCHER_TAGS.has(key)) return undefined;
  return { tag: key, value: value[key] };
}

/** Left alone by the expander: they are compared, not built. */
const MATCHER_TAGS = new Set(["$matches", "$absent"]);

/** Tags only an `sdk` case may use, because only a host language can hold them. */
const HOST_TAGS = new Set([
  "$date",
  "$bigint",
  "$number",
  "$undefined",
  "$utf16",
  "$map",
  "$set",
  "$error",
  "$buffer",
  "$throwingGetter"
]);

function buildTag(
  tag: string,
  value: unknown,
  options: ExpandOptions,
  deferred: { parent: Record<string, unknown> | unknown[]; key: string; pointer: string }[]
): unknown {
  if (HOST_TAGS.has(tag) && options.host !== true) {
    throw new Error(`${tag} is only allowed in an sdk case.`);
  }

  switch (tag) {
    case "$literal":
      // Escapes data that genuinely starts with `$`. Strings inside it still
      // get their `{{run}}` substitution; nothing else is interpreted.
      return substituteOnly(value, options.run);
    case "$string": {
      const { char, count } = value as { char: string; count: number };
      return char.repeat(count);
    }
    case "$array": {
      const { value: element, count } = value as { value: unknown; count: number };
      const built = build(element, options, deferred);
      return Array.from({ length: count }, () => structuredCloneish(built));
    }
    case "$nest": {
      const { depth, leaf } = value as { depth: number; leaf: unknown };
      let nested: unknown = build(leaf, options, deferred);
      for (let level = 0; level < depth; level += 1) nested = { n: nested };
      return nested;
    }
    case "$date":
      return new Date(String(value));
    case "$bigint":
      return BigInt(String(value));
    case "$number": {
      const named = String(value);
      if (named === "NaN") return Number.NaN;
      if (named === "Infinity") return Number.POSITIVE_INFINITY;
      if (named === "-Infinity") return Number.NEGATIVE_INFINITY;
      throw new Error(`$number takes NaN, Infinity or -Infinity, not ${named}.`);
    }
    case "$undefined":
      return undefined;
    case "$utf16":
      // A string built from code units, which is the only way to write a lone
      // surrogate: JSON cannot carry one and neither can a source literal.
      return String.fromCharCode(...(value as number[]));
    case "$map":
      return new Map(Object.entries(build(value, options, deferred) as Record<string, unknown>));
    case "$set":
      return new Set(build(value, options, deferred) as unknown[]);
    case "$error": {
      const { name, message } = value as { name?: string; message: string };
      const error = new Error(message);
      if (name !== undefined) error.name = name;
      return error;
    }
    case "$buffer":
      return Buffer.from(String(value), "utf8");
    case "$throwingGetter": {
      const thrown = String(value);
      const host = {};
      Object.defineProperty(host, "value", {
        get(): never {
          throw new Error(thrown);
        },
        enumerable: true
      });
      return host;
    }
    default:
      throw new Error(`Unknown tag ${tag} in a conformance case.`);
  }
}

/** A deep copy that keeps `__proto__` as an own key, unlike a spread of a parsed object. */
function structuredCloneish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredCloneish);
  if (typeof value !== "object" || value === null) return value;
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      value: structuredCloneish(child),
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return result;
}

function substituteOnly(value: unknown, run: string): unknown {
  if (typeof value === "string") return value.replaceAll(RUN_TOKEN, run);
  if (Array.isArray(value)) return value.map((child) => substituteOnly(child, run));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(result, key.replaceAll(RUN_TOKEN, run), {
      value: substituteOnly(child, run),
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return result;
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "#") return root;
  let current: unknown = root;
  for (const rawSegment of pointer.replace(/^#?\//, "").split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else throw new Error(`JSON pointer ${pointer} does not resolve.`);
  }
  return current;
}

/**
 * Compare an actual value with an expectation: a subset at the top level, and
 * exact underneath.
 *
 * A key listed at the top of `stored.event`, `stored.journey` or `wire` must be
 * present and deep-equal; a key not listed is not compared, because a case
 * should not have to restate the whole stored shape to assert one field. Below
 * that first level the comparison is exact, including the key set, so a dropped
 * field fails. That is deliberate: `not.toContain(secret)` passes just as well
 * against a field that was deleted, which is the mistake
 * `docs/WHAT_RUNNING_IT_FOUND.md` records.
 *
 * Returns the problems, so a failure names every one rather than the first.
 */
export function compareExpectation(actual: unknown, expected: unknown, path = ""): string[] {
  return compare(actual, expected, path, true);
}

function compare(actual: unknown, expected: unknown, path: string, subset: boolean): string[] {
  const where = path === "" ? "the value" : path;

  if (isMatcher(expected, "$matches")) {
    const pattern = (expected as { $matches: string }).$matches;
    if (typeof actual !== "string") return [`${where}: expected a string matching /${pattern}/`];
    return new RegExp(pattern).test(actual)
      ? []
      : [`${where}: ${JSON.stringify(actual)} does not match /${pattern}/`];
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${where}: expected an array`];
    if (actual.length !== expected.length) {
      return [`${where}: expected ${String(expected.length)} items, got ${String(actual.length)}`];
    }
    return expected.flatMap((child, index) =>
      compare(actual[index], child, `${path}[${String(index)}]`, false)
    );
  }

  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return [`${where}: expected an object`];
    const problems: string[] = [];

    for (const [key, child] of Object.entries(expected)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (isMatcher(child, "$absent")) {
        if (Object.hasOwn(actual, key)) problems.push(`${childPath}: expected to be absent`);
        continue;
      }
      if (!Object.hasOwn(actual, key)) {
        problems.push(`${childPath}: expected to be present`);
        continue;
      }
      problems.push(...compare(actual[key], child, childPath, false));
    }

    if (!subset) {
      const listed = new Set(
        Object.entries(expected)
          .filter(([, child]) => !isMatcher(child, "$absent"))
          .map(([key]) => key)
      );
      for (const key of Object.keys(actual)) {
        if (!listed.has(key)) {
          problems.push(`${path === "" ? key : `${path}.${key}`}: present and not expected`);
        }
      }
    }

    return problems;
  }

  if (!Object.is(actual, expected)) {
    return [`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  return [];
}

function isMatcher(value: unknown, tag: "$matches" | "$absent"): boolean {
  return isPlainObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, tag);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
