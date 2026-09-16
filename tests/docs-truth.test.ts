import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverEnvSchema, statementTimeoutSchema } from "../packages/config/src/schema.js";
import { JOURNEY_STATUSES } from "../packages/database/src/repositories/journey-list.js";
import { DEFAULT_SECRET_PATHS } from "../packages/payload-security/src/default-secrets.js";
import { DEFAULT_LIMITS } from "../packages/payload-security/src/limits.js";
import { loadConformanceCases } from "../packages/protocol/src/conformance.js";
import { resolveConfig } from "../packages/sdk-node/src/config.js";
import {
  INGESTION_REFUSALS,
  MAX_BATCH_EVENTS,
  PROTOCOL_ERROR_CODES,
  TRANSPORT_REFUSALS
} from "../packages/protocol/src/index.js";
import { parseRecentJourneysQuery } from "../apps/api/src/routes/recent-query.js";

const root = fileURLToPath(new URL("../", import.meta.url));

const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

/** Directories with nothing authored in them. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".pnpm-store",
  "coverage",
  "playwright-report",
  "test-results",
  // The frozen planning records quote claims as they were, which is the point
  // of keeping them.
  "superpowers"
]);

/**
 * Every markdown file in the repository, so a claim cannot reappear in one that
 * nobody thought to list.
 *
 * Walked rather than asked of `git ls-files`. The CI image is `node:24-alpine`
 * and has no git — GitLab clones with a separate helper container — so the first
 * version of this passed on a clean clone and failed in the pipeline with
 * `spawnSync git ENOENT`. A unit test should not need a tool outside Node.
 */
function markdownFiles(directory = "", found: string[] = []): string[] {
  return filesEndingWith(".md", directory, found);
}

