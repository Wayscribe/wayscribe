import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { read, root } from "./docs-helpers.js";

/**
 * Which jobs a pipeline creates, read from .gitlab-ci.yml by evaluating its
 * rules the way GitLab does (ADR-073, issue #10).
 *
 * Every push to a branch with an open merge request used to make two
 * pipelines, and the merge request's held one job, so a green merge request
 * pipeline said almost nothing. The browser and stack jobs were manual
 * everywhere, so a 3 px journeys link and a broken smoke check both merged.
 * These tests hold the layout that replaced it: one pipeline per push, the
 * branch's work in the merge request pipeline, e2e, demo and upgrade-test
 * automatic and blocking where their code changed, and a release that
 * publishes on its own and deploys by hand.
 *
 * The reader below supports the rule syntax this file uses (`if` with `==`,
 * `!=`, `=~`, `!~`, `&&`, `||`, parentheses and `null`; `changes` as a list or
 * `paths`; `when` of on_success, manual, always or never; `allow_failure`) and
 * throws on anything else (other rule keys such as `exists` or `start_in`,
 * `when: delayed`, job-level `only` and `except`, brace patterns), so new
 * syntax cannot be misread silently.
 */

interface Rule {
  if?: string;
  changes?: string[] | { paths: string[]; compare_to?: string };
  when?: string;
  allow_failure?: boolean;
}

type Need = string | { job: string; optional?: boolean };

interface Job {
  rules?: Rule[];
  when?: string;
  allow_failure?: boolean;
  needs?: Need[];
  script?: string[];
  after_script?: string[];
  variables?: Record<string, string | number>;
}

const ci = parse(read(".gitlab-ci.yml"), { merge: true }) as Record<string, unknown> & {
  workflow?: { rules: Rule[] };
};
const KEYWORDS = new Set([
  "default",
  "variables",
  "stages",
  "workflow",
  "include",
  // Legacy global keywords, which GitLab still reads as defaults.
  "image",
  "services",
  "cache",
  "before_script",
  "after_script"
]);
const jobs = Object.fromEntries(
  Object.entries(ci).filter(([name]) => !KEYWORDS.has(name) && !name.startsWith("."))
) as Record<string, Job>;

const job = (name: string): Job => {
  const found = jobs[name];
  if (found === undefined) throw new Error(`.gitlab-ci.yml has no ${name} job`);
  return found;
};

const RULE_KEYS = new Set(["if", "changes", "when", "allow_failure"]);
const WHEN_VALUES = new Set(["on_success", "manual", "always", "never"]);

/** Throws on any rule or job syntax the reader would otherwise misread. */
function assertReadable(label: string, rules: readonly Rule[] | undefined, found?: Job): void {
  if (found !== undefined) {
    const record = found as Record<string, unknown>;
    for (const key of ["only", "except"]) {
      if (key in record) throw new Error(`${label} uses ${key}, which the reader does not model`);
    }
    if (found.when !== undefined && !WHEN_VALUES.has(found.when)) {
      throw new Error(`${label} has when: ${found.when}, which the reader does not model`);
    }
  }
  for (const rule of rules ?? []) {
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) throw new Error(`${label} has a rule with ${key}, not modelled`);
    }
    if (rule.when !== undefined && !WHEN_VALUES.has(rule.when)) {
      throw new Error(`${label} has a rule with when: ${rule.when}, not modelled`);
    }
    if (typeof rule.changes === "object" && !Array.isArray(rule.changes)) {
      for (const key of Object.keys(rule.changes)) {
        if (key !== "paths" && key !== "compare_to") {
          throw new Error(`${label} has changes with ${key}, not modelled`);
        }
      }
    }
  }
}

/** One pipeline GitLab could create. */
interface Pipeline {
  source: "push" | "merge_request_event" | "schedule" | "web" | "api";
  /** The branch pushed, or the merge request's source branch. */
  branch?: string;
  tag?: string;
  openMergeRequest?: boolean;
  /**
   * The changed files `changes:` compares: the merge request's diff, or the
   * push's. Absent where GitLab has nothing to compare and `changes:` is
   * always true (tags, schedules, runs from the UI).
   */
  files?: readonly string[];
  variables?: Record<string, string>;
}

