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
  TRANSPORT_REFUSALS,
  storedEventSchema
} from "../packages/protocol/src/index.js";
import {
  JOURNEY_LIST_PARAMETERS,
  parseJourneyListQuery
} from "../apps/api/src/routes/journey-list-query.js";
import { SEARCH_PARAMETERS } from "../apps/api/src/routes/search-query.js";
import {
  DEFAULT_PAGE_LIMIT,
  FUTURE_SINCE_MESSAGE,
  MAX_PAGE_LIMIT,
  SINCE_CLOCK_TOLERANCE_MS
} from "../apps/api/src/routes/query-params.js";
import { filesEndingWith, findSection, markdownFiles, read, root } from "./docs-helpers.js";

/** The text of a `## ` section of a markdown document, up to the next one. */
const section = (markdown: string, heading: string): string => {
  const found = findSection(markdown, heading);
  expect(found, `no section "${heading}"`).toBeDefined();
  return found ?? "";
};

/**
 * First-column names of the first markdown table in `text`.
 *
 * The first table, not every row that looks like one: a section that
 * documents its parameters in a table and then explains a vocabulary in a
 * second one would otherwise report both as parameters, which is exactly what
 * API_SPEC section 6 does now that it explains what a journey's status means.
 */
const firstTableKeys = (text: string): string[] => {
  const table = /^(\|.*\n)+/m.exec(text)?.[0] ?? "";
  return [...table.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((match) => match[1] ?? "");
};

/** The fields `presentJourneySummary` returns, in the order it declares them. */
const summaryFields = (): string[] =>
  [
    ...(
      /export interface PresentedJourneySummary \{([\s\S]*?)\n\}/.exec(
        read("apps/api/src/routes/present.ts")
      )?.[1] ?? ""
    ).matchAll(/^ {2}(\w+):/gm)
  ].map((match) => match[1] ?? "");

/** The top-level keys of the first item in a section's first JSON example. */
const exampleItemKeys = (text: string): string[] => {
  const example = /```json\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
  return [...example.matchAll(/^\s{8}"(\w+)":/gm)].map((match) => match[1] ?? "");
};

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
    const claimed = /\[the decision log\]\(docs\/DECISIONS\.md\): (\d+) ADRs/.exec(
      read("README.md")
    );

    expect(claimed, "README no longer states an ADR count in the expected shape").not.toBeNull();
    expect(Number(claimed?.[1])).toBe(actual);
  });

  it("states the ADR count correctly wherever the README states one", () => {
    // "How this is built" repeats the count in its own sentence shape, and a
    // second copy is where a stale number hides.
    const actual = (read("docs/DECISIONS.md").match(/^## ADR-/gm) ?? []).length;
    const readme = read("README.md");
    const claims = [...readme.matchAll(/(\d+) ADRs/g)].map((m) => Number(m[1]));

    expect(section(readme, "How this is built")).toMatch(/holds (\d+) ADRs/);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claimed of claims) expect(claimed).toBe(actual);
  });

  it("keeps Alternatives straight after the tracing comparison", () => {
    const headings = [...read("README.md").matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const tracing = headings.indexOf("Why this is not tracing");
    expect(tracing, "README has no 'Why this is not tracing' section").toBeGreaterThanOrEqual(0);
    expect(headings[tracing + 1]).toBe("Alternatives");
  });

  it("dates the no-open-source-alternative claim, in the README and on its page", () => {
    // The claim is only defensible as "as of" a date; an undated one reads as
    // permanent and goes stale silently.
    const month =
      "(January|February|March|April|May|June|July|August|September|October|November|December)";
    const alternatives = section(read("README.md"), "Alternatives");
    expect(alternatives).toMatch(new RegExp(`As of ${month} \\d{4}, I have not found`));
    expect(alternatives).toContain("docs/ALTERNATIVES.md");

    const page = read("docs/ALTERNATIVES.md");
    expect(page).toMatch(
      new RegExp(`^\\*\\*Last checked: \\d{1,2} ${month} \\d{4}\\.\\*\\*$`, "m")
    );
    expect(page).toMatch(new RegExp(`As of ${month} \\d{4}, I have not found`));
    const claimed = (text: string): string | undefined =>
      new RegExp(`As of (${month} \\d{4}), I have not found`).exec(text)?.[1];
    expect(claimed(alternatives), "the README and the page date the claim differently").toBe(
      claimed(page)
    );

    // Every source list carries the date each source was checked.
    const lines = page.split("\n");
    const sourceLists = lines.flatMap((line, i) => {
      if (!/^- \*\*Sources?:\*\*/.test(line)) return [];
      const rest = lines.slice(i + 1);
      const end = rest.findIndex((next) => !next.startsWith("  "));
      return [[line, ...rest.slice(0, end === -1 ? undefined : end)].join("\n")];
    });
    expect(sourceLists.length).toBeGreaterThan(10);
    for (const list of sourceLists) {
      expect(list, `a source list without a date:\n${list}`).toMatch(/checked\s+\d{4}-\d{2}-\d{2}/);
    }
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
    //
    // REPLAY_SPEC is here because its section 6 specified a request shape the
    // server never accepted: `payload` and `headers` the caller supplies. A
    // reader took it for a contract, which is what an unmarked plan invites.
    for (const file of [
      "docs/PRODUCT_SPEC.md",
      "docs/ARCHITECTURE.md",
      "docs/IMPLEMENTATION_PLAN.md",
      "docs/PRODUCT_PRINCIPLES.md",
      "docs/REPLAY_SPEC.md"
    ]) {
      expect(read(file), `${file} lost its provenance note`).toContain(
        "Written before implementation"
      );
    }
  });

  it("specifies the replay request with the fields the route actually reads", () => {
    // REPLAY_SPEC section 6 specified `payload` and `headers` the caller
    // supplies. The route has never read either: it sends the stored input of
    // the event, with the destination's headers. A reader who built to the
    // document would have written fields the server silently drops, because
    // parseReplayRequest ignores unknown keys.
    const declared = [
      ...read("apps/api/src/routes/replays.ts").matchAll(
        /interface ReplayRequest \{([\s\S]*?)\n\}/g
      )
    ].flatMap((match) => [...(match[1] ?? "").matchAll(/^\s*(\w+)[?:]/gm)].map((f) => f[1]));
    expect(declared, "replays.ts no longer declares a ReplayRequest interface").toEqual([
      "eventId",
      "destinationId",
      "method",
      "path"
    ]);

    const documented = [
      ...section(read("docs/REPLAY_SPEC.md"), "6. Replay request").matchAll(/^\s*(\w+)\??: /gm)
    ].map((match) => match[1]);
    expect(documented, "REPLAY_SPEC section 6 does not list the route's fields").toEqual(declared);
  });

  describe("GET /v1/search in API_SPEC.md", () => {
    const section = (): string => {
      const match = /## 5\. Search\n([\s\S]*?)\n## 6\./.exec(read("docs/API_SPEC.md"));
      expect(match, "API_SPEC.md has no section 5 for search").not.toBeNull();
      return match?.[1] ?? "";
    };

    it("documents exactly the query parameters the route reads", () => {
      // The parser refuses every other key, so its list is the route's. F-028
      // found the endpoint with no window at all; the table is what tells a
      // caller there is one to give.
      expect(firstTableKeys(section())).toEqual([...SEARCH_PARAMETERS]);
    });

    it("says plainly that a search with no window spans the whole history", () => {
      expect(section()).toContain("spans the project's whole history");
    });

    it("shows every field a search row carries in its example item", () => {
      // F-036: a journey list row carried `environment` and a search row did
      // not. Both are presentJourneySummary's output, so its declared fields
      // are the example's, in both sections.
      const declared = summaryFields();
      expect(declared).toContain("environment");
      expect(exampleItemKeys(section())).toEqual(declared);
    });
  });

  describe("the retried operation in EVENT_PROTOCOL.md", () => {
    it("says what a successful retry does to a journey's status", () => {
      // ADR-061's other consequence. The entry said only "A previous operation
      // was attempted again", which does not tell a client author that the
      // absence of an error on such an event means something to the summary.
      const operations = section(read("docs/EVENT_PROTOCOL.md"), "5. Operation semantics");
      const retried = /### `retried`\n([\s\S]*?)\n### /.exec(operations)?.[1] ?? "";
      expect(retried).toContain("clears an earlier failure");
      expect(retried).toContain("never completes it (ADR-061)");
      const completed = /### `completed`\n([\s\S]*)/.exec(operations)?.[1] ?? "";
      expect(completed).toContain("finish()");
    });
  });

  describe("who may read, in API_SPEC.md section 1", () => {
    const conventions = (): string => section(read("docs/API_SPEC.md"), "1. Conventions");

    it("says an API key may read, which is what the code does", () => {
      // F-013: section 1 listed the admin token alone as "authentication for
      // reads", while section 6 and resolvePrincipal both say an API key reads
      // its own environment. resolvePrincipal returns a principal for either
      // credential and every query route resolves its scope from whichever it
      // got, so the narrower statement was the wrong one.
      expect(read("apps/api/src/principal.ts")).toContain('kind: "apiKey"');
      expect(read("apps/api/src/routes/queries.ts")).toContain("resolvePrincipal");
      expect(conventions()).toContain("Authentication for reads, with an API key");
      expect(conventions()).toContain("Either credential may read");
    });

    it("names the routes that take the admin token alone, and they do", () => {
      for (const route of ["projects", "replays", "deletions"]) {
        const source = read(`apps/api/src/routes/${route}.ts`);
        // A call, not the word: projects.ts explains in a comment why it
        // cannot go through resolvePrincipal.
        expect(source, route).not.toMatch(/\bresolvePrincipal\(/);
      }
      expect(conventions()).toContain("take the admin token alone");
    });
  });

  describe("limit in API_SPEC.md", () => {
    // F-029: limit was read with parseInt, so a repeat or a NUL cut it short
    // and nonsense clamped silently. Every list endpoint now reads it through
    // pageLimit, and each section states the rule pageLimit enforces.
    const rule = `a whole number from 1 to ${String(MAX_PAGE_LIMIT)}, ${String(DEFAULT_PAGE_LIMIT)} when omitted or empty`;

    it.each(["5. Search", "6. List journeys", "8. List journey events"])(
      "section %s states the rule the parser enforces",
      (heading) => {
        // White space folded, so a line break inside the sentence does not matter.
        expect(section(read("docs/API_SPEC.md"), heading).replace(/\s+/g, " ")).toContain(rule);
      }
    );

    it("is read through pageLimit on every route that takes it", () => {
      const routes = read("apps/api/src/routes/queries.ts");
      expect(routes.match(/pageLimit\(queryParams\(request\.query\)\)/g)).toHaveLength(3);
      expect(routes).not.toContain("parseInt");
    });

    it("states the default and the maximum in the request limits", () => {
      const limits = section(read("docs/API_SPEC.md"), "16. Request limits");
      expect(limits.replace(/\s+/g, " ")).toContain(
        `List endpoints return ${String(DEFAULT_PAGE_LIMIT)} items by default and at most ${String(MAX_PAGE_LIMIT)}`
      );
    });
  });

  describe("the clock tolerance on since", () => {
    // F-035: the refusal said "since must not be in the future." while the
    // check tolerates a minute. The message is built from the constant; these
    // hold the documents that quote the rule and the message to it.
    const seconds = String(SINCE_CLOCK_TOLERANCE_MS / 1000);

    it.each(["5. Search", "6. List journeys"])(
      "API_SPEC section %s states the tolerance",
      (heading) => {
        expect(section(read("docs/API_SPEC.md"), heading).replace(/\s+/g, " ")).toContain(
          `more than ${seconds} seconds ahead of the API's clock`
        );
      }
    );

    it("TROUBLESHOOTING quotes the refusal as the API sends it", () => {
      expect(FUTURE_SINCE_MESSAGE).toContain(`${seconds} seconds`);
      const row = read("docs/TROUBLESHOOTING.md")
        .split("\n")
        .find((line) => line.startsWith(`| a \`since\` more than ${seconds} seconds ahead`));
      expect(row, "TROUBLESHOOTING has no row for a future since").toBeDefined();
      expect(row).toContain(`\`${FUTURE_SINCE_MESSAGE}\``);
    });
  });

  describe("GET /v1/events/:eventId in API_SPEC.md", () => {
    it("names the aliases an event stated, and what null means", () => {
      // F-042: an identified event read on its own did not say what it
      // identified. The stored-event schema is what section 9 points to.
      expect(Object.keys(storedEventSchema.shape)).toContain("aliases");
      const text = section(read("docs/API_SPEC.md"), "9. Get event details").replace(/\s+/g, " ");
      expect(text).toContain("`aliases`");
      expect(text).toContain("`[]` for an event that stated none");
      expect(text).toContain("`null` for an event stored before the server recorded");
    });
  });

  describe("GET /v1/journeys/:journeyId/events in API_SPEC.md", () => {
    it("shows every field the route sends in its example item", () => {
      // F-025: the example omitted `receivedAt`, which the endpoint always
      // sends and which the section's own ordering rule names, so a caller
      // building a schema from the example alone landed one field short.
      const declared = [
        ...(
          /export interface EventListItem \{([\s\S]*?)\n\}/.exec(
            read("packages/database/src/repositories/event-reads.ts")
          )?.[1] ?? ""
        ).matchAll(/^ {2}(\w+):/gm)
      ].map((match) => match[1]);
      expect(declared).toContain("receivedAt");

      const example = /## 8\. List journey events[\s\S]*?```json\n([\s\S]*?)```/.exec(
        read("docs/API_SPEC.md")
      )?.[1];
      expect(example, "API_SPEC.md section 8 has no example").toBeDefined();
      const shown = [...(example ?? "").matchAll(/^\s{8}"(\w+)":/gm)].map((match) => match[1]);
      expect(shown).toEqual(declared);
    });
  });

  describe("GET /v1/journeys in API_SPEC.md", () => {
    const section = (): string => {
      const match = /## 6\. List journeys\n([\s\S]*?)\n## 7\./.exec(read("docs/API_SPEC.md"));
      expect(match, "API_SPEC.md has no section 6 for the journey list").not.toBeNull();
      return match?.[1] ?? "";
    };
    /** First-column names of the parameter table, which is the section's first. */
    const documented = (): string[] => firstTableKeys(section());

    it("documents exactly the query parameters the route reads", () => {
      // The parser refuses every other key, so its list is the route's.
      expect(documented()).toEqual([...JOURNEY_LIST_PARAMETERS]);
      expect(documented()).toEqual([
        "since",
        "until",
        "status",
        "environment",
        "service",
        "entityType",
        "q",
        "limit",
        "cursor"
      ]);
    });

    it.each(["since", "until", "status", "environment", "service", "entityType", "q"])(
      "documents %s, which the parser validates",
      (name) => {
        // A repeated parameter is refused by name only if the parser reads it.
        const query: Record<string, unknown> = {
          since: "2026-01-01T00:00:00Z",
          [name]: ["a", "b"]
        };
        expect(parseJourneyListQuery(query, new Date("2026-09-15T00:00:00Z"))).toEqual({
          ok: false,
          message: `${name} must be given once.`
        });
      }
    );

    it("documents limit and cursor, which the route reads as other lists do", () => {
      const route = /app\.get\("\/v1\/journeys", [\s\S]*?\n {2}\}\);/.exec(
        read("apps/api/src/routes/queries.ts")
      );
      expect(route?.[0]).toContain("pageLimit(queryParams(request.query))");
      expect(route?.[0]).toContain("cursorParam(request.query)");
    });

    it("says what each status means, and that a retry clears rather than completes", () => {
      // ADR-061's consequences: the vocabulary has to say what a successful
      // retry does and what `completed` means, or the status filter names three
      // words with no meanings attached.
      const text = section();
      expect(text).toContain("What a journey's status means");
      expect(text).toContain("ADR-061");
      expect(text).toContain("clears a failure and does not complete the journey");
      // `completed` is the one operation that sets it, at or after the watermark.
      expect(text).toMatch(/`completed` operation at or after the newest event's timestamp/);
    });

    it("does not let completedAt be read as tracking the status", () => {
      // The update writes completed_at in one branch and never writes null, so
      // a journey cleared back to `active` keeps the one it had. A reader who
      // took the documentation for "active implies no completedAt" would be
      // wrong on a path ADR-031 makes ordinary.
      const update = read("packages/database/src/repositories/journeys.ts");
      const clause = /completed_at = case([\s\S]*?)\n {6}end,/.exec(update)?.[1] ?? "";
      expect(clause, "the completed_at clause moved").not.toBe("");
      expect(clause).not.toContain("null");

      const text = section();
      expect(text).toContain("`completedAt` does not track the status");
      expect(text).toContain("never cleared");
    });

    it("shows the same fields as a search row in its example item", () => {
      expect(exampleItemKeys(section())).toEqual(summaryFields());
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
    const block = /### The built-in secret names[\s\S]*?```text\n([\s\S]*?)```/.exec(spec());
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
      apiKey: "wsk_test",
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
      `${resolved.maxEventBytes.toLocaleString("en-US")} bytes`
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

  it("specifies no propagation name before the propagation specification", () => {
    // Section 10 states only the propagation rules that do not depend on a
    // name. The header, attribute and variable names were left out so the
    // rename (ADR-057) did not break a published contract (ADR-049), and they
    // stay out until the propagation specification fixes them.
    for (const name of ["x-wayscribe-", "WAYSCRIBE_", "wayscribeJourney", "jrn_"]) {
      expect(
        spec(),
        `SDK_SPEC.md names ${name}, which belongs to the pending propagation specification`
      ).not.toContain(name);
    }
  });
});
