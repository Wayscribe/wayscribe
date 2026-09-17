# Express, BullMQ and HubSpot

A form provider posts a lead to an Express webhook. The webhook normalizes it
and queues a BullMQ job; a worker creates the contact in HubSpot and retries
when HubSpot refuses. Leadline, a separate dogfood project outside this
repository, is being built as a working version of this stack.

The complete code, which this repository type-checks against the SDK, is in
[`examples/recipes/express-bullmq-hubspot`](../../examples/recipes/express-bullmq-hubspot).

## What to instrument, and where

| Step | Where | Call | Operation recorded |
| --- | --- | --- | --- |
| The webhook arrives | Express route | `startJourney`, then `record` | `received` |
| Body becomes a lead | Express route | `transform` | `transformed`, with the diff |
| A malformed lead is refused | Express route | `fail` | `failed` |
| The job is queued | Express route | `publish`, with `injectPayload` | `published` |
| The worker picks it up | BullMQ processor | `extractPayload`, `continueJourney`, `record` | `consumed` |
| Lead becomes a HubSpot contact | BullMQ processor | `transform` | `transformed` |
| HubSpot is called | BullMQ processor | `deliver`, with `attempt` | `delivered`, or `retried` from the second attempt |
| HubSpot's id is known | BullMQ processor | `identify` | `identified` |
| The job is done | BullMQ processor | `finish` | `completed` |
| The last attempt failed | `failed` listener | `fail` | `failed` |

The entity is the form provider's lead id, because that is what someone will
paste into search. HubSpot's contact id becomes an alias, so a search for it
finds the same journey.

## The recorder

One per process; the web process and the worker name themselves differently.
Leads carry personal data, so `email` and `phone` are redacted wherever they
appear, in the webhook body, the lead, and the HubSpot contact alike.

```typescript
export function createAppRecorder(serviceName: string): Recorder {
  return createRecorder({
    endpoint: process.env.FLIGHT_RECORDER_URL ?? "http://localhost:8080",
    apiKey: process.env.FLIGHT_RECORDER_API_KEY ?? "",
    serviceName,
    // Must be the environment the API key was issued for.
    environment: process.env.FLIGHT_RECORDER_ENVIRONMENT ?? "development",
    // Leads carry personal data. Keep the fields, replace their values.
    redact: ["**.email", "**.phone"],
    // Prints `delivered_first`, or why nothing arrives. Off once it sends.
    logDiagnostics: process.env.NODE_ENV !== "production"
  });
}
```

