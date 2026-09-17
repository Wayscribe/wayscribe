# Alternatives

**Last checked: 16 September 2026.**

This page backs the claim in the README's
[Alternatives](../README.md#alternatives) section:

> As of September 2026, I have not found an open-source tool that does all four
> for services you already run: (1) follow one record by its business id and
> aliases across services; (2) capture what each step received and produced and
> show the field that changed; (3) replay a recorded input against development;
> (4) with no platform to move onto.

Each tool below does part of that job, and some do their part better than
Wayscribe does. Every statement about a tool is taken from that tool's own
documentation, licence file or pricing page, and each source carries the date
it was checked. Statements that could not be confirmed from such a source were
left out. Where this page says a tool's documentation does not describe
something, that is a statement about the documentation on the date checked, not
a proof that the capability is absent.

"Open source" here means a licence approved by the
[Open Source Initiative](https://opensource.org/licenses) (checked 2026-09-16).

## Summary

| Tool | Licence | OSI open source | Overlap | What it lacks for this job |
| --- | --- | --- | --- | --- |
| Apache NiFi (provenance) | Apache-2.0 | Yes | Search one piece of data, see its attributes and content at each step, replay it | Covers only data moving through a NiFi dataflow |
| Temporal | MIT | Yes | Per-execution history with each activity's input and result; search by workflow id and custom attributes | Covers only code written as Temporal Workflows and Activities |
| Jaeger | Apache-2.0 | Yes | Find traces by span and resource attributes | No documented capture of step payloads, field diff or replay |
| Grafana Tempo | AGPL-3.0 | Yes | Find traces by span and resource attributes with TraceQL | No documented capture of step payloads, field diff or replay |
| Svix server | MIT | Yes | Sends webhooks with retries and a retry schedule | Covers outbound webhook delivery, not a record's path through your services |
| PaperTrail | MIT | Yes | Before and after values for each changed attribute of a model | One Rails application's ActiveRecord models, not a cross-service journey |
| django-simple-history | BSD-3-Clause | Yes | Model state on every change, with diffs between versions | One Django application's models, not a cross-service journey |
| Keploy | Apache-2.0 | Yes | Records requests and dependency calls, replays them as tests | Builds regression tests for one application; no search by business id across services |
| Kubeshark | Apache-2.0 (repository) | Yes (repository) | Captures API traffic across a cluster | Kubernetes only; free plan limited to 3 nodes or 60 pods |
| OpenLineage | Apache-2.0 | Yes | Lineage standard for jobs, runs and datasets | Its model has no entity for one record |
| Convoy | Elastic License 2.0 | No (source-available) | Webhook gateway, sending and receiving, with deliveries and retries | Not OSI open source; webhook traffic only |
| Bemi | Server Side Public License | No (source-available) | PostgreSQL change tracking with application context | Not OSI open source; database changes only |
| n8n | Sustainable Use License | No (source-available) | Past executions, filtering by custom data, re-running with earlier data | Not OSI open source; covers workflows built in n8n |

Commercial tools do this job for teams on their platforms, which shows teams
pay for it: [Nodinite](#nodinite), [Turbo360 BAM](#turbo360-business-activity-monitoring),
[Particular ServicePulse](#particular-servicepulse) and
[Dynatrace Business Flow](#dynatrace-business-flow).

## Open-source neighbours

### Apache NiFi provenance

- **What it is:** a dataflow system. Its data provenance records events for
  each FlowFile, NiFi's name for "a single piece of data".
- **Licence:** Apache-2.0, OSI open source.
- **Overlap:** the Data Provenance page searches for a FlowFile "to determine
  what happened to it", by identifier or other characteristics. An event's
  details show the FlowFile's attributes at that point, with an "Only show
  modified" option, and its content can be downloaded as it was at that point.
  A FlowFile can be replayed from a provenance event.
- **What it lacks for this job:** provenance covers FlowFiles in a NiFi
  dataflow, so the services have to run as that dataflow. A replayed FlowFile
  is sent back into the same flow, to the connection feeding the component that
  produced the event, rather than to a separate development destination. The
  change view is for attributes; the documentation does not describe a
  field-level comparison of content.
- **Sources:**
  [NiFi User Guide, Data Provenance, Searching for Events, Details of an Event, Replaying a FlowFile](https://nifi.apache.org/docs/nifi-docs/html/user-guide.html#data_provenance)
  (checked 2026-09-16);
  [licence, apache/nifi](https://github.com/apache/nifi/blob/main/LICENSE)
  (checked 2026-09-16).

### Workflow engines, for example Temporal

- **What it is:** a durable execution platform. A Workflow Execution is
  identified by its namespace, a Workflow Id chosen by the caller, and a Run Id.
- **Licence:** MIT, OSI open source.
- **Overlap:** each execution's Event History records an `ActivityTaskScheduled`
  event with the activity's `input` and an `ActivityTaskCompleted` event with
  its `result`. Visibility lists and filters executions with a SQL-like List
  Filter and custom Search Attributes.
- **What it lacks for this job:** the history exists because the work is
  written as Temporal Workflows and Activities with a Temporal SDK. Services
  that already exist have to move onto that model to get it. The documentation
  does not describe a field-level diff between an activity's input and result.
- **Sources:**
  [Workflow Execution](https://docs.temporal.io/workflow-execution),
  [Events reference](https://docs.temporal.io/references/events),
  [Visibility](https://docs.temporal.io/visibility) (all checked 2026-09-16);
  [licence, temporalio/temporal](https://github.com/temporalio/temporal/blob/main/LICENSE)
  (checked 2026-09-16).

### Tracing backends: Jaeger and Grafana Tempo

- **What they are:** distributed tracing backends that store spans.
- **Licences:** Jaeger is Apache-2.0; Tempo is AGPL-3.0. Both are OSI open
  source.
- **Overlap:** both find traces by attribute. Jaeger's query API takes an
  `attributes` map that is "matched against span and resource attributes".
  Tempo's TraceQL selects spans by attribute, for example
  `{ resource.service.name = "frontend" }`. Put an order id on your spans and
  you can find that order's traces, which is most of what "search a record"
  means.
- **What they lack for this job:** a span carries the attributes you set on it.
  Neither project's documentation describes capturing the payload a step
  received and produced, comparing the two field by field, or replaying a
  recorded input. Wayscribe reads the active trace and span ids onto its
  events so the two can be used together.
- **Sources:**
  [Jaeger query service definition, `TraceQueryParameters`](https://github.com/jaegertracing/jaeger-idl/blob/main/proto/api_v3/query_service.proto),
  [Tempo, construct a TraceQL query](https://grafana.com/docs/tempo/latest/traceql/construct-traceql-queries/)
  (both checked 2026-09-16);
  [licence, jaegertracing/jaeger](https://github.com/jaegertracing/jaeger/blob/main/LICENSE),
  [licence, grafana/tempo](https://github.com/grafana/tempo/blob/main/LICENSE)
  (both checked 2026-09-16).

### Webhook servers, for example Svix

- **What it is:** a self-hostable server for sending webhooks. "Developers make
  one API call, and Svix takes care of deliverability, retries, security, and
  more."
- **Licence:** MIT, OSI open source.
- **Overlap:** each message is attempted on a documented retry schedule, which
  answers "did this webhook reach the endpoint?".
- **What it lacks for this job:** it covers delivering webhooks out of your
  system. It does not follow a record through the services that handled it
  before or after, and its documentation does not describe a field diff.
- **Sources:**
  [svix/svix-webhooks README](https://github.com/svix/svix-webhooks),
  [Retry schedule](https://docs.svix.com/retries) (both checked 2026-09-16).

### Model-history libraries: PaperTrail and django-simple-history

- **What they are:** libraries that version the rows of one application's
  models. PaperTrail is for Rails ActiveRecord models; django-simple-history
  "stores Django model state on every create/update/delete".
- **Licences:** PaperTrail is MIT; django-simple-history is BSD-3-Clause
  (now maintained under django-commons). Both are OSI open source.
- **Overlap:** they record what changed on a record. PaperTrail's optional
  `object_changes` column stores each changed attribute as a before and after
  pair; django-simple-history's `diff_against()` compares two historical
  versions.
- **What they lack for this job:** they record changes to one application's
  database models. They do not see the webhook, queue message or third-party
  call where a value was lost on the way in or out, or follow the record into
  another service.
- **Sources:**
  [PaperTrail README](https://github.com/paper-trail-gem/paper_trail),
  [django-simple-history documentation](https://django-simple-history.readthedocs.io/en/latest/)
  (both checked 2026-09-16);
  [licence, paper-trail-gem/paper_trail](https://github.com/paper-trail-gem/paper_trail/blob/master/LICENSE),
  [licence, django-commons/django-simple-history](https://github.com/django-commons/django-simple-history/blob/master/LICENSE.txt)
  (both checked 2026-09-16).

### Traffic capture and replay: Keploy and Kubeshark

- **What they are:** Keploy "captures every incoming HTTP request and outgoing
  dependency call" and saves them as test cases. Kubeshark captures API
  traffic across a Kubernetes cluster using eBPF.
- **Licences:** both repositories are Apache-2.0, OSI open source. Kubeshark
  also sells Pro and Enterprise plans; its free Community plan is limited to
  "Up to 3 nodes or 60 pods".
- **Overlap:** Keploy replays the recorded requests "in a sandboxed
  environment", with dependencies virtualised and responses compared, which is
  close to Wayscribe's development replay. Kubeshark shows the requests
  and responses that crossed the cluster.
- **What they lack for this job:** Keploy turns traffic into regression tests
  for an application; its documentation does not describe finding one business
  record's history across services. Kubeshark is Kubernetes only, and works at
  the level of network traffic rather than a record and its aliases.
- **Sources:**
  [How Keploy works](https://keploy.io/docs/keploy-explained/how-keploy-works/),
  [Kubeshark introduction](https://docs.kubeshark.com/en/introduction),
  [Kubeshark pricing](https://kubeshark.com/pricing) (all checked 2026-09-16);
  [licence, keploy/keploy](https://github.com/keploy/keploy/blob/main/LICENSE),
  [licence, kubeshark/kubeshark](https://github.com/kubeshark/kubeshark/blob/master/LICENSE)
  (both checked 2026-09-16).
- **Left out:** Kubeshark's TCP and UDP stream replay is described on a page
  at `docs.kubeshark.co`, which did not resolve on 2026-09-16, so this page
  does not rely on it.

### Lineage standards: OpenLineage

- **What it is:** "an open framework for data lineage collection and analysis",
  with a model of dataset, job and run entities.
- **Licence:** Apache-2.0, OSI open source.
- **Overlap:** it answers where data came from and which job produced it.
- **What it lacks for this job:** its entities are datasets, jobs and runs. One
  customer record is not an entity in the model, and payload capture, field
  diffs and replay are outside its scope.
- **Sources:**
  [OpenLineage documentation](https://openlineage.io/docs/) (checked
  2026-09-16);
  [licence, OpenLineage/OpenLineage](https://github.com/OpenLineage/OpenLineage/blob/main/LICENSE)
  (checked 2026-09-16).

## Source-available, not OSI open source

These are close to parts of this job and are often described as open source.
Their licences are not on the OSI list, so they do not count against the claim.

### Convoy

- **What it is:** a webhooks gateway "supporting both sending & receiving
  webhooks", with retries, rate limiting and circuit breaking. Events and their
  deliveries can be listed, and a delivery can be retried.
- **Licence:** Elastic License 2.0. The project calls its Community Edition
  open source; the licence is not OSI approved. A paid Premium licence adds
  features.
- **What it lacks for this job:** it covers webhook traffic, not the transform,
  database, queue and worker steps around it.
- **Sources:**
  [Introduction](https://getconvoy.io/docs/home/introduction),
  [Events and event deliveries](https://getconvoy.io/docs/product-manual/events-and-event-deliveries),
  [Licensing](https://getconvoy.io/docs/business-and-enterprise/licensing)
  (all checked 2026-09-16);
  [licence, frain-dev/convoy](https://github.com/frain-dev/convoy/blob/main/LICENSE)
  (checked 2026-09-16).

### Bemi

- **What it is:** "an open-source solution that plugs into PostgreSQL and ORMs
  to track database changes automatically", adding application context to each
  change.
- **Licence:** the repository's licence file is the Server Side Public License,
  version 1, which is not OSI approved, although the documentation calls Bemi
  open source.
- **What it lacks for this job:** it records database changes, so the steps that
  never write to that database are outside it.
- **Sources:**
  [Bemi documentation](https://docs.bemi.io/) (checked 2026-09-16);
  [licence, BemiHQ/bemi-io](https://github.com/BemiHQ/bemi-io/blob/main/LICENSE)
  (checked 2026-09-16).

### n8n

- **What it is:** a workflow automation platform. Custom data can be recorded
  with each execution and used to filter the executions list, and a past
  execution's data can be loaded into the editor to debug and re-run it.
- **Licence:** the Sustainable Use License, with `.ee.` files under the n8n
  Enterprise License. n8n describes both as "based on the fair-code model"; they
  are not OSI approved. Custom execution data is available on some plans only.
- **What it lacks for this job:** it covers workflows built in n8n.
- **Sources:**
  [Sustainable Use License](https://docs.n8n.io/n8n-community-license/sustainable-use-license),
  [Customize executions data](https://docs.n8n.io/build/understand-workflows/understand-executions/customize-executions-data),
  [Debug executions](https://docs.n8n.io/build/understand-workflows/understand-executions/debug-executions)
  (all checked 2026-09-16).

## Commercial tools

These show that teams pay to answer "what happened to this record". Each is tied
to a vendor, a platform or both.

### Nodinite

- Integration logging and monitoring, sold by subscription. The price page
  listed Nodinite Core at 12,517 SEK a month and the BPM add-on at 5,000 SEK a
  month (tier 1 prices).
- **Source:** [Nodinite pricing](https://www.nodinite.com/price/) (checked
  2026-09-16).

### Turbo360 Business Activity Monitoring

- End-to-end tracking of transactions across Azure integration services, where
  a user can find a transaction by order number, customer or another business
  property. Azure focused, with pricing from $249 a month.
- **Source:**
  [Turbo360 BAM](https://turbo360.com/business-activity-monitoring) (checked
  2026-09-16).

### Particular ServicePulse

- Monitoring and failed-message retry for NServiceBus systems, part of the
  Particular Service Platform, which is "Free for development, only pay for
  production".
- **Sources:** [ServicePulse](https://docs.particular.net/servicepulse/),
  [Particular pricing](https://particular.net/pricing) (both checked
  2026-09-16).

### Dynatrace Business Flow

- Monitors business process flows in the Dynatrace platform, connecting the
  steps through "a unique identifier (correlation ID) that is common to all
  process steps".
- **Source:**
  [Business Flow](https://docs.dynatrace.com/docs/observe/business-observability/business-flow)
  (checked 2026-09-16).

## How to correct this page

If a tool here does something this page says it does not, or a tool that does
all four is missing, [open an issue](https://gitlab.com/jojithedev/wayscribe/-/issues)
with a link to that tool's documentation. The README claim and this page are
changed together, and both carry the date they were last checked.
