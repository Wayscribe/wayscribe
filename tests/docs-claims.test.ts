import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseJourneyListQuery } from "../apps/api/src/routes/journey-list-query.js";
import { BLOCKED_HEADER_NAMES } from "../apps/api/src/replay/header-policy.js";
import { SAMPLE_BOUNDS } from "../packages/database/src/secret-names.js";
import { deriveSubkeys, keyFingerprint } from "../packages/payload-security/src/keys.js";
import { resolveConfig } from "../packages/sdk-node/src/config.js";
import {
  AUDITED_DOCUMENTS,
  capture,
  codeWords,
  filesEndingWith,
  findSection,
  read,
  root,
  tableRows
} from "./docs-helpers.js";

/**
 * Numbers and names the audited documents state, held to the code that
 * decides them (ADR-040). Each block names the claim it protects; the full
 * list, with what was checked by hand, is docs/claims-audit-2026-09-16.md.
 */

const sectionOf = (document: string, heading: string): string => {
  const found = findSection(read(document), heading);
  if (found === undefined) throw new Error(`${document} has no section "${heading}"`);
  return found;
};

/** The text from a `### ` heading to the next heading of level 2 or 3. */
const subsection = (document: string, heading: string): string => {
  const text = read(document);
  const start = text.indexOf(`\n### ${heading}\n`);
  if (start === -1) throw new Error(`${document} has no subsection "${heading}"`);
  const rest = text.slice(start + 1);
  const end = rest.slice(4).search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end + 4);
};

/** Prose with its line breaks folded, so a phrase can be found across them. */
const prose = (text: string): string => text.replace(/\s+/g, " ");

const recorderSource = (): string => read("packages/sdk-node/src/recorder.ts");

