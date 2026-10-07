import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  closeWindowIfOver,
  createState,
  handleRecord,
  parseCaddyLine,
  sendToNtfy,
  type Message
} from "./notifier.ts";

/**
 * Tails Caddy's access log and posts visits to ntfy. A separate process that
 * only reads a file, so it can never block or slow Caddy. Starts at the end of
 * the log: a restart does not replay old visits. Follows Caddy's roll, which
 * renames the file and starts a new one.
 */
const logPath = process.env["ACCESS_LOG"] ?? "/logs/access.log";
const ntfyUrl = process.env["NTFY_URL"] ?? "https://ntfy.sh";
const topic = process.env["NTFY_TOPIC"] ?? "";
const ownHost = process.env["DEMO_HOST"] ?? "";
if (topic === "") {
  console.error("visit-notifier: NTFY_TOPIC is not set");
  process.exit(1);
}

const newSalt = (): string => randomBytes(32).toString("hex");
const state = createState(Date.now(), newSalt);
const log = (line: string): void => {
  console.error(line);
};

function send(messages: Message[]): void {
  for (const message of messages) {
    void sendToNtfy(message, { url: ntfyUrl, topic, fetch, log });
  }
}

let first = true;
let inode = -1;
let offset = 0;
let partial = "";
let decoder = new StringDecoder("utf8");
const CHUNK_BYTES = 1_048_576;

function poll(): void {
  let stats;
  try {
    stats = statSync(logPath);
  } catch {
    first = false; // Not written yet: read it from the start once it is.
    return;
  }
  if (stats.ino !== inode || stats.size < offset) {
    offset = first ? stats.size : 0;
    inode = stats.ino;
    partial = "";
    decoder = new StringDecoder("utf8");
  }
  first = false;
  if (stats.size === offset) return;

  const fd = openSync(logPath, "r");
  try {
    const length = Math.min(stats.size - offset, CHUNK_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    offset += read;
    const lines = (partial + decoder.write(buffer.subarray(0, read))).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseCaddyLine(line);
      if (record !== null) send(handleRecord(state, record, { now: Date.now(), ownHost, newSalt }));
    }
  } finally {
    closeSync(fd);
  }
}

console.log(`visit-notifier: watching ${logPath}`);
setInterval(poll, 1000);
setInterval(() => {
  send(closeWindowIfOver(state, Date.now()));
}, 60_000);