// GITHUB_TOKEN is set in the project, so the mirror jobs exist.
const PROJECT_VARIABLES = { GITHUB_TOKEN: "configured" };

const feature = (files: readonly string[]): Pipeline => ({
  source: "push",
  branch: "feature",
  files
});
const mergeRequest = (files: readonly string[]): Pipeline => ({
  source: "merge_request_event",
  branch: "feature",
  openMergeRequest: true,
  files
});
const main = (files: readonly string[]): Pipeline => ({ source: "push", branch: "main", files });
const schedule = (variables: Record<string, string> = {}): Pipeline => ({
  source: "schedule",
  branch: "main",
  variables
});
const tag = (name: string): Pipeline => ({ source: "push", tag: name });

function variablesOf(pipeline: Pipeline): Record<string, string> {
  const variables: Record<string, string> = {
    ...PROJECT_VARIABLES,
    CI_DEFAULT_BRANCH: "main",
    CI_PIPELINE_SOURCE: pipeline.source,
    // Release tags are protected (SECURITY.md); a test of an unprotected one overrides this.
    CI_COMMIT_REF_PROTECTED: "true",
    ...pipeline.variables
  };
  if (pipeline.tag !== undefined) variables["CI_COMMIT_TAG"] = pipeline.tag;
  // A merge request pipeline has no CI_COMMIT_BRANCH; it has the MR's variables instead.
  else if (pipeline.source !== "merge_request_event" && pipeline.branch !== undefined) {
    variables["CI_COMMIT_BRANCH"] = pipeline.branch;
  }
  if (pipeline.openMergeRequest === true) {
    variables["CI_OPEN_MERGE_REQUESTS"] = "jojithedev/wayscribe!11";
  }
  return variables;
}

