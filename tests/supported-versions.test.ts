import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The README's "Supported versions" table against what enforces and tests it:
 * the `engines` fields, `.gitlab-ci.yml`, the integration config, and the other
 * documents that restate a version. Every value is read from its file, so
 * changing a matrix or an engines range without the table fails here.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

interface Manifest {
  engines?: { node?: string };
}
const engines = (relative: string): string | undefined =>
  (JSON.parse(read(relative)) as Manifest).engines?.node;

interface Job {
  image?: string | { name: string };
  parallel?: { matrix: Record<string, string[]>[] };
  script?: string[];
  before_script?: string[];
}
const ci = parse(read(".gitlab-ci.yml")) as Record<string, Job | undefined> & {
  default: Job;
};

function job(name: string): Job {
  const found = ci[name];
  if (found === undefined) throw new Error(`.gitlab-ci.yml has no ${name} job`);
  return found;
}

function matrix(name: string, variable: string): string[] {
  const values = job(name).parallel?.matrix.flatMap((entry) => entry[variable] ?? []);
  if (values === undefined || values.length === 0) {
    throw new Error(`${name} has no ${variable} matrix`);
  }
  return values;
}

/** The table's rows, keyed by the first cell. */
function table(): Map<string, { supported: string; tested: string }> {
  const readme = read("README.md");
  const start = readme.indexOf("\n## Supported versions\n");
  if (start === -1) throw new Error("README.md has no Supported versions section");
  const end = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, end === -1 ? undefined : end);

  const rows = new Map<string, { supported: string; tested: string }>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| ---") || line.startsWith("| Component"))
      continue;
    const [component, supported, tested] = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (component === undefined || supported === undefined || tested === undefined) continue;
    rows.set(component, { supported, tested });
  }
  return rows;
}

function row(component: string): { supported: string; tested: string } {
  const found = table().get(component);
  if (found === undefined) throw new Error(`the table has no "${component}" row`);
  return found;
}

/** "15, 17 and 18: the whole suite" -> ["15", "17", "18"]: the versions before the colon. */
function testedVersions(cell: string): string[] {
  const head = cell.split(":")[0] ?? "";
  return head.match(/\d+(?:\.\d+)*/g) ?? [];
}

