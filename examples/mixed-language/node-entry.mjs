import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

const RESPONSE_LIMIT = 64 * 1024;
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

export async function readBoundedJsonResponse(response, workerName) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${workerName} returned no response body`);
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error(`${workerName} response exceeded 64 KiB`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${workerName} returned malformed JSON`);
  }
}

const refused = (counters) =>
  !counters || counters.rejected > 0 || counters.dropped > 0 || counters.sent !== counters.recorded;

export async function runNodeEntry({ apiUrl, apiKey, environment, pythonUrl, signal }) {
  const { createRecorder } = await import("@wayscribe/node");
  const recorder = createRecorder({
    endpoint: apiUrl,
    apiKey,
    serviceName: "mixed-node",
    environment,
    requestTimeoutMs: 2_000
  });
  const entity = { type: "customer", id: "customer-mixed-42" };
  const alias = "crm-mixed-9001";
  const journey = recorder.startJourney({ entity });
  let pythonResult;
  try {
    journey.record({
      operation: "received",
      name: "receive-customer",
      input: { source: "synthetic-local" }
    });
    journey.identify({ crmCustomerId: alias }, { displayableAliases: ["crmCustomerId"] });

    const headers = recorder.injectHttpHeaders(
      { "content-type": "application/json", traceparent: TRACEPARENT },
      journey.context()
    );
    if (headers.traceparent !== TRACEPARENT) {
      throw new Error("HTTP propagation did not preserve traceparent");
    }
    if (Object.keys(headers).some((name) => name.toLowerCase() === "x-wayscribe-entity-id")) {
      throw new Error("default HTTP propagation exposed the entity id");
    }

    const requestDeadline = new globalThis.AbortController();
    const requestTimer = setTimeout(
      () => requestDeadline.abort(new Error("Python worker request exceeded its deadline")),
      10_000
    );
    try {
      const response = await fetch(pythonUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          entity,
          payload: { email: " Mixed@Example.invalid ", password: "synthetic-secret" }
        }),
        redirect: "error",
        signal: signal
          ? globalThis.AbortSignal.any([signal, requestDeadline.signal])
          : requestDeadline.signal
      });
      pythonResult = await readBoundedJsonResponse(response, "Python worker");
      if (!response.ok) {
        throw new Error(
          `Python worker refused the request with HTTP ${response.status} ` +
            `(python ${pythonResult?.counters?.sent ?? 0}/${pythonResult?.counters?.recorded ?? 0})`
        );
      }
    } finally {
      clearTimeout(requestTimer);
    }
    if (
      pythonResult.journeyId !== journey.context().journeyId ||
      pythonResult.go?.journeyId !== journey.context().journeyId
    ) {
      throw new Error("a worker crossed the journey boundary");
    }
    if (
      pythonResult.traceparent !== TRACEPARENT ||
      pythonResult.httpEntityIdPresent !== false ||
      pythonResult.go?.payloadEntityIdPresent !== false
    ) {
      throw new Error("a worker changed the controlled carrier contract");
    }
  } finally {
    await recorder.shutdown({ timeoutMs: 5_000 });
  }

  const nodeCounters = recorder.counters();
  if (
    refused(nodeCounters) ||
    refused(pythonResult?.counters) ||
    refused(pythonResult?.go?.counters)
  ) {
    throw new Error(
      `one or more SDKs refused events (node ${nodeCounters.sent}/${nodeCounters.recorded}, ` +
        `python ${pythonResult?.counters?.sent ?? 0}/${pythonResult?.counters?.recorded ?? 0}, ` +
        `go ${pythonResult?.go?.counters?.sent ?? 0}/${pythonResult?.go?.counters?.recorded ?? 0})`
    );
  }

  return { journeyId: journey.context().journeyId, entity, alias };
}
