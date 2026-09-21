import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import protobuf from "protobufjs";
import prettier from "prettier";

const directory = resolve(import.meta.dirname, "..");
const sources = [
  "opentelemetry/proto/common/v1/common.proto",
  "opentelemetry/proto/resource/v1/resource.proto",
  "opentelemetry/proto/logs/v1/logs.proto",
  "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  "google/rpc/status.proto"
];
const root = new protobuf.Root();
for (const source of sources)
  protobuf.parse(readFileSync(resolve(directory, "sources", source), "utf8"), root);
// Any is the bundled, pinned protobufjs well-known-type descriptor.
const anySource = "google/protobuf/any.json";
const any = JSON.parse(readFileSync(resolve(directory, "sources", anySource), "utf8"));
if (JSON.stringify(any) !== JSON.stringify(protobuf.common["google/protobuf/any.proto"]))
  throw Error("Pinned protobufjs Any descriptor differs");
root.addJSON(any.nested);
root.resolveAll();
const descriptor = { nested: {} };
const visited = new Set();
function add(type) {
  if (visited.has(type.fullName)) return;
  visited.add(type.fullName);
  const parts = type.fullName.slice(1).split(".");
  let parent = descriptor;
  for (const part of parts.slice(0, -1)) parent = parent.nested[part] ??= { nested: {} };
  const value = type.toJSON();
  delete value.options;
  delete value.reserved;
  parent.nested[parts.at(-1)] = value;
  for (const field of type.fieldsArray ?? []) if (field.resolvedType) add(field.resolvedType);
}
for (const name of [
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse",
  "google.rpc.Status"
])
  add(root.lookupType(name));
const hashes =
  [...sources, anySource, "LICENSE", "PROTOBUFJS-LICENSE"]
    .map(
      (source) =>
        `${createHash("sha256")
          .update(readFileSync(resolve(directory, "sources", source)))
          .digest("hex")}  ${source}`
    )
    .join("\n") + "\n";
const distributionLicense = readFileSync(
  resolve(directory, "sources", "PROTOBUFJS-LICENSE"),
  "utf8"
);
const text = await prettier.format(
  `// Generated offline by schema/scripts/generate.mjs; see schema/README.md.\n// Copyright 2019-2020 OpenTelemetry Authors; Copyright 2026 Google LLC.\n// OTLP and google.rpc sources: Apache-2.0; protobufjs Any descriptor: BSD-3-Clause.\n// Source pins: OTLP 790608c4d51e6ffc12210b541e8514cbed9e91a4,\n// googleapis ebd1d23ac613b177828dad42ad8dfb13ba498279; protobufjs 7.6.6.\n/*\n${distributionLicense}*/\nimport type { INamespace } from "protobufjs";\nexport const descriptor: INamespace = ${JSON.stringify(descriptor)};\n`,
  { parser: "typescript", ...(await prettier.resolveConfig(directory)) }
);
for (const [name, content] of [
  ["descriptor.ts", text],
  ["SHA256SUMS", hashes]
]) {
  const path = resolve(directory, name);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== content) throw Error(`${name} differs`);
  } else writeFileSync(path, content);
}
console.log(
  process.argv.includes("--check")
    ? "Descriptor and source hashes reproduce exactly."
    : "Generated descriptor and source hashes."
);