function filesEndingWith(suffix: string, directory = "", found: string[] = []): string[] {
  for (const entry of readdirSync(`${root}${directory}`, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitlab") continue;
    if (SKIP.has(entry.name)) continue;

    const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
    if (entry.isDirectory()) filesEndingWith(suffix, relative, found);
    else if (entry.name.endsWith(suffix)) found.push(relative);
  }
  return found;
}

/**
 * Claims the documentation makes that the repository can check for itself.
 *
 * The README's status text has now been wrong in both directions inside one
 * week — it overstated readiness at one audit and understated it at the next,
 * and it counted 33 ADRs when there were 37. Rewriting it a third time without
 * changing why it drifts would just schedule a fourth.
 */
describe("the documentation's checkable claims", () => {
  it("counts the ADRs correctly", () => {
    const actual = (read("docs/DECISIONS.md").match(/^## ADR-/gm) ?? []).length;
    const claimed = /\[the decision log\]\(docs\/DECISIONS\.md\) — (\d+) ADRs/.exec(
      read("README.md")
    );

    expect(claimed, "README no longer states an ADR count in the expected shape").not.toBeNull();
    expect(Number(claimed?.[1])).toBe(actual);
  });

  it("numbers the ADRs without gaps or repeats", () => {
    // A duplicated number is how two branches silently claim one decision.
    const numbers = [...read("docs/DECISIONS.md").matchAll(/^## ADR-(\d+)/gm)].map((m) =>
      Number(m[1])
    );
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  it("does not claim payloads are encrypted at rest, in any document", () => {
    // They are `jsonb`. The claim was in README.md and docs/OPERATIONS.md, and
    // the OPERATIONS one told operators a dump taken without ENCRYPTION_KEY
    // held nothing readable — so following the documented backup procedure
    // exported every captured payload in the clear.
    //
    // Every markdown file rather than three named ones: the first version of
    // this test listed the files the claim happened to be in, which would have
    // missed it reappearing anywhere else.
    // Two documents quote the claim in order to record that it was wrong, which
    // is the opposite of asserting it. They are named rather than pattern-matched
    // so that the claim reappearing anywhere *else* is still caught — the check
    // is "every file except these two", not "these files".
    const records = new Set(["docs/DECISIONS.md", "docs/WHAT_RUNNING_IT_FOUND.md"]);

    const files = markdownFiles().filter((f) => !records.has(f));
    // Without this the whole check passes on a walk that found nothing, which
    // is how a directory rename turns a guard into a decoration.
    expect(files.length, "the markdown walk found no files").toBeGreaterThan(10);
    for (const file of files) {
      expect(read(file), `${file} claims payloads are encrypted at rest`).not.toMatch(
        /payload[s]?[^.\n]*\bencrypted at rest\b/i
      );
    }
  });

  it("does not describe field-level encryption as future work", () => {
    // Entity identifiers, alias display values, and replay destination headers
    // are encrypted at rest today, with a key derived from ENCRYPTION_KEY
    // (ADR-040). SECURITY.md and DATABASE_SCHEMA.md both described this as
    // something V0 "may" do later; that stopped being true once ADR-040 landed.
    for (const file of ["docs/SECURITY.md", "docs/DATABASE_SCHEMA.md"]) {
      const content = read(file);
      expect(content, `${file} still calls field-level encryption future work`).not.toMatch(
        /Future field-level encryption/i
      );
      expect(
        content,
        `${file} still describes payload storage as possibly relying on encryption`
      ).not.toMatch(/may initially rely on encrypted database storage/i);
    }
  });

  it("does not present the first-contact audit's defects as still open", () => {
    // The 2026-08-09 audit found eight defects (M1 to M8) and seven smaller
    // ones. Every one was fixed the same day, and the fixes were then
    // dogfooded against a real ORM (ADR-034 to ADR-036). The README's status
    // section kept saying "fixes are underway" for five weeks afterwards,
    // which told an evaluator the diff still lied about Dates — the exact
    // claim WHAT_RUNNING_IT_FOUND.md records as fixed.
    const readme = read("README.md");
    expect(readme).not.toMatch(/fixes are underway/i);
    expect(readme).not.toMatch(/treat this as a design and architecture reference/i);
  });

  it("does not tell users to run pnpm db:seed", () => {
    // The seed is a development fixture. Neither the demo stack nor the
    // published stack runs it, and ADR-037 made `project:create` the way a
    // project comes to exist. The login page and the empty projects page both
    // still pointed at it, so a first-time user who followed the interface's
    // own instruction would be told to run a script the README never mentions.
    for (const file of filesEndingWith(".tsx", "apps/web/app")) {
      expect(read(file), `${file} tells the user to run pnpm db:seed`).not.toContain("db:seed");
    }
  });

  it("never tells anyone to run a repository script that pnpm has a built-in for", () => {
    // pnpm 11 has its own `doctor`, and `pnpm doctor` runs it rather than the
    // root script: it checks the pnpm installation, prints its own report, and
    // exits 0 on a database it never looked at. `pnpm run doctor` always means
    // the script. Every markdown file, for the reason the checks above give.
    const files = markdownFiles();
    expect(files.length, "the markdown walk found no files").toBeGreaterThan(10);
    for (const file of files) {
      expect(read(file), `${file} says \`pnpm doctor\`; write \`pnpm run doctor\``).not.toMatch(
        /\bpnpm doctor\b/
      );
    }
  });

  it("runs package scripts from the root with `run`, so a pnpm built-in cannot shadow one", () => {
    // `pnpm --filter <package> doctor` ran pnpm's built-in doctor across the
    // workspace and failed with "Unknown option: 'recursive'". Every name, not
    // only doctor: pnpm adds built-ins, and the next one would shadow silently.
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;
    for (const [name, command] of Object.entries(scripts)) {
      const filtered = /^pnpm --filter \S+ (\S+)/.exec(command);
      if (filtered === null) continue;
      expect(
        ["run", "exec"],
        `root script ${name} runs \`${command}\`; filter into the package with \`run\``
      ).toContain(filtered[1]);
    }
  });

  it("runs the published images through COMPOSE_FILE, never a hand-typed -f list", () => {
    // The install told readers to add `-f compose.bundled.yaml`, then showed
    // every later command with `-f compose.published.yaml` alone. Run as
    // written, those failed and Compose suggested `--remove-orphans`, which
    // removes the PostgreSQL container. One export of COMPOSE_FILE keeps every
    // command on the files the stack was started with, whichever they were.
    const files = [
      ...markdownFiles(),
      ...filesEndingWith(".yaml", "infrastructure"),
      ...filesEndingWith(".ts", "packages"),
      ...filesEndingWith(".ts", "apps")
    ];
    for (const file of files) {
      expect(read(file), `${file} names compose.published.yaml with -f`).not.toMatch(
        /-f\s+compose\.published\.yaml/
      );
    }
  });

  it("keeps the pre-implementation documents marked as such", () => {
    // They predate every ADR and describe an install premise ADR-037 inverted.
    // They are kept for provenance, which only works if a reader is told.
    for (const file of [
      "docs/PRODUCT_SPEC.md",
      "docs/ARCHITECTURE.md",
      "docs/IMPLEMENTATION_PLAN.md",
      "docs/PRODUCT_PRINCIPLES.md"
    ]) {
      expect(read(file), `${file} lost its provenance note`).toContain(
        "Written before implementation"
      );
    }
  });

  describe("GET /v1/journeys in API_SPEC.md", () => {
    const section = (): string => {
      const match = /## 6\. List recent journeys\n([\s\S]*?)\n## 7\./.exec(
        read("docs/API_SPEC.md")
      );
      expect(match, "API_SPEC.md has no section 6 for recent journeys").not.toBeNull();
      return match?.[1] ?? "";
    };
    /** First-column names of the parameter table. */
    const documented = (): string[] =>
      [...section().matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1] ?? "");

    it("documents exactly the query parameters the route reads", () => {
      expect(documented()).toEqual([
        "since",
        "status",
        "environment",
        "service",
        "limit",
        "cursor"
      ]);
    });

    it.each(["since", "status", "environment", "service"])(
      "documents %s, which the parser validates",
      (name) => {
        // A repeated parameter is refused by name only if the parser reads it.
        const query: Record<string, unknown> = {
          since: "2026-01-01T00:00:00Z",
          [name]: ["a", "b"]
        };
        expect(parseRecentJourneysQuery(query, new Date("2026-09-15T00:00:00Z"))).toEqual({
          ok: false,
          message: `${name} must be given once.`
        });
      }
    );

    it("documents limit and cursor, which the route reads as other lists do", () => {
      const route = /app\.get\("\/v1\/journeys", [\s\S]*?\n {2}\}\);/.exec(
        read("apps/api/src/routes/queries.ts")
      );
      expect(route?.[0]).toContain("parseLimit(request.query)");
      expect(route?.[0]).toContain("cursorParam(request.query)");
    });

    it("lists the statuses the database allows", () => {
      const row = /^\| `status` \|(.*)$/m.exec(section())?.[1] ?? "";
      expect([...row.matchAll(/`([a-z]+)`/g)].map((m) => m[1])).toEqual([...JOURNEY_STATUSES]);
    });
  });
});

/**
 * The ingestion contract is the document another implementation is written
 * against, so every number and every code in it is checked against the code
 * that produces them.
 *
 * ADR-040 established the pattern; this is the case that makes it matter. A
 * limit stated wrongly here is a client that batches straight into a refusal,
 * and a refusal code stated wrongly is a client that retries a permanent
 * failure forever.
 */
describe("docs/INGESTION_CONTRACT.md against the code", () => {
  const contract = (): string => read("docs/INGESTION_CONTRACT.md");

  /** The rows of the markdown table under a heading, as arrays of cell text. */
  const tableUnder = (heading: string): string[][] => {
    const section = new RegExp(`\n## ${heading}\n([\\s\\S]*?)\n## `).exec(
      `${contract()}\n## `
    )?.[1];
    expect(section, `no section "${heading}"`).toBeDefined();
    return [...(section ?? "").matchAll(/^\|(.+)\|\s*$/gm)]
      .map((match) => (match[1] ?? "").split("|").map((cell) => cell.trim()))
      .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)));
  };

  it("states the limits the constants actually enforce", () => {
    const rows = tableUnder("3\\. Limits").slice(1);
    expect(rows.length).toBeGreaterThan(5);
    const defaults = new Map(rows.map((cells) => [cells[0] ?? "", cells[2] ?? ""]));

    expect(defaults.get("Serialized size of one envelope")).toBe(
      `${String(DEFAULT_LIMITS.maxBytes)} bytes`
    );
    expect(defaults.get("Events in one batch")).toBe(String(MAX_BATCH_EVENTS));
    expect(defaults.get("Nesting depth")).toBe(String(DEFAULT_LIMITS.maxDepth));
    expect(defaults.get("Keys or elements in one object or array")).toBe(
      String(DEFAULT_LIMITS.maxKeys)
    );
    expect(defaults.get("Length of one string")).toBe(
      `${String(DEFAULT_LIMITS.maxStringLength)} UTF-16 code units`
    );

    // Read out of the configuration schema's own defaults, not from a number
    // typed a second time here.
    const env = serverEnvSchema.parse({
      DATABASE_URL: "postgres://u:p@localhost:5432/d",
      APP_URL: "http://localhost:3000",
      API_URL: "http://localhost:8080",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      ADMIN_TOKEN: "admin-token-for-tests-0000000000",
      REPLAY_ALLOWED_HOSTS: "localhost"
    });
    expect(defaults.get("Serialized size of one envelope")).toBe(
      `${String(env.MAX_EVENT_PAYLOAD_BYTES)} bytes`
    );
    expect(defaults.get("Statement time")).toBe(
      `${String(statementTimeoutSchema.parse({}).DATABASE_STATEMENT_TIMEOUT_MS)} ms`
    );
  });

  it("lists exactly the refusals the code can send, with their statuses", () => {
    const rows = tableUnder("4\\. Per-event refusals, and which to retry").slice(1);
    const documented = rows.map((cells) => ({
      code: (cells[0] ?? "").replaceAll("`", ""),
      status: Number(cells[1]),
      transient: cells[2] === "yes"
    }));
    expect(documented).toEqual(
      INGESTION_REFUSALS.map((refusal) => ({
        code: refusal.code,
        status: refusal.status,
        transient: refusal.transient
      }))
    );
  });

  it("lists exactly the transport refusals, with their statuses", () => {
    const rows = tableUnder("2\\. Refusals that happen before the route runs").slice(1);
    const documented = rows.map((cells) => ({
      status: Number(cells[0]),
      code: (cells[1] ?? "").replaceAll("`", "")
    }));
    expect(documented).toEqual(
      TRANSPORT_REFUSALS.map((refusal) => ({ status: refusal.status, code: refusal.code }))
    );
  });

  it("marks every transient refusal, and only those, as a 5xx", () => {
    // The rule a client implements is "below 500 is permanent". A transient
    // refusal below 500 would make that rule wrong, silently, for one code.
    for (const refusal of [...INGESTION_REFUSALS, ...TRANSPORT_REFUSALS]) {
      expect(refusal.transient, refusal.code).toBe(refusal.status >= 500);
    }
  });

  it("does not bring back a code ADR-049 removed", () => {
    const registry = [...INGESTION_REFUSALS, ...TRANSPORT_REFUSALS].map((one) => one.code);
    const published = Object.values(PROTOCOL_ERROR_CODES) as string[];
    for (const gone of ["missing_required_field", "invalid_timestamp", "invalid_operation"]) {
      expect(registry, `${gone} is back in the refusal registry`).not.toContain(gone);
      expect(published, `${gone} is back in PROTOCOL_ERROR_CODES`).not.toContain(gone);
      // The contract names them once, in the sentence saying they were
      // removed and what another implementation sends instead, which is the
      // point. What matters is that they are not in its tables, and the two
      // assertions above compare those tables with the registry exactly.
      expect(contract(), `${gone} is not explained in the contract`).toContain(`\`${gone}\``);
    }
  });

  it("publishes every code the registry names, and no other, in the contract's tables", () => {
    // The control: the two assertions above compare the tables with the
    // registry, and would both pass against a document with no tables at all.
    for (const refusal of [...INGESTION_REFUSALS, ...TRANSPORT_REFUSALS]) {
      expect(contract(), `${refusal.code} is not in the contract`).toContain(`\`${refusal.code}\``);
    }
  });

  it("leaves API_SPEC.md pointing here rather than documenting ingestion twice", () => {
    // Two documents describing one route is how a contract comes to have two
    // answers. API_SPEC keeps a summary and a link.
    const spec = read("docs/API_SPEC.md");
    expect(spec).toContain("INGESTION_CONTRACT.md");
    for (const gone of ["unstorable_payload", "max_depth_exceeded", "event_id_conflict"]) {
      expect(spec, `API_SPEC.md still documents ingestion in full: ${gone}`).not.toContain(gone);
    }
  });
});

