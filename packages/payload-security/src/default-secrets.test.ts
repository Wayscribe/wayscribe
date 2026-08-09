import { describe, expect, it } from "vitest";
import { DEFAULT_SECRET_PATHS } from "./default-secrets.js";
import { redact } from "./redact.js";

/**
 * The built-in list against the shapes it will actually meet.
 *
 * The unit tests for the matcher passed throughout, because they asked whether
 * a configured rule matches a payload built to fit it. The question that
 * mattered was the reverse: whether the shipped list reaches the places real
 * secrets sit. It did not. `authorization` matched depth one and
 * `*.authorization` matched depth two, and everything deeper — every array
 * element, every wrapped request — was stored in the clear.
 *
 * Each payload below is a shape from a real library, not one invented to fail.
 */
const store = (value: unknown): string => JSON.stringify(redact(value, DEFAULT_SECRET_PATHS));

describe("the built-in list reaches real payloads", () => {
  it("catches an axios error's request config", () => {
    // error.config.headers.authorization — depth three, and the single most
    // common way a live key reaches a captured payload.
    const failure = {
      message: "Request failed with status code 401",
      config: {
        url: "https://api.stripe.com/v1/charges",
        headers: { authorization: "Bearer sk_live_x", "content-type": "application/json" }
      }
    };
    const stored = store(failure);
    expect(stored).not.toContain("sk_live_x");
    expect(stored).toContain("[REDACTED]");
    // The surrounding context is what makes the event worth keeping.
    expect(stored).toContain("api.stripe.com");
    expect(stored).toContain("401");
  });

  it("catches a password inside a wrapped request body", () => {
    const stored = store({ request: { body: { user: { password: "hunter2" } } } });
    expect(stored).not.toContain("hunter2");
  });

  it("catches secrets inside array elements", () => {
    // An array was a hard stop: without a configured `x[*]` path its elements
    // were walked with no rules at all.
    const stored = store({ batch: [{ api_key: "ak_1" }, { api_key: "ak_2" }] });
    expect(stored).not.toContain("ak_1");
    expect(stored).not.toContain("ak_2");
  });

  it("catches a cookie on a nested inbound request", () => {
    const stored = store({ http: { req: { headers: { cookie: "session=abc123" } } } });
    expect(stored).not.toContain("abc123");
  });

  it("catches every name on the list at depth", () => {
    // Each entry, exercised at a depth the old list could not reach, so one
    // name silently losing its rule cannot pass unnoticed.
    for (const path of DEFAULT_SECRET_PATHS) {
      const name = path.replace(/^\*\*\./, "");
      const stored = store({ outer: { inner: { [name]: "LEAKED-VALUE" } } });
      expect(stored, `${path} did not reach depth three`).not.toContain("LEAKED-VALUE");
    }
  });

  it("leaves ordinary business data alone", () => {
    // The control. A list that redacted everything would pass every test above
    // and make the tool useless.
    const payload = {
      customer: { name: "Jorge Polanco", email: "jorge@example.test", phone: "+1 919 555 1234" },
      order: { total: 4210, currency: "USD", items: [{ sku: "A-1", quantity: 2 }] }
    };
    expect(JSON.parse(store(payload))).toEqual(payload);
  });
});
