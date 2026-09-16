#!/usr/bin/env node
/**
 * Rewrite `conformance/manifest.json` from what is on disk.
 *
 * The manifest exists because every suite that runs these cases is generated
 * from the directory, so an empty or shrunken directory produces a smaller run
 * rather than a failure. A count guard is not enough either: it has to be
 * edited to match, and a guard with slack in it (">= 31" against 37 files) lets
 * six cases vanish silently. The manifest names them, so a missing case fails by
 * name.
 *
 * Run this deliberately, when a case is added or removed, which is a contract
 * change and is reviewed as one (ADR-049).
 */
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../conformance/", import.meta.url));

const ids = (layer) =>
  readdirSync(`${directory}${layer}`)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${layer}/${name.replace(".json", "")}`)
    .sort();

const manifest = {
  comment:
    "Every conformance case, by id. A case file is the contract, so one going missing is a contract change and has to be a failing test rather than a smaller run. Regenerate with: pnpm --filter @flight-recorder/protocol run conformance:manifest",
  wire: ids("wire"),
  sdk: ids("sdk")
};

writeFileSync(`${directory}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote manifest.json: ${String(manifest.wire.length)} wire, ${String(manifest.sdk.length)} sdk`
);
