# Glossary

## Alias

An alternate identifier for the same logical entity.

Example: Salesforce account ID, internal customer ID, and HubSpot contact ID.

## Capture mode

The environment policy controlling whether Wayscribe stores metadata only, allowlisted fields, redacted payloads, or full payloads.

## Correlation

The process of determining which events belong to the same journey.

V0 uses deterministic journey IDs and explicit aliases.

## Entity

The business object being investigated, such as a customer, order, invoice, claim, document, or payment.

## Event

One immutable recorded action in a journey.

Examples: received, transformed, persisted, published, consumed, delivered, failed, or retried.

## Event ID

A client-generated unique identifier used for ingestion idempotency.

## Wayscribe

The product as a whole.

## Journey

The complete recorded history of one logical entity or workflow instance across services, traces, queues, retries, and systems.

## Journey context

The minimal information propagated across process boundaries to continue a journey.

## Journey ID

The stable identifier joining all events in a journey.

## Operation

A stable semantic category describing what an event represents.

## Payload diff

A deterministic structural comparison between event input and output.

## Replay

A developer-initiated request that sends historical input to an approved non-production endpoint for testing.

## Replay destination

A configured local, development, or test endpoint eligible to receive replay requests.

## SDK

The application library that records events, propagates journey context, applies client redaction, and sends event batches.

## Technical identifier

An identifier used by infrastructure rather than the business domain, such as trace ID, span ID, message ID, or correlation ID.

## Trace

A request-oriented collection of spans, commonly produced by OpenTelemetry.

A single journey may contain many traces.

## Transformation

A processing step that intentionally changes the shape or values of data.

## V0

The first tightly scoped implementation described by the product specification.

## BYOK

Bring your own key. A possible future model in which users configure their own AI provider credentials. It is not part of V0.
