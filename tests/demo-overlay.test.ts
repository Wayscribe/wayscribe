import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, type ScalarTag } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

interface Service {
  ports?: unknown[];
  restart?: string;
  environment?: Record<string, unknown>;
  build?: unknown;
  image?: string;
  command?: string[];
  volumes?: string[];
  read_only?: boolean;
  depends_on?: Record<string, { condition?: string }>;
}

// Compose's `!reset null` removes an inherited attribute. Unknown tags parse as
// plain strings, so without this `build: !reset null` would read as "null".
// (`!reset []` already parses as an empty list.)
const reset: ScalarTag = {
  tag: "!reset",
  resolve: (value) => (value === "null" || value === "" ? null : value)
};

const services = (path: string, merge = true): Record<string, Service> =>
  (
    parse(read(path), { merge, logLevel: "error", customTags: [reset] }) as {
      services?: Record<string, Service>;
    }
  ).services ?? {};

const BASE_FILES = [
  "infrastructure/compose.published.yaml",
  "infrastructure/compose.bundled.yaml",
  "infrastructure/compose.demo.yaml"
];
const overlay = services("deploy/demo/compose.yaml");
const overlayUnmerged = services("deploy/demo/compose.yaml", false);
const ONE_SHOT = new Set(["migrate", "demo-bootstrap", "demo-history"]);