If `FLIGHT_RECORDER_API_KEY` is unset, `?? ""` gives the SDK an empty key, which
it reports like a missing one: `configuration_error: apiKey is empty`, printed
once per process even with `logDiagnostics` off, then
`rejected: Ingestion responded 401.`
([Troubleshooting](../TROUBLESHOOTING.md#3-did-the-sdk-reach-the-api)).

## The webhook

A BullMQ job has no headers, so the journey travels in an envelope around the
job's data: `injectPayload` on the way in, `extractPayload` in the worker. Both
are **experimental**, as is `label`: the envelope's key carries the product's
current name, which will change.

```typescript
app.post("/webhooks/leads", async (request, response) => {
  const leadId = leadIdOf(request.body);
  if (leadId === undefined) {
    response.status(400).json({ error: "leadId is required" });
    return;
  }

  // The entity is what someone will search for: the form provider's lead id.
  const journey = recorder.startJourney({ entity: { type: "lead", id: leadId } });
  journey.record({ operation: "received", name: "receive-lead-webhook", input: request.body });

  let lead: Lead;
  try {
    // Records the body going in and the lead coming out, and the diff between.
    lead = journey.transform("normalize-lead", request.body, () => parseLead(request.body));
  } catch (error) {
    journey.fail("reject-malformed-lead", error);
    response.status(422).json({ error: "malformed lead" });
    return;
  }

  // Experimental. Public text only: it is stored and shown unredacted.
  journey.label(leadLabel(lead));

  // Experimental: injectPayload puts the journey beside the lead in the job.
  const job = await journey.publish(
    "enqueue-hubspot-sync",
    lead,
    () =>
      leads.add("sync-lead", recorder.injectPayload(lead, journey.context()), {
        attempts: 5,
        backoff: { type: "exponential", delay: 1_000 }
      }),
    { captureOutput: (added) => ({ jobId: added.id }) }
  );

  response.status(202).json({ jobId: job.id });
});
```

`transform` wraps a synchronous parser and stays synchronous, so the `try`
catches its error as it would without the wrapper. The label is built from the
company and the form's name; never put a person's name or email address in a
label, which is stored and shown in plain text. `captureOutput` records the job
id rather than the whole BullMQ job object.

## The worker

```typescript
  async (job) => {
    // Experimental: extractPayload also reads a job enqueued before the
    // envelope existed, as `data` with no context.
    const { context, data } = recorder.extractPayload(job.data);
    const lead = asLead(data);
    if (lead === undefined) throw new Error(`job ${job.id ?? ""} does not hold a lead`);

    // The entity id does not cross the queue by default; the job carries it.
    const journey = recorder.continueJourney({
      context,
      entity: { type: "lead", id: lead.id },
      label: leadLabel(lead)
    });
    const attempt = job.attemptsMade + 1;
    if (attempt === 1) {
      journey.record({
        operation: "consumed",
        name: "consume-sync-lead",
        metadata: { jobId: job.id }
      });
    }

    const contact = journey.transform("map-lead-to-contact", lead, () => toHubSpotContact(lead));

    // `attempt` above 1 records `retried`. A 4xx or 5xx does not throw, so
    // isFailure says it failed.
    const result = await journey.deliver(
      "create-hubspot-contact",
      contact,
      () => createContact(contact),
      {
        attempt,
        isFailure: (answer) => answer.status >= 400
      }
    );
    if (result.status >= 400) {
      // BullMQ retries on a throw; the recorded attempt already shows why.
      throw new Error(`HubSpot answered ${String(result.status)}`);
    }

    // Aliases make the journey findable by HubSpot's id too. Masked when read.
    const contactId = contactIdOf(result);
    if (contactId !== undefined) journey.identify({ hubspotContactId: contactId });
    journey.finish();
  },
```

`createContact` returns HubSpot's status and body rather than throwing, which is
why `isFailure` is there: a 409 or a 429 is a failed attempt the timeline should
show as one. The HubSpot token is in a request header that is never passed to
the recorder.

A job that runs out of attempts is a terminal failure, recorded once:

```typescript
worker.on("failed", (job, error) => {
  if (job === undefined || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const { context, data } = recorder.extractPayload(job.data);
  const journey = recorder.continueJourney({
    context,
    entity: { type: "lead", id: asLead(data)?.id ?? "unknown" }
  });
  journey.fail("give-up-hubspot-sync", error, { metadata: { attempts: job.attemptsMade } });
});
```

## Shutting down

Call `recorder.shutdown()` after the worker has closed, or the last batch never
leaves. It resolves with the counters, which are worth logging:

```typescript
process.once("SIGTERM", () => {
  void (async () => {
    await worker.close();
    const counters = await recorder.shutdown();
    console.log("flight recorder", counters);
    process.exit(0);
  })();
});
```

The web process also serves `recorder.counters()` at `/internal/recorder`; keep
a route like that off the public internet.

## What you will see

Search for a lead id. The timeline shows the webhook, the normalization with
its diff (the renamed fields; `email` is kept as a field and stored as
`[REDACTED]` on both sides), the job, then each HubSpot attempt: `delivered`
for the first and `retried` for the rest, each with HubSpot's status and body as
its output. An attempt `isFailure` marked carries the error
`create-hubspot-contact reported a failed result.` with code `result_failed`.
The last step is `completed`, or `failed` if the job gave up.