/** A `rules:if` expression, evaluated as GitLab does. */
function evaluate(expression: string, variables: Record<string, string>): boolean {
  const tokens =
    expression.match(
      /\$\w+|"[^"]*"|'[^']*'|\/(?:\\.|[^/\\])+\/[a-z]*|&&|\|\||[=!]=|[=!]~|[()]|\S+/g
    ) ?? [];
  let at = 0;
  const next = (): string => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`unexpected end of ${expression}`);
    return token;
  };
  const operand = (token: string): string | undefined => {
    if (token.startsWith("$")) return variables[token.slice(1)];
    if (token === "null") return undefined;
    if (/^["']/.test(token)) return token.slice(1, -1);
    throw new Error(`unsupported operand ${token} in ${expression}`);
  };
  const atom = (): boolean => {
    const token = next();
    if (token === "(") {
      const inner = either();
      if (next() !== ")") throw new Error(`unbalanced parentheses in ${expression}`);
      return inner;
    }
    const operator = tokens[at];
    if (operator === "==" || operator === "!=") {
      at++;
      return (operand(token) === operand(next())) === (operator === "==");
    }
    if (operator === "=~" || operator === "!~") {
      at++;
      const literal = /^\/(.*)\/([a-z]*)$/.exec(next());
      if (literal === null) throw new Error(`expected a regex in ${expression}`);
      const subject = operand(token);
      const matched =
        subject !== undefined && new RegExp(literal[1] ?? "", literal[2] ?? "").test(subject);
      return matched === (operator === "=~");
    }
    const value = operand(token);
    return value !== undefined && value !== "";
  };
  const both = (): boolean => {
    let result = atom();
    while (tokens[at] === "&&") {
      at++;
      const right = atom();
      result = result && right;
    }
    return result;
  };
  const either = (): boolean => {
    let result = both();
    while (tokens[at] === "||") {
      at++;
      const right = both();
      result = result || right;
    }
    return result;
  };
  const result = either();
  if (at !== tokens.length) {
    throw new Error(`cannot read ${tokens.slice(at).join(" ")} in ${expression}`);
  }
  return result;
}

/**
 * A `changes:` pattern, as GitLab's fnmatch reads it (Ruby's File.fnmatch with
 * FNM_PATHNAME, FNM_DOTMATCH and FNM_EXTGLOB): `*` stays within a directory,
 * `**` followed by a slash, at the start of a pattern or after a slash, matches
 * zero or more directories, and any other `**` (a trailing `apps/web/**`)
 * is only `*`, so it does not recurse.
 */
function globToRegExp(glob: string): RegExp {
  if (/[{[]/.test(glob)) throw new Error(`pattern ${glob} uses a syntax the reader does not model`);
  let source = "";
  for (let index = 0; index < glob.length; index++) {
    const character = glob.charAt(index);
    if (character === "*" && glob.charAt(index + 1) === "*") {
      if (glob.charAt(index + 2) === "/" && (index === 0 || glob.charAt(index - 1) === "/")) {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += "[^/]*";
        index += 1;
      }
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function changed(changes: Rule["changes"], pipeline: Pipeline): boolean {
  if (changes === undefined || pipeline.files === undefined) return true;
  const patterns = Array.isArray(changes) ? changes : changes.paths;
  return pipeline.files.some((file) =>
    patterns.some((pattern) => globToRegExp(pattern).test(file))
  );
}

interface Outcome {
  when: string;
  allowFailure: boolean;
}
const NEVER: Outcome = { when: "never", allowFailure: false };

/** Whether `name` is in the pipeline, and how. */
function outcome(name: string, pipeline: Pipeline): Outcome {
  const found = job(name);
  assertReadable(name, found.rules, found);
  if (found.rules === undefined) {
    // No rules is GitLab's `only: [branches, tags]`, which leaves merge request pipelines out.
    if (pipeline.source === "merge_request_event") return NEVER;
    const when = found.when ?? "on_success";
    return { when, allowFailure: found.allow_failure ?? when === "manual" };
  }
  const variables = variablesOf(pipeline);
  for (const rule of found.rules) {
    if (rule.if !== undefined && !evaluate(rule.if, variables)) continue;
    if (!changed(rule.changes, pipeline)) continue;
    const when = rule.when ?? found.when ?? "on_success";
    if (when === "never") return NEVER;
    // A manual job may fail by default, unless `when: manual` is a rule's.
    const allowFailure =
      rule.allow_failure ?? found.allow_failure ?? (when === "manual" && rule.when === undefined);
    return { when, allowFailure };
  }
  return NEVER;
}

function created(pipeline: Pipeline): boolean {
  const rules = ci.workflow?.rules;
  assertReadable("workflow", rules);
  if (rules !== undefined) {
    const variables = variablesOf(pipeline);
    const first = rules.find(
      (rule) =>
        (rule.if === undefined || evaluate(rule.if, variables)) && changed(rule.changes, pipeline)
    );
    if (first === undefined || first.when === "never") return false;
  }
  return Object.keys(jobs).some((name) => outcome(name, pipeline).when !== "never");
}

const needNames = (name: string): string[] =>
  (job(name).needs ?? []).map((need) => (typeof need === "string" ? need : need.job));

/** The jobs a created pipeline holds, as names. */
const jobsIn = (pipeline: Pipeline): string[] =>
  created(pipeline)
    ? Object.keys(jobs).filter((name) => outcome(name, pipeline).when !== "never")
    : [];

const blocks = (result: Outcome): boolean => result.when === "on_success" && !result.allowFailure;

/** Every workspace package `starts` depends on, directly or not, as directories. */
function workspaceDependencies(starts: readonly string[]): string[] {
  const directories = new Map<string, string>();
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(`${root}${parent}`)) {
      const manifest = `${parent}/${entry}/package.json`;
      if (!existsSync(`${root}${manifest}`)) continue;
      directories.set((JSON.parse(read(manifest)) as { name: string }).name, `${parent}/${entry}`);
    }
  }
  const found = new Set<string>();
  const queue = [...starts];
  for (const directory of queue) {
    const manifest = JSON.parse(read(`${directory}/package.json`)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies
    })) {
      if (!range.startsWith("workspace:")) continue;
      const dependency = directories.get(name);
      if (dependency === undefined) throw new Error(`${directory} needs ${name}, not found`);
      if (!found.has(dependency)) {
        found.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...found].sort();
}

const asFiles = (directories: readonly string[]): string[] =>
  directories.flatMap((directory) => [`${directory}/package.json`, `${directory}/src/index.ts`]);

/** Changed-file sets the branch and merge request comparisons run over. */
const CHANGES: readonly (readonly string[])[] = [
  ["README.md"],
  [".gitlab-ci.yml"],
  ["apps/web/app/page.tsx"],
  ["apps/api/src/server.ts"],
  ["apps/demo/src/history.ts"],
  ["deploy/demo/smoke-check.sh"],
  ["infrastructure/compose.yaml"],
  ["packages/database/src/index.ts"],
  ["packages/sdk-node/src/index.ts"],
  ["packages/sdk-python/pyproject.toml"],
  ["scripts/publish-sdk.sh"],
  ["site/src/content/docs/index.mdx"],
  ["video/src/index.ts"]
];

/**
 * Jobs that never run on a feature branch: the release jobs, the GitHub
 * mirror, Pages, and the image builds kept to main, tags and schedules.
 */
const NOT_IN_MERGE_REQUESTS: readonly string[] = [
  "container-scan",
  "deploy-demo",
  "github-release",
  "mirror-to-github",
  "pages",
  "publish-images",
  "publish-python",
  "publish-python-testpypi",
  "publish-sdk",
  "release-verify",
  "sbom"
];

const STACK_JOBS = ["e2e", "demo", "upgrade-test"] as const;

/** The pipelines the tests that sweep every variant build. */
const VARIANTS: readonly Pipeline[] = [
  ...CHANGES.flatMap((files) => [
    feature(files),
    { ...feature(files), openMergeRequest: true },
    mergeRequest(files),
    main(files)
  ]),
  schedule(),
  schedule({ LIVE_DEMO_CHECK: "1" }),
  // A schedule or a run from the UI on a branch that has a merge request open.
  { source: "schedule", branch: "feature", openMergeRequest: true },
  { source: "web", branch: "feature", openMergeRequest: true },
  { source: "web", branch: "feature" },
  { source: "web", branch: "main" },
  // A run through the API (`glab ci run -b <branch>`).
  { source: "api", branch: "feature", openMergeRequest: true },
  { source: "api", branch: "feature" },
  tag("v0.2.7"),
  tag("v0.3.0-rc.1"),
  tag("phase-5"),
  tag("packages/sdk-python/v0.2.7"),
  tag("packages/sdk-python/v0.2.7a1")
];

describe("the rule reader", () => {
  it("evaluates the expressions this file uses", () => {
    const variables = { A: "x", B: "1", EMPTY: "" };
    expect(evaluate('$A == "x" && $B', variables)).toBe(true);
    expect(evaluate('$A == "y" || $MISSING', variables)).toBe(false);
    expect(evaluate("$MISSING == null || $EMPTY", variables)).toBe(true);
    expect(evaluate("$A =~ /^x$/", variables)).toBe(true);
    expect(evaluate("$A !~ /^x$/", variables)).toBe(false);
    expect(evaluate('($A == "y" || $B) && $A != "z"', variables)).toBe(true);
    expect(evaluate("$A == $B", variables)).toBe(false);
  });

  it("refuses syntax it does not know", () => {
    expect(() => evaluate("$A > 1", {})).toThrow();
    expect(() => evaluate("($A", {})).toThrow();
  });

  it("matches paths the way GitLab's changes do", () => {
    expect(globToRegExp("apps/web/**/*").test("apps/web/page.tsx")).toBe(true);
    expect(globToRegExp("apps/web/**/*").test("apps/web/app/a/page.tsx")).toBe(true);
    expect(globToRegExp("apps/web/**/*").test("apps/webapp/page.tsx")).toBe(false);
    // A trailing bare ** is only *: it does not recurse, while **/* does.
    expect(globToRegExp("apps/web/**").test("apps/web/x.ts")).toBe(true);
    expect(globToRegExp("apps/web/**").test("apps/web/a/b.ts")).toBe(false);
    expect(globToRegExp("apps/web/**/*").test("apps/web/x.ts")).toBe(true);
    expect(globToRegExp("apps/web/**/*").test("apps/web/a/b.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("x.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a/b/x.ts")).toBe(true);
    expect(
      globToRegExp("infrastructure/compose.*.yaml").test("infrastructure/compose.demo.yaml")
    ).toBe(true);
    expect(globToRegExp("infrastructure/compose.*.yaml").test("infrastructure/compose.yaml")).toBe(
      false
    );
  });

  it("reads every rule in the file", () => {
    for (const pipeline of VARIANTS) {
      for (const name of Object.keys(jobs)) expect(() => outcome(name, pipeline)).not.toThrow();
      expect(() => created(pipeline)).not.toThrow();
    }
    // outcome() stops at the first matching rule, so read every rule once more.
    for (const [name, found] of Object.entries(jobs)) {
      expect(() => {
        assertReadable(name, found.rules, found);
      }).not.toThrow();
      for (const rule of found.rules ?? []) {
        const paths = Array.isArray(rule.changes) ? rule.changes : rule.changes?.paths;
        for (const pattern of paths ?? []) expect(() => globToRegExp(pattern)).not.toThrow();
      }
    }
    expect(() => {
      assertReadable("workflow", ci.workflow?.rules);
    }).not.toThrow();
  });

  it("refuses rule and job syntax it does not model", () => {
    expect(() => {
      assertReadable("x", [{ exists: ["a"] } as Rule]);
    }).toThrow();
    expect(() => {
      assertReadable("x", [{ if: "$A", start_in: "1h" } as Rule]);
    }).toThrow();
    expect(() => {
      assertReadable("x", [{ when: "delayed" }]);
    }).toThrow();
    expect(() => {
      assertReadable("x", [{ changes: { paths: ["a"], x: 1 } as never }]);
    }).toThrow();
    expect(() => {
      assertReadable("x", undefined, { only: ["branches"] } as Job);
    }).toThrow();
    expect(() => {
      assertReadable("x", undefined, { except: ["tags"] } as Job);
    }).toThrow();
    expect(() => {
      assertReadable("x", undefined, { when: "delayed" });
    }).toThrow();
    expect(() => globToRegExp("apps/{web,api}/**/*")).toThrow();
    expect(() => {
      assertReadable("x", [{ if: "$A", changes: ["a"], when: "manual", allow_failure: true }]);
    }).not.toThrow();
  });
});

describe("one pipeline per push", () => {
  it.each(CHANGES.map((files) => [files.join(", "), files] as const))(
    "makes only the merge request pipeline for a push to a branch with one open (%s)",
    (_label, files) => {
      const pipelines = [{ ...feature(files), openMergeRequest: true }, mergeRequest(files)];
      expect(pipelines.filter(created).map((pipeline) => pipeline.source)).toEqual([
        "merge_request_event"
      ]);
    }
  );

  it("still makes a branch pipeline without a merge request, and main, tag and schedule pipelines", () => {
    expect(created(feature(["README.md"]))).toBe(true);
    expect(created(main(["README.md"]))).toBe(true);
    expect(created(tag("v0.2.7"))).toBe(true);
    expect(created(schedule())).toBe(true);
    expect(created(schedule({ LIVE_DEMO_CHECK: "1" }))).toBe(true);
  });
});

describe("schedules and runs from the UI", () => {
  it("creates a run through the API on a branch that has a merge request open", () => {
    expect(created({ source: "api", branch: "feature", openMergeRequest: true })).toBe(true);
    expect(created({ source: "api", branch: "feature" })).toBe(true);
  });

  it("are created even on a branch that has a merge request open", () => {
    expect(created({ source: "schedule", branch: "feature", openMergeRequest: true })).toBe(true);
    expect(created({ source: "web", branch: "feature", openMergeRequest: true })).toBe(true);
    expect(created({ source: "web", branch: "feature" })).toBe(true);
    expect(created({ source: "web", branch: "main" })).toBe(true);
  });
});

describe("needs", () => {
  it("name only jobs the same pipeline creates, unless optional", () => {
    const broken = VARIANTS.flatMap((pipeline) => {
      const present = new Set(jobsIn(pipeline));
      return [...present].flatMap((name) =>
        (job(name).needs ?? [])
          .filter((need) => typeof need === "string" || need.optional !== true)
          .map((need) => (typeof need === "string" ? need : need.job))
          .filter((target) => !present.has(target))
          .map((target) => `${name} needs ${target} (${JSON.stringify(pipeline)})`)
      );
    });
    expect(broken).toEqual([]);
  });
});

describe("merge request pipelines", () => {
  it("run every job a feature branch runs", () => {
    const missing = CHANGES.flatMap((files) =>
      Object.keys(jobs)
        .filter(
          (name) =>
            outcome(name, feature(files)).when !== "never" &&
            outcome(name, mergeRequest(files)).when === "never"
        )
        .map((name) => `${name} (${files.join(", ")})`)
    );
    expect(missing).toEqual([]);
  });

  it("leave out only the jobs that never run on a feature branch", () => {
    const absent = Object.keys(jobs).filter((name) =>
      CHANGES.every((files) => outcome(name, mergeRequest(files)).when === "never")
    );
    expect(absent.sort()).toEqual([...NOT_IN_MERGE_REQUESTS].sort());
  });

  it("have no rule that turns a job off for merge requests, outside the allow list", () => {
    const offenders = Object.entries(jobs)
      .filter(([name]) => !NOT_IN_MERGE_REQUESTS.includes(name))
      .filter(([, found]) =>
        (found.rules ?? []).some(
          (rule) => rule.if?.includes("merge_request_event") === true && rule.when === "never"
        )
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

describe("the browser and stack jobs", () => {
  it.each(STACK_JOBS)(
    "%s runs on its own, and blocks when red, on main, on schedules and on a matching merge request",
    (name) => {
      for (const pipeline of [main(["README.md"]), schedule(), mergeRequest([".gitlab-ci.yml"])]) {
        expect(outcome(name, pipeline), `${name} in a ${pipeline.source} pipeline`).toEqual({
          when: "on_success",
          allowFailure: false
        });
      }
    }
  );

  it.each(STACK_JOBS)(
    "%s is manual and cannot block a merge request that misses its paths",
    (name) => {
      expect(outcome(name, mergeRequest(["README.md"]))).toEqual({
        when: "manual",
        allowFailure: true
      });
      expect(outcome(name, feature(["README.md"]))).toEqual({ when: "manual", allowFailure: true });
    }
  );

  it("runs e2e on a merge request that changes the web app, the API, or anything they build from", () => {
    const dependencies = workspaceDependencies(["apps/web", "apps/api"]);
    expect(dependencies).toContain("packages/database");
    const files = [
      "apps/web/app/page.tsx",
      "apps/web/e2e/layout.spec.ts",
      "apps/web/e2e-live/demo.spec.ts",
      "apps/api/src/server.ts",
      "apps/api/package.json",
      "playwright.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      ".gitlab-ci.yml",
      ...asFiles(dependencies)
    ];
    expect(files.filter((file) => !blocks(outcome("e2e", mergeRequest([file]))))).toEqual([]);
  });

  it("runs demo on a merge request that changes the demo, its stack, or anything its images build from", () => {
    const dependencies = workspaceDependencies(["apps/demo", "apps/api", "apps/web"]);
    expect(dependencies).toContain("packages/sdk-node");
    const files = [
      "apps/demo/src/history.ts",
      "apps/demo/Dockerfile",
      "apps/api/src/server.ts",
      "apps/api/Dockerfile",
      "apps/web/app/page.tsx",
      "infrastructure/compose.yaml",
      "infrastructure/compose.demo.yaml",
      "infrastructure/compose.ci.yaml",
      ".env.example",
      "pnpm-lock.yaml",
      ".gitlab-ci.yml",
      ...asFiles(dependencies)
    ];
    expect(files.filter((file) => !blocks(outcome("demo", mergeRequest([file]))))).toEqual([]);
  });

  it("runs upgrade-test on a merge request that changes stored data, deployment or the test itself", () => {
    const files = [
      "packages/database/migrations/030_example.js",
      "packages/database/src/index.ts",
      "packages/payload-security/src/keys.ts",
      "deploy/helm/wayscribe/values.yaml",
      "infrastructure/compose.yaml",
      "apps/api/Dockerfile",
      "scripts/upgrade-test.mjs",
      "scripts/upgrade-test-lib.mjs",
      "scripts/upgrade-test.compose.yaml",
      ".gitlab-ci.yml"
    ];
    expect(files.filter((file) => !blocks(outcome("upgrade-test", mergeRequest([file]))))).toEqual(
      []
    );
  });

  it("covers what the demo and upgrade-test images build from, and .dockerignore", () => {
    const demo = [...workspaceDependencies(["apps/demo", "apps/api", "apps/web"])];
    const upgrade = workspaceDependencies(["apps/api"]);
    const wanted = {
      demo: [
        ...asFiles(demo),
        "apps/demo/src/history.ts",
        "apps/api/src/server.ts",
        ".dockerignore"
      ],
      "upgrade-test": [
        ...asFiles(upgrade),
        "apps/api/src/server.ts",
        "apps/api/package.json",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        ".dockerignore"
      ]
    };
    for (const [name, files] of Object.entries(wanted)) {
      expect(
        files.filter((file) => !blocks(outcome(name, mergeRequest([file])))),
        name
      ).toEqual([]);
    }
  });

  it("leaves e2e, demo and upgrade-test by hand on a merge request touching only the SDKs, the CLI or docs", () => {
    const only = [
      ["packages/sdk-python/src/wayscribe/client.py"],
      ["packages/sdk-go/client.go"],
      ["packages/cli/package.json", "packages/cli/README.md"],
      ["docs/OPERATIONS.md", "README.md"]
    ];
    for (const files of only) {
      for (const name of STACK_JOBS) {
        expect(outcome(name, mergeRequest(files)), `${name} for ${files.join(", ")}`).toEqual({
          when: "manual",
          allowFailure: true
        });
      }
    }
  });

  it("runs upgrade-test on a vX.Y.Z tag only, not on another tag", () => {
    expect(outcome("upgrade-test", tag("v0.2.7"))).toEqual({
      when: "on_success",
      allowFailure: false
    });
    for (const other of ["v0.3.0-rc.1", "phase-5", "usable-v0"]) {
      expect(outcome("upgrade-test", tag(other)).when, other).toBe("never");
    }
  });

  it("keeps e2e and demo by hand on a tag, as before", () => {
    for (const name of ["e2e", "demo"]) {
      expect(outcome(name, tag("v0.2.7"))).toEqual({ when: "manual", allowFailure: true });
    }
  });
});

describe("a release", () => {
  it("runs its gates on its own", () => {
    for (const name of ["release-verify", "upgrade-test", "demo-overlay"]) {
      expect(outcome(name, tag("v0.2.7")), name).toEqual({
        when: "on_success",
        allowFailure: false
      });
    }
  });

  it("publishes on its own once the gates pass", () => {
    for (const name of ["publish-images", "publish-sdk", "github-release"]) {
      expect(outcome(name, tag("v0.2.7")), name).toEqual({
        when: "on_success",
        allowFailure: false
      });
    }
    expect(outcome("publish-python", tag("packages/sdk-python/v0.2.7"))).toEqual({
      when: "on_success",
      allowFailure: false
    });
    expect(outcome("publish-python-testpypi", tag("packages/sdk-python/v0.2.7")).when).toBe(
      "manual"
    );
    // A pre-release may be a TestPyPI rehearsal: PyPI only by hand, never blocking.
    expect(outcome("publish-python", tag("packages/sdk-python/v0.2.7a1"))).toEqual({
      when: "manual",
      allowFailure: true
    });
  });

  it("publishes no images the overlay test failed", () => {
    expect(needNames("publish-images").sort()).toEqual(
      ["demo-overlay", "release-verify", "upgrade-test"].sort()
    );
  });

  it("holds every automatic publish on a vX.Y.Z tag behind the same gates", () => {
    // One tag is one release: a failed overlay or upgrade must not burn an npm version.
    const gates = ["demo-overlay", "release-verify", "upgrade-test"];
    for (const name of ["publish-images", "publish-sdk"]) {
      expect(needNames(name).sort(), name).toEqual(gates);
    }
  });

  it("creates the GitHub Release only after publishing, when there was publishing", () => {
    const needs = job("github-release").needs ?? [];
    expect(needs).toContain("mirror-to-github");
    // Pre-release tags publish neither, so these two are optional.
    for (const name of ["publish-images", "publish-sdk"]) {
      expect(needs, name).toContainEqual({ job: name, optional: true });
    }
    expect(outcome("github-release", tag("v0.3.0-rc.1")).when).toBe("on_success");
  });

  it("publishes nothing from an unprotected tag", () => {
    const unprotected = (name: string): Pipeline => ({
      ...tag(name),
      variables: { CI_COMMIT_REF_PROTECTED: "false" }
    });
    for (const name of ["publish-images", "publish-sdk", "deploy-demo"]) {
      expect(outcome(name, unprotected("v0.2.7")).when, name).toBe("never");
    }
    for (const name of ["publish-python", "publish-python-testpypi"]) {
      for (const version of ["v0.2.7", "v0.2.7a1"]) {
        expect(outcome(name, unprotected(`packages/sdk-python/${version}`)).when, name).toBe(
          "never"
        );
      }
    }
  });

  it("keeps deploy-demo manual, waiting only for the published images", () => {
    expect(outcome("deploy-demo", tag("v0.2.7")).when).toBe("manual");
    expect(job("deploy-demo").needs).toEqual(["publish-images"]);
  });

  it("publishes nothing on a pre-release or another tag", () => {
    for (const name of ["publish-images", "publish-sdk", "deploy-demo", "live-demo"]) {
      for (const other of ["v0.3.0-rc.1", "phase-5", "usable-v0"]) {
        expect(outcome(name, tag(other)).when, `${name} on ${other}`).toBe("never");
      }
    }
  });
});

describe("live-demo", () => {
  it("is the only job in the pipeline of the schedule that sets LIVE_DEMO_CHECK=1", () => {
    const pipeline = schedule({ LIVE_DEMO_CHECK: "1" });
    expect(Object.keys(jobs).filter((name) => outcome(name, pipeline).when !== "never")).toEqual([
      "live-demo"
    ]);
    expect(outcome("live-demo", pipeline)).toEqual({ when: "on_success", allowFailure: false });
  });

  it("stays out of other schedules and of main", () => {
    expect(outcome("live-demo", schedule()).when).toBe("never");
    expect(outcome("live-demo", main(["README.md"])).when).toBe("never");
  });

  it("runs after deploy-demo on a release tag", () => {
    expect(outcome("live-demo", tag("v0.2.7"))).toEqual({
      when: "on_success",
      allowFailure: false
    });
    expect(job("live-demo").needs).toEqual([{ job: "deploy-demo", optional: true }]);
  });

  it("can be played by hand on a merge request without blocking it", () => {
    expect(outcome("live-demo", mergeRequest(["README.md"]))).toEqual({
      when: "manual",
      allowFailure: true
    });
  });

  it("checks the newest release unless told otherwise, and alerts from after_script", () => {
    const live = job("live-demo");
    expect(live.variables?.["GIT_DEPTH"]).toBe(0);
    const script = (live.script ?? []).join("\n");
    expect(script).toContain("git fetch --tags --force --quiet origin");
    expect(script).toContain(
      `EXPECTED_VERSION="\${EXPECTED_VERSION:-$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*')}"`
    );
    expect(script).toContain("pnpm test:live");
    expect((live.after_script ?? []).join("\n")).toContain("node scripts/live-demo-alert.mjs");
  });

  it("stops its script before the job timeout so after_script still runs and alerts", () => {
    const live = job("live-demo");
    const minutes = (value: unknown): number => {
      const match = /^(\d+)m$/.exec(String(value));
      return match ? Number(match[1]) : Number.NaN;
    };
    const script = minutes(live.variables?.["RUNNER_SCRIPT_TIMEOUT"]);
    const after = minutes(live.variables?.["RUNNER_AFTER_SCRIPT_TIMEOUT"]);
    expect(script).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    expect(script + after).toBeLessThan(minutes((live as { timeout?: unknown }).timeout));
  });

  it("shares the demo resource group with deploy-demo", () => {
    expect((job("live-demo") as { resource_group?: string }).resource_group).toBe("demo");
  });
});