/** "22.12 or later" and ">=22.12.0" name the same floor. */
function floor(text: string): string {
  const match = /(\d+(?:\.\d+)*)/.exec(text);
  if (match?.[1] === undefined) throw new Error(`no version in "${text}"`);
  const parts = match[1].split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

describe("the README's Supported versions table", () => {
  it("has exactly the rows this test checks", () => {
    expect([...table().keys()]).toEqual([
      "Node.js for the SDK and the CLI",
      "Node.js for running from a clone",
      "PostgreSQL",
      "Docker Compose",
      "Container images"
    ]);
  });

  it("states the SDK's and the CLI's engines floor, and the Node versions sdk-node runs", () => {
    const { supported, tested } = row("Node.js for the SDK and the CLI");
    expect(supported).toMatch(/^\d+\.\d+ or later$/);
    const declared = `>=${floor(supported)}`;
    expect(engines("packages/sdk-node/package.json")).toBe(declared);
    expect(engines("packages/cli/package.json")).toBe(declared);

    const versions = matrix("sdk-node", "SDK_NODE_VERSION");
    expect(testedVersions(tested)).toEqual(versions);
    // The oldest version tested is the floor itself, not a later 22.
    expect(versions[0]).toBe(floor(supported));
    expect(job("sdk-node").script).toEqual(['scripts/sdk-node-versions.sh "$SDK_NODE_VERSION"']);
  });

  it("states the Node a clone runs on, which is the root's engines and the default CI image", () => {
    const { supported, tested } = row("Node.js for running from a clone");
    const major = supported;
    expect(major).toMatch(/^\d+$/);
    expect(engines("package.json")).toBe(`>=${major}.0.0 <${String(Number(major) + 1)}.0.0`);
    expect(testedVersions(tested)).toEqual([major]);
    expect(ci.default.image).toBe(`node:${major}-alpine`);

    // No job runs another Node image, and only the root, the SDK and the CLI
    // declare engines: the other packages run from the clone.
    for (const [name, value] of Object.entries(ci)) {
      const image = typeof value?.image === "string" ? value.image : value?.image?.name;
      if (image?.startsWith("node:") === true) {
        expect(image, name).toMatch(new RegExp(`^node:${major}(-alpine)?$`));
      }
    }
    for (const manifest of [
      "apps/api/package.json",
      "apps/web/package.json",
      "apps/demo/package.json",
      "packages/config/package.json",
      "packages/database/package.json",
      "packages/payload-diff/package.json",
      "packages/payload-security/package.json",
      "packages/protocol/package.json"
    ]) {
      expect(engines(manifest), manifest).toBeUndefined();
    }
  });

  it("states the PostgreSQL floor and the releases database runs", () => {
    const { supported, tested } = row("PostgreSQL");
    expect(supported).toBe("15 or later");
    const versions = matrix("database", "TEST_POSTGRES_VERSION");
    expect(testedVersions(tested)).toEqual(versions);
    expect(versions[0]).toBe("15");
    expect(job("database").script).toEqual(["pnpm test:integration"]);

    // The integration config's default is one of the tested releases, and the
    // image Compose and the Helm chart run.
    const config = read("vitest.integration.config.ts");
    const fallback = /process\.env\.TEST_POSTGRES_VERSION \?\? "(\d+)"/.exec(config)?.[1];
    expect(versions).toContain(fallback);
    expect(read("infrastructure/compose.yaml")).toContain(`postgres:${String(fallback)}-alpine`);
    expect(read("deploy/helm/wayscribe/values.yaml")).toContain(
      `postgres:${String(fallback)}-alpine`
    );

    // doctor's newest tested release is the matrix's newest.
    const doctor = read("packages/database/src/doctor.ts");
    expect(/const NEWEST_TESTED_POSTGRES = (\d+);/.exec(doctor)?.[1]).toBe(versions.at(-1));
    expect(doctor).toContain(
      `CI tests ${versions.slice(0, -1).join(", ")} and ${String(versions.at(-1))}.`
    );
  });

  it("is restated the same way in OPERATIONS.md and the SDK README", () => {
    const versions = matrix("database", "TEST_POSTGRES_VERSION");
    const list = `${versions.slice(0, -1).join(", ")}\nand ${String(versions.at(-1))}`;
    const operations = read("docs/OPERATIONS.md");
    expect(operations).toContain("It needs PostgreSQL 15 or later");
    expect(operations).toContain(`on PostgreSQL ${list}.`);
    expect(operations).not.toMatch(/CI tests 17\b/);

    const sdk = read("packages/sdk-node/README.md");
    const node = matrix("sdk-node", "SDK_NODE_VERSION");
    expect(sdk).toContain(
      `Node ${floor(row("Node.js for the SDK and the CLI").supported).replace(/\.0$/, "")} or later.`
    );
    expect(sdk).toContain(`CI checks this on Node ${node.join(" and ")}:`);
  });

  it("names the platforms a release publishes", () => {
    const { supported } = row("Container images");
    const platforms = /PLATFORMS="\$\{PLATFORMS:-([^}]+)\}"/.exec(
      read("scripts/publish-image.sh")
    )?.[1];
    expect(supported).toBe(platforms?.split(" ").join(", "));
  });

  it("names the Compose floor the Compose files need", () => {
    const { supported, tested } = row("Docker Compose");
    expect(supported).toBe("2.24 or later");
    // `required: false` under env_file is the feature that sets the floor.
    expect(read("infrastructure/compose.yaml")).toMatch(/env_file:[\s\S]*?required: false/);
    expect(tested).toContain("docker-cli-compose");
    expect(job("demo").before_script).toContain("apk add --no-cache docker-cli docker-cli-compose");
  });
});
