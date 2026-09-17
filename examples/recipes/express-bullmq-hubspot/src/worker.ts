import { Worker } from "bullmq";
import { contactIdOf, createContact, toHubSpotContact } from "./hubspot.js";
import { asLead, leadLabel } from "./lead.js";
import { connection, type LeadJob } from "./queue.js";
import { createAppRecorder } from "./recorder.js";

const recorder = createAppRecorder("leads-worker");

const worker = new Worker<LeadJob>(
  "leads",
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
  { connection }
);

// The last attempt failed: record the terminal failure once.
worker.on("failed", (job, error) => {
  if (job === undefined || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const { context, data } = recorder.extractPayload(job.data);
  const journey = recorder.continueJourney({
    context,
    entity: { type: "lead", id: asLead(data)?.id ?? "unknown" }
  });
  journey.fail("give-up-hubspot-sync", error, { metadata: { attempts: job.attemptsMade } });
});

process.once("SIGTERM", () => {
  void (async () => {
    await worker.close();
    const counters = await recorder.shutdown();
    console.log("flight recorder", counters);
    process.exit(0);
  })();
});