describe("the Node SDK's documented numbers", () => {
  const resolved = resolveConfig({
    endpoint: "http://localhost:8080",
    apiKey: "wsk_test",
    serviceName: "svc",
    environment: "development"
  });

  it("lists the defaults resolveConfig applies, in the SDK README's configuration table", () => {
    const rows = new Map(
      tableRows(sectionOf("packages/sdk-node/README.md", "Configuration")).map((row) => [
        codeWords(row[0] ?? "")[0] ?? "",
        codeWords(row[1] ?? "")[0]
      ])
    );
    expect(rows.get("batchSize")).toBe(String(resolved.batchSize));
    expect(rows.get("flushIntervalMs")).toBe(String(resolved.flushIntervalMs));
    expect(rows.get("requestTimeoutMs")).toBe(String(resolved.requestTimeoutMs));
    expect(rows.get("maxBufferedEvents")).toBe(String(resolved.maxBufferedEvents));
    expect(rows.get("maxEventBytes")).toBe(String(resolved.maxEventBytes));
    expect(rows.get("maxConcurrentSends")).toBe(String(resolved.maxConcurrentSends));
    expect(rows.get("captureMode")).toBe(resolved.captureMode);
    expect(rows.get("propagation")).toBe(resolved.propagation);
    expect(rows.get("logDiagnostics")).toBe(String(resolved.logDiagnostics));
  });

  it("states the transport's bounds as the recorder sets them", () => {
    const source = recorderSource();
    const option = (name: string): number =>
      Number(capture(source, new RegExp(`${name}: ([\\d_]+)[,\\n]`), name).replaceAll("_", ""));
    expect(option("breakerThreshold")).toBe(5);
    expect(option("breakerCooldownMs")).toBe(30_000);
    expect(option("retryBudgetMs")).toBe(30_000);
    expect(option("maxRefusedSends")).toBe(10);
    expect(option("maxAttempts")).toBe(3);
    expect(option("baseBackoffMs")).toBe(100);
    expect(
      Number(
        capture(source, /options\?\.timeoutMs \?\? ([\d_]+)/, "shutdown timeout").replace("_", "")
      )
    ).toBe(2_000);

    const sdk = prose(read("packages/sdk-node/README.md"));
    expect(sdk).toContain("sends pause for 30 seconds after five failed in a row");
    expect(sdk).toContain("for 30 seconds from its first refusal, or through 10 sends");
    expect(sdk).toContain("a random 0 to 100 ms, and after the second a random 0 to 200 ms");
    expect(sdk).toContain("await recorder.shutdown({ timeoutMs: 2_000 }); // the default");
    expect(sdk).toContain("(1,000 by default) the oldest events are dropped");

    const faq = prose(read("docs/FAQ.md"));
    expect(faq).toContain("After five failed sends in a row, sending pauses for 30 seconds");
    expect(faq).toContain("1,000 by default (`maxBufferedEvents`)");
    expect(faq).toContain("(2,000 ms by default)");

    const troubleshooting = prose(read("docs/TROUBLESHOOTING.md"));
    expect(troubleshooting).toContain(
      "five sends failed in a row, and sending paused for 30 seconds"
    );
    expect(troubleshooting).toContain("retried for up to 30 seconds or 10 sends");
    expect(troubleshooting).toContain("`maxBufferedEvents` (1,000 by default)");
  });

  it("states the error and label bounds the recorder applies", () => {
    const source = recorderSource();
    expect(source).toContain("MAX_ERROR_MESSAGE_LENGTH = 4096;");
    expect(source).toContain("MAX_ERROR_STACK_LENGTH = 16_384;");
    expect(source).toContain("MAX_KEY_LENGTH = 128;");
    expect(source).toContain("MAX_ALIAS_VALUE_LENGTH = 512;");
    expect(source).toContain("MAX_ERROR_FIELD_LENGTH = 256;");
    expect(read("packages/protocol/src/limits.ts")).toContain("MAX_JOURNEY_LABEL_LENGTH = 200;");
    expect(read("packages/sdk-node/src/diagnostics.ts")).toContain("MAX_LOGGED_REASON = 512;");
    expect(read("packages/sdk-node/src/journey-id.ts")).toContain(
      "JOURNEY_ID_SECRET_MIN_BYTES = 32;"
    );

    const sdk = prose(read("packages/sdk-node/README.md"));
    expect(sdk).toContain("masked over its first 8192 characters and then cut to 4096");
    expect(sdk).toContain("handled the same way at 16384");
    expect(sdk).toContain("An error's `type` or `code` over 256 characters is cut");
    expect(sdk).toContain("A label over 200 characters");
    expect(sdk).toContain("cut to 512 characters");
    expect(sdk).toContain("`journeyIdSecret` | none | at least 32 bytes");
    expect(prose(read("docs/SECURITY.md"))).toContain(
      "a message to 4096 characters and a stack passed to `record()` to 16384"
    );
  });

  it("prints unasked only the five warnings the README lists", () => {
    // Every console line the SDK can print without logDiagnostics goes through
    // printDiagnostic, and each call names why it printed.
    const notes = [
      ...filesEndingWith(".ts", "packages/sdk-node/src").filter((f) => !f.endsWith(".test.ts"))
    ].flatMap((file) =>
      [...read(file).matchAll(/"printed once per process[^"]*"/g)].map((match) => match[0])
    );
    // A required setting, an optional one, a renamed one, the journey id
    // secret, and a secret-looking name.
    expect(notes).toHaveLength(5);
    const readme = prose(read("packages/sdk-node/README.md"));
    expect(readme).toContain("with five exceptions, each printed once per process");
    expect(prose(read("README.md"))).toContain("apart from five warnings printed once per process");
  });
});

describe("the diagnostic codes the documentation lists", () => {
  /** kind -> codes, read from the union types in diagnostics.ts. */
  const declared = (): Map<string, string[]> => {
    const source = read("packages/sdk-node/src/diagnostics.ts");
    const found = new Map<string, string[]>();
    for (const match of source.matchAll(/kind: "([a-z_]+)";\s*code:([^;]+);/g)) {
      found.set(
        match[1] ?? "",
        [...(match[2] ?? "").matchAll(/"([a-z_]+)"/g)].map((code) => code[1] ?? "")
      );
    }
    expect(
      found.size,
      "no diagnostic kinds found; did diagnostics.ts change shape?"
    ).toBeGreaterThan(10);
    return found;
  };

  it("lists every kind and code, and no other, in TROUBLESHOOTING's table", () => {
    const rows = tableRows(sectionOf("docs/TROUBLESHOOTING.md", "Diagnostics by code"));
    const documented = rows.map(
      (row) => `${codeWords(row[0] ?? "")[0] ?? ""}/${codeWords(row[1] ?? "")[0] ?? ""}`
    );
    const expected = [...declared()].flatMap(([kind, codes]) =>
      codes.map((code) => `${kind}/${code}`)
    );
    expect(documented.sort()).toEqual(expected.sort());
  });

  it("lists every kind with its codes, in order, in the SDK README's table", () => {
    const rows = tableRows(
      subsection("packages/sdk-node/README.md", "Handling diagnostics in code")
    );
    const documented = new Map(
      rows.map((row) => [codeWords(row[0] ?? "")[0] ?? "", codeWords(row[1] ?? "")])
    );
    expect(documented).toEqual(declared());
  });
});

describe("the server's documented numbers", () => {
  it("states the replay bounds send.ts applies", () => {
    const send = read("apps/api/src/replay/send.ts");
    expect(send).toContain("DEFAULT_TIMEOUT_MS = 10_000;");
    expect(send).toContain("DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;");
    const security = prose(read("docs/SECURITY.md"));
    expect(security).toContain("The request times out after 10 seconds, and at most 256 KiB");
    expect(security).toContain(
      "Replay reads at most 256 KiB of a response and waits at most 10 seconds"
    );
    const api = prose(read("docs/API_SPEC.md"));
    expect(api).toContain("with a 10-second timeout, and reads at most 256 KiB");
    expect(api).toContain("A replay waits at most 10 seconds and reads at most 256 KiB");
  });

  it("lists the replay header policy's blocked names exactly", () => {
    const section = sectionOf("docs/SECURITY.md", "9. Replay security");
    const block = capture(section, /```text\n([\s\S]*?)```/, "the blocked header list");
    expect(block.trim().split("\n")).toEqual([...BLOCKED_HEADER_NAMES]);
  });

  it("states the environment types a destination may have", () => {
    expect(read("apps/api/src/routes/replays.ts")).toContain(
      'ENVIRONMENT_TYPES = new Set(["local", "development", "test"])'
    );
    expect(prose(read("docs/SECURITY.md"))).toContain(
      "`environmentType` must be `local`, `development` or `test`"
    );
    expect(prose(read("docs/API_SPEC.md"))).toContain(
      "`environmentType` must be `local`, `development` or `test`"
    );
  });

  it("states the list endpoints' page sizes and the journey list's bounds", () => {
    const queries = read("apps/api/src/routes/queries.ts");
    expect(queries).toContain("const DEFAULT_LIMIT = 25;");
    expect(queries).toContain("const MAX_LIMIT = 100;");
    const api = prose(read("docs/API_SPEC.md"));
    expect(api).toContain("Page size, 25 by default, at most 100.");
    expect(api).toContain("List endpoints return 25 items by default and at most 100.");
    expect(api).toContain("Text of 2 to 200 characters");
    expect(api).toContain("at most 128 characters");
    expect(api).toContain("more than 60 seconds ahead of the API's clock");

    const now = new Date("2026-09-16T12:00:00Z");
    const since = "2026-09-16T00:00:00Z";
    const ok = (query: Record<string, unknown>): boolean =>
      parseJourneyListQuery({ since, ...query }, now).ok;
    expect(ok({ q: "ab" })).toBe(true);
    expect(ok({ q: "a" })).toBe(false);
    expect(ok({ q: "a".repeat(200) })).toBe(true);
    expect(ok({ q: "a".repeat(201) })).toBe(false);
    expect(ok({ entityType: "a".repeat(128) })).toBe(true);
    expect(ok({ entityType: "a".repeat(129) })).toBe(false);
    expect(parseJourneyListQuery({ since: "2026-09-16T12:01:00Z" }, now).ok).toBe(true);
    expect(parseJourneyListQuery({ since: "2026-09-16T12:01:01Z" }, now).ok).toBe(false);
  });

  it("states the path parameter limit the router enforces", () => {
    expect(read("apps/api/src/app.ts")).toContain("const MAX_PARAM_LENGTH = 128 * 9;");
    expect(prose(read("docs/API_SPEC.md"))).toContain(
      "longer than 1,152 characters as encoded in the URL, nine for each of the protocol's 128"
    );
  });

  it("states the deletion batch sizes and the dry run's list limit", () => {
    const deletion = read("packages/database/src/repositories/deletion.ts");
    expect(deletion).toContain("const ERASURE_BATCH_SIZE = 500;");
    expect(deletion).toContain("const RANGE_BATCH_SIZE = 1_000;");
    expect(read("apps/api/src/routes/deletions.ts")).toContain("const DRY_RUN_LIMIT = 1_000;");
    expect(read("apps/api/src/routes/deletions.ts")).toContain("const MAX_VALUE_LENGTH = 512;");
    expect(read("packages/database/src/repositories/retention.ts")).toContain(
      "options.batchSize ?? 1_000"
    );
    expect(read("packages/database/src/repositories/rotation.ts")).toContain(
      "const DEFAULT_BATCH_SIZE = 500;"
    );
    expect(read("apps/api/src/retention-job.ts")).toContain(
      "const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;"
    );

    const api = prose(read("docs/API_SPEC.md"));
    expect(api).toContain("`journeys` lists at most 1,000");
    expect(api).toContain("deleting in transactions of 500 journeys");
    expect(api).toContain("longer than 512 characters");
    expect(prose(read("docs/OPERATIONS.md"))).toContain("in batches of 500");
    expect(prose(read("docs/SECURITY.md"))).toContain(
      "The sweep runs hourly in the API process and deletes at most 1,000 journeys per transaction"
    );
  });

  it("states the throttle and the admin token floor the code enforces", () => {
    const throttle = read("apps/api/src/address-throttle.ts");
    expect(throttle).toContain("MAX_TRACKED_ADDRESSES = 50_000;");
    expect(read("apps/web/src/lib/login-limiter.ts")).toContain("MAX_TRACKED_ADDRESSES = 50_000;");
    const operations = prose(read("docs/OPERATIONS.md"));
    expect(operations).toContain("each remembers at most 50,000 addresses");
    expect(operations).toContain(
      "five failures within a minute lock that address out for five minutes"
    );
    expect(operations).toContain(
      "The admin token is at least 32 characters and an API key carries 192 random bits"
    );
  });

  it("names the four subkeys and the key id length", () => {
    const master = "0123456789abcdef0123456789abcdef";
    expect(Object.keys(deriveSubkeys(master))).toHaveLength(4);
    expect(keyFingerprint(master)).toHaveLength(12);
    expect(prose(read("docs/OPERATIONS.md"))).toContain(
      "Four things derive from it by HKDF: field encryption, search tokens, the API-key pepper, and event content hashes"
    );
    expect(prose(read("docs/SECURITY.md"))).toContain("12-character HKDF fingerprint");
  });

  it("states doctor's sample as secret-names.ts bounds it", () => {
    expect(SAMPLE_BOUNDS).toEqual({
      journeysPerEnvironment: 100,
      eventsPerJourney: 5,
      events: 2_000,
      timeoutMs: 5_000
    });
    const source = read("packages/database/src/secret-names.ts");
    expect(source).toContain("const MAX_NAMES_SHOWN = 10;");
    expect(source).toContain("const MAX_NAME_SHOWN = 64;");
    const operations = prose(read("docs/OPERATIONS.md"));
    expect(operations).toContain("The cap of 2,000 events is shared evenly between environments");
    expect(operations).toContain(
      "the 5 latest events of each of its 100 most recently active journeys"
    );
    expect(operations).toContain("`statement_timeout` at 5 seconds");
    expect(operations).toContain("at most ten names, each cut to 64 characters");
  });

  it("names the metrics the API exposes, and their buckets", () => {
    const source = read("apps/api/src/metrics/api-metrics.ts");
    const declared = [...source.matchAll(/^\s+"((?:wayscribe|process|nodejs)_[a-z_]+)",$/gm)].map(
      (match) => match[1]
    );
    const rows = tableRows(subsection("docs/OPERATIONS.md", "Metrics"));
    expect(rows.map((row) => codeWords(row[0] ?? "")[0])).toEqual(declared);

    const buckets = capture(source, /\n\s+(0\.005, [^\n]+)\n/, "the duration buckets")
      .split(",")
      .map((value) => Number(value.trim()));
    expect(buckets).toEqual([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
    expect(prose(read("docs/OPERATIONS.md"))).toContain(
      "The request duration buckets are 5, 10, 25, 50, 100, 250 and 500 milliseconds, then 1, 2.5, 5, 10 and 30 seconds."
    );
    expect(source).toContain(
      'KNOWN_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])'
    );
    expect(prose(read("docs/OPERATIONS.md"))).toContain("one of the seven methods the API uses");
  });

  it("states the lock timeouts the migrations set, and the Helm Job's retries", () => {
    const migrations = "packages/database/migrations";
    expect(read(`${migrations}/017_alias_displayable.js`)).toContain("lock_timeout = '5s'");
    expect(read(`${migrations}/018_journey_browse.js`)).toContain("lock_timeout = '5s'");
    expect(read(`${migrations}/019_journey_browse_indexes.js`)).toContain(
      'export const LOCK_TIMEOUT = "10min";'
    );
    const job = read("deploy/helm/wayscribe/templates/migrate-job.yaml");
    expect(job).toContain("for attempt in $(seq 1 30); do");
    expect(job).toContain("sleep 2");
    expect(read("deploy/helm/wayscribe/values.yaml")).toContain("activeDeadlineSeconds: 1800");

    const operations = prose(read("docs/OPERATIONS.md"));
    expect(operations).toContain("sets `lock_timeout` to five seconds");
    expect(operations).toContain("up to 10 minutes for its lock");
    expect(operations).toContain("retries `migrate` up to 30 times");
    expect(operations).toContain("`migrations.activeDeadlineSeconds`, 30 minutes by default");
    expect(prose(read("deploy/helm/README.md"))).toContain("up to 30 attempts, 2 seconds apart");
    expect(prose(read("deploy/helm/README.md"))).toContain(
      "`migrations.activeDeadlineSeconds`, 1800 by default"
    );
  });

  it("builds concurrently the indexes OPERATIONS says it does", () => {
    const concurrent = readdirSync(`${root}packages/database/migrations`)
      .filter((file) =>
        /create index concurrently/i.test(read(`packages/database/migrations/${file}`))
      )
      .map((file) => file.slice(0, 3));
    expect(concurrent).toEqual(["013", "014", "016", "019"]);
    expect(prose(read("docs/OPERATIONS.md"))).toContain(
      "Migrations 013, 014, 016, and 019 build their indexes with `CREATE INDEX CONCURRENTLY`"
    );
  });

  it("shows the pending migration count a fresh database reports", () => {
    const count = readdirSync(`${root}packages/database/migrations`).filter((file) =>
      file.endsWith(".js")
    ).length;
    expect(read("docs/TROUBLESHOOTING.md")).toContain(`"pendingCount":${String(count)}}`);
  });
});

describe("deployment claims", () => {
  interface Service {
    ports?: string[];
  }
  const composeFiles = (): string[] =>
    readdirSync(`${root}infrastructure`).filter(
      (name) => name.startsWith("compose.") && name.endsWith(".yaml")
    );
  const services = (file: string): [string, Service][] =>
    Object.entries(
      (
        parse(read(`infrastructure/${file}`), { merge: true, logLevel: "error" }) as {
          services?: Record<string, Service>;
        }
      ).services ?? {}
    );

  it("binds every published port to 127.0.0.1, except the CI overlay's", () => {
    // OPERATIONS §9 and LOCAL_DEVELOPMENT §4. compose.ci.yaml exists to
    // republish two ports inside docker-in-docker, and says so.
    let checked = 0;
    for (const file of composeFiles().filter((name) => name !== "compose.ci.yaml")) {
      for (const [name, service] of services(file)) {
        for (const port of service.ports ?? []) {
          checked += 1;
          expect(port, `${file}: ${name}`).toMatch(/^127\.0\.0\.1:/);
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("lists the local URLs the Compose files publish", () => {
    const published = new Map<string, string>();
    for (const file of ["compose.yaml", "compose.demo.yaml"]) {
      for (const [name, service] of services(file)) {
        for (const port of service.ports ?? []) {
          const host = /^127\.0\.0\.1:(?:\$\{[A-Z_]+:-)?(\d+)\}?:/.exec(port)?.[1];
          if (host !== undefined) published.set(name, host);
        }
      }
    }
    const block = capture(
      sectionOf("docs/LOCAL_DEVELOPMENT.md", "4. Local URLs"),
      /```text\n([\s\S]*?)```/,
      "the URL list"
    );
    const listed = new Map(
      block
        .trim()
        .split("\n")
        .map((line) => {
          const [label = "", address = ""] = line.split(": ");
          return [label, /:(\d+)$/.exec(address)?.[1] ?? ""];
        })
    );
    expect(listed).toEqual(
      new Map([
        ["Web", published.get("web")],
        ["API", published.get("api")],
        ["Demo source", published.get("demo-source")],
        ["Demo integration", published.get("demo-integration")],
        ["Demo target", published.get("demo-target")],
        ["PostgreSQL", published.get("postgres")],
        ["ElasticMQ", published.get("elasticmq")]
      ])
    );
  });

  it("requires a release version in compose.published.yaml, and the documented installs set one", () => {
    const published = read("infrastructure/compose.published.yaml");
    const images = [...published.matchAll(/^\s+image: (.+)$/gm)].map((match) => match[1] ?? "");
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image).toContain("${WAYSCRIBE_VERSION:?");
      expect(image).not.toContain("latest");
    }
    for (const document of ["README.md", "docs/OPERATIONS.md"]) {
      expect(read(document), document).toContain("export WAYSCRIBE_VERSION=vX.Y.Z");
    }
  });

  it("pins every CI image to a tag, and the scanners to a digest", () => {
    const ci = parse(read(".gitlab-ci.yml")) as Record<
      string,
      { image?: string | { name: string } }
    >;
    const images = Object.entries(ci).flatMap(([job, value]) => {
      const image = typeof value.image === "string" ? value.image : value.image?.name;
      return image === undefined ? [] : [[job, image] as const];
    });
    expect(images.length).toBeGreaterThan(5);
    for (const [job, image] of images) {
      expect(image, job).toMatch(/:[^:@]+(@sha256:[0-9a-f]{64})?$/);
      expect(image, job).not.toMatch(/:latest\b/);
    }
    const gitleaks = images.find(([job]) => job === "secrets")?.[1] ?? "";
    expect(gitleaks).toMatch(/^zricethezav\/gitleaks:v[\d.]+@sha256:[0-9a-f]{64}$/);
    const pinned = capture(gitleaks, /gitleaks:(v[\d.]+)@/, "the gitleaks version");
    expect(prose(read("docs/OPERATIONS.md"))).toContain(`zricethezav/gitleaks:${pinned}`);
  });

  it("shows a placeholder, never a real release, in every image verification command", () => {
    for (const document of AUDITED_DOCUMENTS) {
      const text = read(document);
      for (const line of text
        .split("\n")
        .filter((l) => /cosign verify|refs\/tags\/|^TAG=|trivy sbom/.test(l))) {
        expect(line, `${document}: ${line}`).not.toMatch(/v\d+\.\d+\.\d+/);
      }
    }
    expect(read("SECURITY.md")).toContain("api:vX.Y.Z");
    expect(read("docs/OPERATIONS.md")).toContain("TAG=vX.Y.Z");
  });

  it("names the tarball the SDK's version packs", () => {
    const version = (JSON.parse(read("packages/sdk-node/package.json")) as { version: string })
      .version;
    const tarball = `wayscribe-node-${version}.tgz`;
    for (const document of ["README.md", "packages/sdk-node/README.md"]) {
      const named = [...read(document).matchAll(/wayscribe-node-[\d.]+\.tgz/g)].map((m) => m[0]);
      expect(named.length, document).toBeGreaterThan(0);
      for (const name of named) expect(name, document).toBe(tarball);
    }
  });
});

describe("the repository the README describes", () => {
  it("lists every app and package in its layout", () => {
    const layout = capture(
      sectionOf("README.md", "Built with"),
      /```text\n([\s\S]*?)```/,
      "the layout block"
    );
    for (const parent of ["apps", "packages"]) {
      for (const entry of readdirSync(`${root}${parent}`, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        expect(layout, `${parent}/${entry.name} is not in the README's layout`).toMatch(
          new RegExp(`^\\s+${entry.name}/`, "m")
        );
      }
    }
  });

  it("names only package scripts that exist, in LOCAL_DEVELOPMENT's command table", () => {
    const scripts = Object.keys(
      (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts
    );
    const rows = tableRows(sectionOf("docs/LOCAL_DEVELOPMENT.md", "6. Commands"));
    const named = rows.flatMap((row) =>
      codeWords(row[0] ?? "").map((command) => /^pnpm (\S+)/.exec(command)?.[1] ?? "")
    );
    expect(named.length).toBeGreaterThan(15);
    for (const name of named) expect(scripts, `pnpm ${name}`).toContain(name);
  });

  it("dates the counts and measurements it states", () => {
    expect(read("docs/ROADMAP.md")).toMatch(/Counted on \d{4}-\d{2}-\d{2}: [\d,]+ unit\s+tests/);
    expect(read("docs/OPERATIONS.md")).toMatch(
      /Measured on \d{4}-\d{2}-\d{2} on\s+an Apple M3 Pro/
    );
    expect(read("packages/sdk-node/README.md")).toMatch(
      /measured on \d{4}-\d{2}-\d{2}, with the SDK as it is now/
    );
    for (const heading of [
      "What does the SDK cost my service?",
      "How much disk does an event take?",
      "How fast are search and the journey list?"
    ]) {
      expect(sectionOf("docs/FAQ.md", heading), heading).toMatch(
        /[Mm]easured on \d{4}-\d{2}-\d{2}/
      );
    }
    expect(read("README.md")).toMatch(/Measured on \d{4}-\d{2}-\d{2} from a fresh clone/);
  });

  it("keeps the ingestion contract's pointer to the conformance loader's size true", () => {
    const lines = read("packages/protocol/src/conformance.ts").split("\n").length;
    expect(read("docs/INGESTION_CONTRACT.md")).toContain("under six hundred lines");
    expect(lines).toBeLessThan(600);
  });

  it("states the PostgreSQL versions CI runs, the same way everywhere", () => {
    // FAQ once said "CI tests 17" and that doctor warns below 17, a week after
    // CI moved to 15, 17 and 18.
    for (const document of AUDITED_DOCUMENTS) {
      expect(read(document), document).not.toMatch(/CI tests 17\b/);
      expect(read(document), document).not.toMatch(/warns below 17/);
    }
    expect(prose(read("docs/FAQ.md"))).toContain(
      "CI runs the whole integration suite on 15, 17 and 18"
    );
  });
});

describe("the audited documents' prose", () => {
  it("uses no em or en dashes", () => {
    for (const document of [...AUDITED_DOCUMENTS, "docs/DECISIONS.md", "CHANGELOG.md"]) {
      const lines = read(document)
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /[–—]/.test(line));
      expect(lines, document).toEqual([]);
    }
  });

  it("points a reader whose SDK sends nothing at the troubleshooting walk-through", () => {
    const local = read("docs/LOCAL_DEVELOPMENT.md");
    const start = local.indexOf("### SDK emits no events");
    expect(local.slice(start, local.indexOf("\n### ", start + 1))).toContain(
      "TROUBLESHOOTING.md#no-journeys-appear"
    );
    const row = read("docs/OPERATIONS.md")
      .split("\n")
      .find((line) => line.startsWith("| SDK sends nothing |"));
    expect(row).toContain("TROUBLESHOOTING.md#no-journeys-appear");
  });

  it("does not call an unauthorized_environment refusal on the batch route a 403 response", () => {
    // The batch route answers 202 and puts httpStatus 403 in the event's
    // result; only POST /v1/events answers the request 403.
    for (const document of AUDITED_DOCUMENTS) {
      expect(read(document), document).not.toMatch(/Ingestion returns 403/);
    }
  });

  it("describes a name-value object as the redaction code reads it", () => {
    // The rule once needed exactly the keys name and value; a third key such as
    // HAR's comment defeated it. SECURITY section 4 records why it changed.
    for (const document of AUDITED_DOCUMENTS) {
      expect(read(document), document).not.toMatch(/exactly the keys `name` and `value`/);
    }
  });
});
