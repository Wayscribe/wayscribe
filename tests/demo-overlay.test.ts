import { readFileSync } from "node:fs";
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
    expect(overlay["caddy"]?.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
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
