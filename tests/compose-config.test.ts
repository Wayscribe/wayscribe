import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const infrastructure = fileURLToPath(new URL("../infrastructure/", import.meta.url));

interface EnvFile {
  path: string;
}

interface Service {
  env_file?: string | Array<string | EnvFile>;
  environment?: Record<string, string | number | boolean | null> | string[];
  ports?: string[];
}

const composeFiles = readdirSync(infrastructure).filter(
  (name) => name.startsWith("compose.") && name.endsWith(".yaml")
);

const services = (file: string): Array<[string, Service]> => {
  const document = parse(readFileSync(`${infrastructure}${file}`, "utf8"), {
    merge: true,
    // Compose's own tags, such as `!override` in compose.ci.yaml, are unknown to
    // the parser, which keeps the tagged value as it is and warns on stderr.
    logLevel: "error"
  }) as { services?: Record<string, Service> };
  return Object.entries(document.services ?? {});
};

const readsRootEnv = (service: Service): boolean => {
  const files = service.env_file === undefined ? [] : [service.env_file].flat();
  return files.some((entry) => (typeof entry === "string" ? entry : entry.path) === "../.env");
};

const environmentValue = (service: Service, name: string): string | undefined => {
  const environment = service.environment;
  if (environment === undefined) return undefined;
  if (Array.isArray(environment)) {
    const entry = environment.find((line) => line.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  }
  const value = environment[name];
  return value === undefined ? undefined : String(value);
};

/** The container side of a `host:container` or `ip:host:container` mapping. */
const containerPort = (mapping: string): string => mapping.split(":").at(-1) ?? mapping;

describe("the Compose stacks built from source", () => {
  it("finds the compose files it checks", () => {
    expect(composeFiles).toContain("compose.yaml");
  });

  // The repository-root .env is whatever the reader put there, starting with a
  // copy of .env.example. When that set PORT=8080, the web container read it,
  // Next listened on 8080 inside the container, and the published
  // 127.0.0.1:3000 mapping reached nothing: the documented `cp .env.example
  // .env` emptied the interface. `environment:` wins over `env_file:`, so a
  // service that loads the root .env must pin the port its mapping targets.
  it("pins PORT to the published container port for every service that reads the root .env", () => {
    let checked = 0;
    for (const file of composeFiles) {
      for (const [name, service] of services(file)) {
        if (!readsRootEnv(service) || service.ports === undefined) continue;
        for (const mapping of service.ports) {
          checked += 1;
          expect(
            environmentValue(service, "PORT"),
            `${file}: ${name} reads ../.env and publishes ${mapping}, so it must set PORT: "${containerPort(mapping)}" under environment`
          ).toBe(containerPort(mapping));
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // A second stack on other ports has to be able to say so. Every other
  // setting in the published file already reads `${NAME:-default}`; APP_URL and
  // API_URL were literal, so the links the API builds pointed at the first
  // stack's ports whatever the operator set (F-015).
  it.each([
    ["APP_URL", "http://localhost:3000"],
    ["API_URL", "http://localhost:8080"]
  ])("reads %s from the environment, keeping its localhost default", (name, fallback) => {
    for (const file of composeFiles) {
      const api = services(file).find(([service]) => service === "api");
      if (api === undefined) continue;
      const value = environmentValue(api[1], name);
      if (value === undefined) continue;
      expect(value, `${file}: api sets ${name} to a literal value`).toBe(
        `\${${name}:-${fallback}}`
      );
    }
  });
});

describe("optional OTLP wiring", () => {
  it.each(["compose.yaml", "compose.published.yaml"])(
    "%s keeps two optional settings configurable",
    (file) => {
      const api = services(file).find(([name]) => name === "api")?.[1];
      if (api === undefined) throw new Error("missing API service");
      if (file === "compose.yaml") {
        expect(readsRootEnv(api)).toBe(true);
        expect(environmentValue(api, "OTLP_LOGS_ENABLED")).toBeUndefined();
        expect(environmentValue(api, "OTLP_MAX_REQUEST_BYTES")).toBeUndefined();
        // defaults.env holds only the published secrets the API warns about
        // (packages/config insecure-defaults test); unset, these two take the
        // config schema's defaults and the root .env still reaches the API.
        const defaults = readFileSync(`${infrastructure}defaults.env`, "utf8");
        expect(defaults).not.toContain("OTLP_");
      } else {
        expect(environmentValue(api, "OTLP_LOGS_ENABLED")).toBe("${OTLP_LOGS_ENABLED:-false}");
        expect(environmentValue(api, "OTLP_MAX_REQUEST_BYTES")).toBe(
          "${OTLP_MAX_REQUEST_BYTES:-4194304}"
        );
      }
    }
  );
});
