#!/usr/bin/env node
// One-off rename from Flight Recorder to Wayscribe (ADR-057). Deleted after use.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SKIP = [
  /^docs\/superpowers\/(specs|plans)\//,
  /^docs\/reviews\//,
  /^docs\/claims-audit-2026-09-16\.md$/,
  /^packages\/database\/migrations\//,
  /^docs\/DECISIONS\.md$/,
  /^CHANGELOG\.md$/,
  /^pnpm-lock\.yaml$/,
  /^tests\/rename-guard\.test\.ts$/,
  /^packages\/payload-security\/src\/derivation-labels\.test\.ts$/,
  /^scripts\/rename-to-wayscribe\.mjs$/,
  /\.(png|jpg|jpeg|gif|ico|tgz|woff2?)$/
];
const PROTECTED =
  /flight-recorder\/(field-encryption|search-token|api-key|content-hash|key-id|web-session)/;

const RULES = [
  ["registry.gitlab.com/jojithedev/flight-recorder", "registry.gitlab.com/jojithedev/wayscribe"],
  ["gitlab.com/jojithedev/flight-recorder", "gitlab.com/jojithedev/wayscribe"],
  ["jojithedev%2Fflight-recorder", "jojithedev%2Fwayscribe"],
  ["@flight-recorder/", "@wayscribe/"],
  ["fr-flight-recorder-", "ws-wayscribe-"],
  ["flight-recorder", "wayscribe"],
  ["FLIGHT_RECORDER_", "WAYSCRIBE_"],
  ["FLIGHT_API_", "WAYSCRIBE_API_"],
  ["FLIGHT_ENDPOINT", "WAYSCRIBE_ENDPOINT"],
  ["FLIGHT_ENVIRONMENT", "WAYSCRIBE_ENVIRONMENT"],
  ["flight_recorder_", "wayscribe_"],
  ["flight_recorder", "wayscribe"],
  ["FlightRecorder", "Wayscribe"],
  ["flightRecorder", "wayscribe"],
  ["Flight Recorder", "Wayscribe"],
  ["X-FLIGHT-", "X-WAYSCRIBE-"],
  ["X-Flight-", "X-Wayscribe-"],
  ["x-flight-", "x-wayscribe-"],
  ["flightJourney", "wayscribeJourney"],
  ["flightEntity", "wayscribeEntity"],
  [/\b_flight\b/g, "_wayscribe"],
  ["flight_session", "wayscribe_session"],
  ["flight_app", "wayscribe_app"],
  ["flight.example", "wayscribe.example"],
  ["flight-builder", "wayscribe-builder"]
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
let changed = 0;
for (const file of files) {
  if (SKIP.some((pattern) => pattern.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  const lines = text.split("\n").map((line) => {
    if (PROTECTED.test(line)) return line;
    let next = line;
    for (const [from, to] of RULES)
      next = typeof from === "string" ? next.split(from).join(to) : next.replace(from, to);
    return next;
  });
  const result = lines.join("\n");
  if (result !== text) {
    writeFileSync(file, result);
    changed += 1;
  }
}
console.log(`rewrote ${changed} files`);
