import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request as undiciRequest } from "undici";
import { checkAddress } from "./address-policy.js";
import { resolveReplayUrl, type PolicyFailure } from "./url-policy.js";

export type SendFailure = PolicyFailure | "dns_failed" | "address_not_allowed";

export interface SendOptions {
  baseUrl: string;
  path: string;
  method: "POST" | "PUT" | "PATCH";
  headers: Record<string, string>;
  payload: unknown;
  allowedHosts: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type SendOutcome =
  | { ok: true; status: number; body: unknown; truncated: boolean; durationMs: number }
  | { ok: false; blocked: true; reason: SendFailure; message: string }
  | { ok: false; blocked: false; reason: "request_failed"; message: string; durationMs: number };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * Send one replay request.
 *
 * The host is resolved once, the resolved address is checked, and the
 * connection is made **to that address** (ADR-033). Handing a validated
 * hostname to an HTTP client would let it resolve the name a second time, and a
 * name that answered with an allowed address during validation can answer with
 * another a moment later. That is DNS rebinding, and hostname-only allowlisting
 * does not survive it.
 *
 * Every refusal returns a reason rather than throwing, because a blocked
 * attempt is recorded like any other and the reason is what the operator reads.
 */
export async function sendReplay(options: SendOptions): Promise<SendOutcome> {
  const policy = resolveReplayUrl(options.baseUrl, options.path, options.allowedHosts);
  if (!policy.ok) {
    return { ok: false, blocked: true, reason: policy.reason, message: policy.message };
  }

  const { url, host } = policy;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  // A literal address needs no lookup, and asking for one would fail.
  let address: string;
  let family: 4 | 6;
  const literal = isIP(host);
  if (literal !== 0) {
    address = host;
    family = literal === 4 ? 4 : 6;
  } else {
    try {
      const resolved = await dnsLookup(host);
      address = resolved.address;
      family = resolved.family === 6 ? 6 : 4;
    } catch (error) {
      return {
        ok: false,
        blocked: true,
        reason: "dns_failed",
        message: `Could not resolve ${host}: ${String(error)}`
      };
    }
  }

  // The allowlist is the perimeter; this is the floor beneath it. An allowed
  // name that resolves to the cloud metadata endpoint is still refused, because
  // no legitimate replay destination lives there and that is what a forgery is
  // usually aiming at.
  const verdict = checkAddress(address);
  if (!verdict.allowed) {
    return {
      ok: false,
      blocked: true,
      reason: "address_not_allowed",
      message: `${host} resolved to ${address}. ${verdict.reason ?? ""}`.trim()
    };
  }

  // The pin: the request goes to a URL whose host *is* the validated address,
  // so nothing resolves the name a second time. The original name travels in
  // the Host header and, for TLS, as the servername — a certificate is issued
  // for a hostname, not for the address that was dialled.
  const dialled = new URL(url.toString());
  dialled.hostname = family === 6 ? `[${address}]` : address;

  const agent = new Agent({
    connect: {
      ...(literal === 0 ? { servername: host } : {}),
      timeout: timeoutMs
    },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });

  const startedAt = Date.now();
  try {
    const response = await undiciRequest(dialled, {
      method: options.method,
      // The destination still sees the name it is configured for, so virtual
      // hosting and any name-based routing keep working.
      headers: { ...options.headers, host: url.host },
      body: JSON.stringify(options.payload ?? null),
      dispatcher: agent
      // Redirects are not followed. undici's default is not to, and no
      // `maxRedirections` is passed to change it — following one would repeat
      // the whole resolution problem at a destination nobody approved, so a 3xx
      // is recorded as the result.
    });

    const { body, truncated } = await readCapped(response.body, maxBytes);
    return {
      ok: true,
      status: response.statusCode,
      body,
      truncated,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      blocked: false,
      reason: "request_failed",
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  } finally {
    await agent.close();
  }
}

/**
 * Read a response body up to a cap.
 *
 * Stops consuming rather than buffering whatever the destination sends: a
 * debugging tool must not be a memory exhaustion vector for a misbehaving
 * development service.
 */
async function readCapped(
  stream: AsyncIterable<Buffer>,
  maxBytes: number
): Promise<{ body: unknown; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
      truncated = true;
      break;
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (truncated) return { body: { truncated: true, preview: text }, truncated };

  try {
    return { body: JSON.parse(text) as unknown, truncated };
  } catch {
    // Not JSON. Stored as text rather than discarded: a development endpoint
    // returning an HTML error page is exactly what the operator needs to see.
    return { body: text, truncated };
  }
}
