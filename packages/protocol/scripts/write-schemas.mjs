#!/usr/bin/env node
/**
 * Write the generated JSON Schema files.
 *
 * Run through `pnpm --filter @flight-recorder/protocol run schemas`, which
 * builds the package first: this reads `dist`, so that the files it writes come
 * from the same code the drift test imports.
 *
 * The drift check itself is a unit test rather than a job in the pipeline. It
 * runs in the existing `unit` job, it runs on a laptop, and it needs nothing
 * outside Node, which matters because the CI image has no git.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, buildJsonSchemas, serializeSchema } from "../dist/index.js";

const directory = fileURLToPath(new URL(`../schemas/${PROTOCOL_VERSION}/`, import.meta.url));
mkdirSync(directory, { recursive: true });

const schemas = buildJsonSchemas();
const wanted = new Set(Object.keys(schemas).map((name) => `${name}.schema.json`));

// A schema that stops being generated has to stop being published, or the drift
// test would pass while a stale contract sat in the directory being read by
// somebody's tooling.
for (const existing of readdirSync(directory)) {
  if (existing.endsWith(".schema.json") && !wanted.has(existing)) {
    rmSync(`${directory}${existing}`);
    console.log(`removed ${existing}`);
  }
}

for (const [name, schema] of Object.entries(schemas)) {
  writeFileSync(`${directory}${name}.schema.json`, serializeSchema(schema));
  console.log(`wrote ${name}.schema.json`);
}
