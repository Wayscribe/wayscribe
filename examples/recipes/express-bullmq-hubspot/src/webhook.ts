import express from "express";
import { type Lead, leadIdOf, leadLabel, parseLead } from "./lead.js";
import { leads } from "./queue.js";
import { createAppRecorder } from "./recorder.js";

const recorder = createAppRecorder("leads-api");
const app = express();
app.use(express.json());

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

// For an operator: what the recorder has counted since the process started.
app.get("/internal/recorder", (_request, response) => {
  response.json(recorder.counters());
});

const server = app.listen(3000);

process.once("SIGTERM", () => {
  server.close();
  void recorder.shutdown().then(() => process.exit(0));
});