describe("the public demo overlay", () => {
  it("publishes no host port for any service but Caddy", () => {
    for (const file of BASE_FILES) {
      for (const [name, service] of Object.entries(services(file))) {
        if ((service.ports ?? []).length === 0) continue;
        expect(overlay[name]?.ports, `${name} from ${file} keeps a host port`).toEqual([]);
      }
    }
    for (const [name, service] of Object.entries(overlay)) {
      if (name === "caddy") continue;
      expect(service.ports ?? [], `${name} publishes a port`).toEqual([]);
    }
  });

  it("restarts every long-running service unless stopped", () => {
    const names = new Set([
      ...BASE_FILES.flatMap((file) => Object.keys(services(file))),
      ...Object.keys(overlay)
    ]);
    for (const name of names) {
      if (ONE_SHOT.has(name)) continue;
      expect(overlay[name]?.restart, name).toBe("unless-stopped");
    }
  });

  it("runs the web app in anonymous read-only mode holding no admin token", () => {
    expect(overlay["web"]?.environment?.["WEB_ANONYMOUS_READ_ONLY"]).toBe("true");
    expect(overlay["web"]?.environment?.["ADMIN_TOKEN"]).toBe("");
    expect(String(overlay["web"]?.environment?.["READ_TOKEN"])).toContain("READ_TOKEN");
  });

  it("runs the demo services from the published, signed demo image", () => {
    for (const name of [
      "demo-bootstrap",
      "demo-target",
      "demo-integration",
      "demo-worker",
      "demo-source",
      "demo-history"
    ]) {
      expect(overlay[name]?.image, name).toMatch(
        /^registry\.gitlab\.com\/jojithedev\/wayscribe\/demo:\$\{WAYSCRIBE_VERSION/
      );
      // On the service itself: Compose drops a `!reset` that arrives through a
      // `<<:` merge, so the base file's `build:` would survive and the VM could
      // build from source instead of pulling the signed image.
      expect(overlayUnmerged[name]?.build, name).toBeNull();
    }
  });

  it("bootstraps the demo only after the published stack's migrate has finished", () => {
    // Both run knex migrations against one database. Started together, the
    // second meets the first's migration lock and exits 1 (CI job 17011407800).
    expect(services("infrastructure/compose.published.yaml")["migrate"]).toBeDefined();
    expect(overlay["demo-bootstrap"]?.depends_on?.["migrate"]).toEqual({
      condition: "service_completed_successfully"
    });
  });

  it("smoke-checks the pinned journey the backfill writes", () => {
    const history = read("apps/demo/src/history.ts");
    const smoke = read("deploy/demo/smoke-check.sh");
    for (const constant of ["PINNED_JOURNEY_ID", "PINNED_TRANSFORM_EVENT_ID"]) {
      const value = new RegExp(`export const ${constant} = "([^"]+)"`).exec(history)?.[1];
      expect(value, constant).toBeDefined();
      expect(smoke).toContain(`${constant}="${value ?? ""}"`);
    }
  });

  it("tells robots to stay out and rate-limits by client", () => {
    const caddyfile = read("deploy/demo/caddy/Caddyfile");
    expect(caddyfile).toContain('X-Robots-Tag "noindex, nofollow"');
    expect(caddyfile).toContain("Disallow: /");
    expect(caddyfile).toMatch(/rate_limit/);
    // Keyed on the TCP peer, which at the edge is the visitor. A header key
    // (X-Forwarded-For) is whatever the client sends.
    expect(caddyfile).toContain("key {remote_host}");
    expect(caddyfile).toContain("events 300");
    expect(caddyfile).toContain("format json");
  });

  it("sends the security headers on errors too, including 429s", () => {
    const caddyfile = read("deploy/demo/caddy/Caddyfile");
    expect(caddyfile).toContain('Strict-Transport-Security "max-age=31536000"');
    const errors = /handle_errors \{([\s\S]*?)\n\t\}/.exec(caddyfile)?.[1] ?? "";
    expect(errors).toContain('X-Robots-Tag "noindex, nofollow"');
    expect(errors).toContain("-Server");
  });

  it("publishes exactly HTTP and HTTPS on Caddy", () => {
    expect(overlay["caddy"]?.ports).toEqual([
      "0.0.0.0:80:80",
      "0.0.0.0:443:443",
      "0.0.0.0:443:443/udp"
    ]);
  });

  it("gives the visit notifier the access log read-only and nothing writable", () => {
    const notifier = overlay["visit-notifier"];
    expect(notifier?.read_only).toBe(true);
    expect(notifier?.volumes?.length).toBeGreaterThan(0);
    for (const volume of notifier?.volumes ?? []) {
      expect(volume, "notifier volume").toMatch(/:ro$/);
    }
  });

  it("matches markup the web app really renders", () => {
    const smoke = read("deploy/demo/smoke-check.sh");
    const pins: [string, string, string][] = [
      // React writes className as class.
      [
        'class="mono removed">',
        "apps/web/app/components/DiffTable.tsx",
        'className="mono removed"'
      ],
      ["What changed", "apps/web/app/components/EventDetail.tsx", "What changed"],
      [
        "Public demo. Read-only, sample data.",
        "apps/web/app/components/DemoBanner.tsx",
        "Public demo. Read-only, sample data."
      ]
    ];
    for (const [inSmoke, file, inSource] of pins) {
      expect(smoke, "smoke-check.sh").toContain(inSmoke);
      expect(read(file), file).toContain(inSource);
    }
  });
});

interface CiJob {
  stage?: string;
  script?: string[];
  rules?: { if?: string; when?: string; changes?: string[] }[];
  when?: string;
  needs?: string[];
  resource_group?: string;
  after_script?: string[];
}

describe("the demo's CI jobs", () => {
  const ci = parse(read(".gitlab-ci.yml"), { merge: true }) as Record<string, CiJob>;
  const job = (name: string): CiJob => {
    const found = ci[name];
    if (found === undefined) throw new Error(`.gitlab-ci.yml has no ${name} job`);
    return found;
  };
  const script = (name: string): string => (job(name).script ?? []).join("\n");
  const releaseTag = "$CI_COMMIT_TAG =~ /^v\\d+\\.\\d+\\.\\d+$/";

  it("scans and inventories the demo image beside api and web", () => {
    expect(script("container-scan")).toContain("-t scan/demo:$CI_COMMIT_SHA");
    expect(script("container-scan")).toContain(
      "scan/web:$CI_COMMIT_SHA scan/demo:$CI_COMMIT_SHA; do"
    );
    expect(script("sbom")).toContain('"docker:sbom/demo:$CI_COMMIT_SHA" sboms/demo.cdx.json');
  });

  it("publishes and rehearses the demo image beside api and web", () => {
    expect(script("publish-images")).toContain('"apps/demo/Dockerfile=$CI_REGISTRY_IMAGE/demo"');
    expect(script("publish-images-rehearsal")).toContain(
      '"apps/demo/Dockerfile=$CI_REGISTRY_IMAGE/rehearsal/demo"'
    );
  });

  it("deploys only by hand, on a release tag, after the images are published", () => {
    const deploy = job("deploy-demo");
    expect(deploy.rules).toEqual([{ if: releaseTag }]);
    expect(deploy.when).toBe("manual");
    expect(deploy.needs).toEqual(["publish-images", "demo-overlay"]);
    expect(deploy.resource_group).toBe("demo");
    const body = script("deploy-demo");
    expect(body).toContain('"$CI_COMMIT_TAG"');
    // Absent variables (an unprotected tag) fail the job at once.
    expect(body).toContain(
      '|| { echo "deploy variables absent: is the tag protected?" >&2; exit 1; }'
    );
    expect(body).toContain("StrictHostKeyChecking=yes");
    expect(body).toContain("sh deploy/demo/smoke-check.sh https://demo.wayscribe.dev");
    // The key is decoded to a file and never echoed.
    expect(body).not.toMatch(/echo[^\n]*DEMO_DEPLOY_SSH_KEY/);
    expect(body).not.toMatch(/set -x/);
  });

  it("tests the overlay on every release tag and on branches that change it", () => {
    const overlay = job("demo-overlay");
    // It gates deploy-demo only: in the release stage, started with the pipeline.
    expect(overlay.stage).toBe("release");
    expect(overlay.needs).toEqual([]);
    expect(overlay.rules?.[0]).toEqual({ if: releaseTag });
    expect(overlay.rules?.[1]).toEqual({ if: '$CI_PIPELINE_SOURCE == "schedule"', when: "never" });
    expect(overlay.rules?.[2]?.changes).toContain("deploy/demo/**/*");
    expect(script("demo-overlay")).toBe("sh deploy/demo/ci/overlay-test.sh");
    // The overlay test's project name is the one the compose files declare.
    expect((overlay.after_script ?? []).join("\n")).toContain("docker compose -p wayscribe down");
    expect(read("infrastructure/compose.published.yaml")).toContain("\nname: wayscribe\n");
  });

  it("builds images under the names the compose files run", () => {
    const test = read("deploy/demo/ci/overlay-test.sh");
    expect(statSync(`${root}deploy/demo/ci/overlay-test.sh`).mode & 0o111).not.toBe(0);
    const registry = /^REGISTRY=(\S+)$/m.exec(test)?.[1];
    expect(registry).toBe("registry.gitlab.com/jojithedev/wayscribe");
    for (const name of ["api", "web"]) {
      expect(read("infrastructure/compose.published.yaml")).toContain(
        `image: ${registry ?? ""}/${name}:\${WAYSCRIBE_VERSION`
      );
    }
    expect(read("deploy/demo/compose.yaml")).toContain(
      `image: ${registry ?? ""}/demo:\${WAYSCRIBE_VERSION`
    );
  });
});

describe("the demo's history backfill", () => {
  // The smoke check passes as soon as the pinned journey exists, which the
  // backfill writes first, so only demo-history's exit code shows a failed
  // backfill (apps/demo/src/backfill.ts).
  it.each(["deploy/demo/host/reset.sh", "deploy/demo/ci/overlay-test.sh"])(
    "%s fails unless demo-history exits 0, after the smoke check",
    (path) => {
      const script = read(path);
      const smoke = script.indexOf("wait-for-smoke.sh");
      const lookup = script.indexOf("ps --all --quiet demo-history");
      const wait = script.indexOf("deploy/demo/wait-for-exit.sh");
      expect(smoke).toBeGreaterThan(-1);
      expect(lookup).toBeGreaterThan(smoke);
      expect(wait).toBeGreaterThan(lookup);
      expect(script.slice(wait)).toMatch(/wait-for-exit\.sh" "\$\{history\}" 900/);
    }
  );

  describe("wait-for-exit.sh", () => {
    const run = (state: string, deadline: string): number => {
      const bin = mkdtempSync(`${tmpdir()}/wait-for-exit-`);
      try {
        writeFileSync(`${bin}/docker`, `#!/bin/sh\necho "${state}"\n`);
        chmodSync(`${bin}/docker`, 0o755);
        const result = spawnSync(
          "sh",
          [`${root}deploy/demo/wait-for-exit.sh`, "abc123", deadline],
          {
            env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
            encoding: "utf8",
            timeout: 20_000
          }
        );
        return result.status ?? -1;
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    };

    it("passes only on a clean exit", () => {
      expect(run("exited 0", "60")).toBe(0);
      expect(run("exited 1", "60")).toBe(1);
      expect(run("dead 137", "60")).toBe(1);
    });

    it("gives up at the deadline instead of waiting forever", () => {
      expect(run("running 0", "0")).toBe(1);
      expect(run("created 0", "3")).toBe(1);
    });

    it("refuses a deadline that is not whole seconds", () => {
      expect(run("exited 0", "soon")).toBe(2);
    });
  });
});
