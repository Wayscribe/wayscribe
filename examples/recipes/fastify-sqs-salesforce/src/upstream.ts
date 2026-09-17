import type { Customer } from "./customer.js";
import { createAppRecorder } from "./recorder.js";

// The service that calls POST /customers, if it records too.
const recorder = createAppRecorder("signup-service");

export async function sendCustomer(customer: Customer): Promise<Response> {
  const journey = recorder.startJourney({ entity: { type: "customer", id: customer.externalId } });
  return journey.deliver(
    "send-customer-to-api",
    customer,
    () =>
      fetch(`${process.env.CUSTOMERS_API_URL ?? ""}/customers`, {
        method: "POST",
        // Experimental: the journey goes out in headers, and the API continues it.
        headers: recorder.injectHttpHeaders(
          { "content-type": "application/json" },
          journey.context()
        ),
        body: JSON.stringify(customer)
      }),
    {
      isFailure: (response) => !response.ok,
      // A Response has nothing worth storing; its status does.
      captureOutput: (response) => ({ status: response.status })
    }
  );
}
