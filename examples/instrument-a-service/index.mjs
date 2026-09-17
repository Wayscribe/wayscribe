import { createRecorder } from "@wayscribe/node";

const ENDPOINT = process.env.WAYSCRIBE_URL ?? "http://localhost:8080";
const WEB = process.env.WAYSCRIBE_WEB ?? "http://localhost:3000";
const API_KEY = process.env.WAYSCRIBE_API_KEY;

if (!API_KEY) {
  console.error("Set WAYSCRIBE_API_KEY. Issue one with:");
  console.error('  pnpm project:create local "Local"   (once)');
  console.error("  pnpm key:create local development my-service");
  process.exit(1);
}

// One recorder per process, created once at startup.
const recorder = createRecorder({
  endpoint: ENDPOINT,
  apiKey: API_KEY,
  serviceName: "example-service",
  environment: "development",
  // Unasked, the SDK prints only four warnings, each once per process (its
  // README, "It cannot break your application"). This opts in to the rest
  // while you are getting set up: a wrong key or port prints why, and the
  // first batch the server stores prints `delivered_first`. Turn it off once the service is
  // known to send, and use `onDiagnostic` to route failures to your own logger.
  logDiagnostics: true
});

// The record arriving from outside. Note `Phone`, capitalised.
const account = {
  Id: "ACCT-9001",
  Name: "Dana Whitfield",
  Phone: "+1 617 555 0148",
  Status__c: "Active"
};

/** The bug. It reads `Phone__c`, and what arrived is `Phone`. */
function toCustomer(source) {
  return {
    externalId: source.Id,
    name: source.Name,
    phone: source.Phone__c ?? null,
    status: source.Status__c.toLowerCase()
  };
}

async function saveCustomer(_customer) {
  await new Promise((resolve) => setTimeout(resolve, 15));
  return 4471;
}

async function sendToCrm(customer) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  // The downstream system rejects a customer with no phone number. It returns a
  // status rather than throwing, which is the common case and the reason
  // `isFailure` exists.
  return customer.phone === null
    ? { status: 422, body: { error: { code: "phone_required" } } }
    : { status: 201, body: { id: "crm_1" } };
}

async function main() {
  // A journey is one record's history. The entity is what you will search for.
  const journey = recorder.startJourney({
    entity: { type: "customer", id: account.Id }
  });

  journey.record({
    operation: "received",
    name: "receive-account-webhook",
    input: account
  });

  // Each wrapper runs your callback, returns its value unchanged, and records
  // what went in and what came out. The diff between those two is what makes
  // the lost phone number visible.
  const customer = await journey.transform("map-account-to-customer", account, () =>
    toCustomer(account)
  );

  const internalId = await journey.persist("save-customer", customer, () => saveCustomer(customer));

  // Aliases are the other identifiers this record answers to. Adding one here
  // means a colleague who only has the internal ID can still find this journey.
  journey.identify({ internalCustomerId: String(internalId) });

  const response = await journey.deliver(
    "send-customer-to-crm",
    customer,
    () => sendToCrm(customer),
    {
      isFailure: (result) => result.status >= 400
    }
  );

  journey.finish({ status: response.status >= 400 ? "failed" : "completed" });

  // Flush before the process exits, or the last events never leave.
  const counters = await recorder.shutdown();

  console.log(`\nRecorded ${counters.sent} events.\n`);
  console.log(`  ${WEB}/journeys/${journey.context().journeyId}\n`);
  console.log(`Or search for ${account.Id}, or for the alias ${internalId}.`);
  console.log("Open the map-account-to-customer step to see where the phone went.\n");

  if (counters.transportErrors > 0) {
    console.error("Some events failed to send. Is the API running, and is the key valid?");
  }
}

await main();