/**
 * `docs/SDK_SPEC.md` is what a second implementation is written against, so its
 * requirements have to be traceable and its fixture references have to resolve.
 *
 * Nothing here checks the prose. What it checks is the three things that make a
 * requirement usable by somebody who is not in this repository: that it says
 * where it came from, that a fixture it names exists, and that a requirement no
 * fixture can check is actually listed among the ones an implementer has to
 * test themselves.
 */
describe("docs/SDK_SPEC.md", () => {
  const spec = (): string => read("docs/SDK_SPEC.md");

  interface Requirement {
    id: string;
    source: string;
    checkedBy: string;
  }

  /** Every row of every requirement table: `| SDK-n | source | checked by |`. */
  const requirements = (): Requirement[] =>
    [...spec().matchAll(/^\| (SDK-\d+) \| (.+?) \| (.+?) \|\s*$/gm)].map((match) => ({
      id: match[1] ?? "",
      source: match[2] ?? "",
      checkedBy: match[3] ?? ""
    }));

  it("numbers its requirements without gaps or repeats", () => {
    // A duplicated identifier is how two rules come to be called one thing.
    const ids = requirements().map((one) => Number(one.id.replace("SDK-", "")));
    expect(ids.length).toBeGreaterThan(40);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_unused, index) => index + 1));
  });

  it("states every MUST and SHOULD as a numbered requirement", () => {
    // A rule in the prose with no identifier cannot be cited, checked, or
    // argued with.
    //
    // This once looked only at bullets that already began with an identifier,
    // and asked whether each of those carried a keyword. An un-numbered MUST
    // was invisible to it, which is the whole thing it was meant to catch. The
    // check runs the other way now: every bullet in the document is examined,
    // and one carrying a keyword has to be numbered.
    const bullets = [...spec().matchAll(/^- (.+(?:\n {2}.+)*)/gm)].map((match) => match[1] ?? "");
    expect(bullets.length, "no bullets found; the walk is broken").toBeGreaterThan(40);

    const unnumbered = bullets
      .filter((text) => /\b(MUST|SHOULD|MAY)\b/.test(text))
      .filter((text) => !/^\*\*SDK-\d+\.\*\*/.test(text))
      .map((text) => text.split("\n")[0]);
    expect(unnumbered, "a requirement in the prose carries no identifier").toEqual([]);

    // And the other direction: every identifier in the prose is one the tables
    // list, so a bullet cannot be numbered without appearing in a source table.
    const numbered = bullets
      .map((text) => /^\*\*(SDK-\d+)\.\*\*/.exec(text)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(numbered.sort()).toEqual(
      requirements()
        .map((one) => one.id)
        .sort()
    );
  });

  it("gives every requirement a source", () => {
    for (const one of requirements()) {
      expect(one.source.length, `${one.id} has no source`).toBeGreaterThan(3);
    }
  });

  it("names only conformance cases that exist", () => {
    const cases = new Set(
      [
        ...loadConformanceCases(`${root}packages/protocol/conformance/wire`),
        ...loadConformanceCases(`${root}packages/protocol/conformance/sdk`)
      ].map((one) => one.id)
    );
    for (const one of requirements()) {
      if (one.checkedBy === "section 14") continue;
      // A requirement may name several cases, separated by commas.
      for (const id of one.checkedBy.split(/,\s*/)) {
        expect(cases, `${one.id} names a case that does not exist: ${id}`).toContain(id);
      }
    }
  });

  it("lists every requirement no fixture checks in section 14", () => {
    // Otherwise "checked by section 14" is a promise nobody kept, and an
    // implementer following this document would leave it untested.
    const section = /\n## 14\.[\s\S]*$/.exec(spec())?.[0] ?? "";
    for (const one of requirements()) {
      if (one.checkedBy !== "section 14") continue;
      expect(
        section,
        `${one.id} says section 14 checks it, and section 14 does not name it`
      ).toContain(one.id);
    }
  });

  it("copies the built-in secret names exactly", () => {
    // An implementer in another language cannot import the file, so the list
    // lives in the document; this is what stops the two from drifting.
    const block = /### The eleven built-in secret names[\s\S]*?```text\n([\s\S]*?)```/.exec(spec());
    expect(block, "the document no longer lists the built-in secret names").not.toBeNull();
    const listed = (block?.[1] ?? "")
      .trim()
      .split("\n")
      .map((line) => line.trim());
    expect(listed).toEqual(DEFAULT_SECRET_PATHS.map((path) => path.replace("**.", "")));
  });

  it("states the defaults the SDK actually resolves", () => {
    const defaults = new Map(
      [
        ...spec().matchAll(
          /^\| (batch size|flush interval|request timeout|queue|event budget) \| (.+?) \|\s*$/gm
        )
      ].map((match) => [match[1] ?? "", match[2] ?? ""])
    );
    const resolved = resolveConfig({
      endpoint: "http://localhost:8080",
      apiKey: "fr_test",
      serviceName: "svc",
      environment: "development"
    });
    expect(defaults.get("batch size")).toBe(String(resolved.batchSize));
    expect(defaults.get("flush interval")).toBe(
      `${resolved.flushIntervalMs.toLocaleString("en-US")} ms`
    );
    expect(defaults.get("request timeout")).toBe(
      `${resolved.requestTimeoutMs.toLocaleString("en-US")} ms`
    );
    expect(defaults.get("queue")).toBe(
      `${resolved.maxBufferedEvents.toLocaleString("en-US")} events`
    );
    expect(defaults.get("event budget")).toBe(
      `${resolved.maxPayloadBytes.toLocaleString("en-US")} bytes`
    );
  });

  it("keeps NODE_SDK_SPEC.md as the appendix, and reconciled with what is built", () => {
    const appendix = read("docs/NODE_SDK_SPEC.md");
    expect(appendix, "the Node specification no longer points at the neutral one").toContain(
      "SDK_SPEC.md"
    );
    // The three places it had drifted from the code.
    expect(appendix, "the appendix still offers drop-newest, which was never built").not.toContain(
      "drop newest"
    );
    expect(appendix).not.toMatch(/batchSize: 20/);
  });

  it("specifies no name the rename will change", () => {
    // Section 10 states the propagation rules that survive a rename and no
    // names at all; a header or variable name here would have to be rewritten
    // in the same month it was published (ADR-049).
    for (const name of ["x-flight-", "FLIGHT_RECORDER_", "flightJourney", "jrn_"]) {
      expect(spec(), `SDK_SPEC.md names ${name}, which the rename changes`).not.toContain(name);
    }
  });
});
