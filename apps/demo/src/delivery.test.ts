import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactResponse } from "./contacts.js";
import {
  deliveryFailure,
  isPermanentRejection,
  isTimeout,
  nextAction,
  postCustomer
} from "./delivery.js";
import {
  invalidStatus,
  PHONE_REQUIRED,
  RETRY_DELAY_SECONDS,
  SLOW_ACCOUNT_PREFIX,
  TARGET_SLOW_RESPONSE_MS
} from "./failures.js";

const phoneRequired = { status: 422, body: { error: PHONE_REQUIRED } };
const unmappedStatus = { status: 422, body: { error: invalidStatus("former customer") } };
const created = { status: 201, body: { id: "contact_0018Z00002ABC" } };

describe("the worker's delivery decision", () => {
  it("retries phone_required, the demo's defect, and records the SDK's generic failure", () => {
    expect(isPermanentRejection(phoneRequired)).toBe(false);
    expect(deliveryFailure(phoneRequired)).toBe(true);
    expect(nextAction({ kind: "result", result: phoneRequired }, 1)).toEqual({
      kind: "retry",
      visibilitySeconds: RETRY_DELAY_SECONDS,
      reason: "rejected"
    });
  });

  it("gives up at once on a permanent validation error, recording the target's reason", () => {
    expect(isPermanentRejection(unmappedStatus)).toBe(true);
    expect(deliveryFailure(unmappedStatus)).toEqual(unmappedStatus.body.error);
    expect(nextAction({ kind: "result", result: unmappedStatus }, 1)).toEqual({ kind: "delete" });
  });

  it("treats a 5xx as retryable whatever its code says", () => {
    const outage = { status: 503, body: { error: { code: "invalid_property_value" } } };
    expect(isPermanentRejection(outage)).toBe(false);
    expect(nextAction({ kind: "result", result: outage }, 2)).toMatchObject({ kind: "retry" });
  });

  it("deletes a delivered message and records no failure", () => {
    expect(deliveryFailure(created)).toBe(false);
    expect(nextAction({ kind: "result", result: created }, 1)).toEqual({ kind: "delete" });
  });

  it("backs off 4, 8 and 16 seconds after timeouts, and remembers why", () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTimeout(timeout)).toBe(true);
    expect(
      [1, 2, 3].map((attempt) => nextAction({ kind: "threw", error: timeout }, attempt))
    ).toEqual(
      [4, 8, 16].map((visibilitySeconds) => ({
        kind: "retry",
        visibilitySeconds,
        reason: "timeout"
      }))
    );
  });

  it("retries anything else thrown, such as a target not up yet, at the usual delay", () => {
    const refused = new TypeError("fetch failed");
    expect(isTimeout(refused)).toBe(false);
    expect(nextAction({ kind: "threw", error: refused }, 1)).toEqual({
      kind: "retry",
      visibilitySeconds: RETRY_DELAY_SECONDS,
      reason: "rejected"
    });
  });
});

describe("postCustomer against a slow target", () => {
  let server: Server;
  let url = "";

  beforeAll(async () => {
    // The target's own rule, with its delay kept: only the worker's timeout is
    // shortened, so the test proves the timeout fires before the answer.
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      request.on("end", () => {
        const answer = contactResponse(JSON.parse(raw));
        const timer = setTimeout(() => {
          response.writeHead(answer.status, { "content-type": "application/json" });
          response.end(JSON.stringify(answer.body));
        }, answer.delayMs);
        response.on("close", () => {
          clearTimeout(timer);
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const customer = (externalId: string): Record<string, unknown> => ({
    externalId,
    name: "Avery Chen",
    phone: "+1 415 555 0101",
    status: "active"
  });

  it("delivers an ordinary account", async () => {
    await expect(postCustomer(url, customer("001LPABC"), 1_000)).resolves.toEqual({
      status: 201,
      body: { id: "contact_001LPABC" }
    });
  });

  it("throws a TimeoutError for an account the target is slow for", async () => {
    expect(TARGET_SLOW_RESPONSE_MS).toBeGreaterThan(1_000);
    const error: unknown = await postCustomer(
      url,
      customer(`${SLOW_ACCOUNT_PREFIX}ABC`),
      200
    ).catch((thrown: unknown) => thrown);
    expect(isTimeout(error)).toBe(true);
    expect(nextAction({ kind: "threw", error }, 1)).toMatchObject({ reason: "timeout" });
  });
});
