# An OpenTelemetry Collector in front of Wayscribe

The OpenTelemetry logging SDKs do not redact anything: every attribute leaves
the process as the code wrote it. If raw values must not leave the host, put a
Collector between your services and Wayscribe's `POST /v1/logs`.
[`collector.yaml`](collector.yaml) does four things, in this order:

1. **`filter/journey-records-only`** drops every record without
   `wayscribe.journey.id`. Ordinary application logs never reach Wayscribe
   instead of being refused there with `missing_attribute`.
2. **`redaction/mapped-attributes-only`** is the
   [redaction processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/redactionprocessor)
   used as an allowlist: only the attributes Wayscribe maps survive. It applies
   the list to resource attributes as well, so `service.name`,
   `service.version` and `deployment.environment.name` are on it. Leave
   `service.name` off and every record is refused.
3. **`transform/scrub-payloads`** deletes secret-named fields (password, token,
   API key and the like) from `wayscribe.input` and `wayscribe.output`, and
   masks anything shaped like a card number as `****`. The redaction processor
   cannot do this part: it matches top-level attribute keys and values only and
   does not look inside map values, which is where payloads live. The
   statements reach the first level of each payload map; name deeper paths if
   your payloads nest sensitive fields.
4. **`batch`** keeps exports at 100 records, Wayscribe's limit.

The exporter adds the environment API key, so services send without
credentials, and retries a `503` with the identical export.

Every processor is deterministic. That matters for records without an explicit
`wayscribe.event.id` or `log.record.uid`: their ID is derived from their
content, so a processor that stamped a changing value (a timestamp, a counter,
the redaction processor's non-silent summary) would turn a retry into a second
event.

## Run it with the Java example

Start Wayscribe with `OTLP_LOGS_ENABLED=true` (the stack in `infrastructure/`
reads it from the repository's `.env`) and create an environment API key. Then,
from this directory:

```sh
export WAYSCRIBE_API_KEY='<environment API key>'
# Only if the API is not on port 8080 of this host:
# export WAYSCRIBE_LOGS_ENDPOINT=http://host.docker.internal:18080/v1/logs

docker compose up -d collector
docker compose run --rm invoice-sync
```

The service prints `invoice-sync flushed 6 records (5 journey, 1 operational)`.
The Collector forwards five. Check them:

```sh
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  http://127.0.0.1:8080/v1/journeys/jrn_otlp_java_inv_2044
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  http://127.0.0.1:8080/v1/events/evt_otlp_java_transformed
```

Expect a `completed` journey of five events from `invoice-sync`. The transform
event's input has `"cardNumber": "****"` and no `gatewayApiToken`: both were
removed on this host, before the network. Run the service again and the event
count stays at five.

If the Collector's log shows `Partial success response` with
`missing_attribute`, a required attribute did not survive the pipeline; the
usual cause is an allowlist missing `service.name`. To see exactly what leaves
the host, add the `debug` exporter (`verbosity: detailed`) to the pipeline's
exporters while testing.

Stop it with `docker compose down`.

## Adapting it

- Point `WAYSCRIBE_LOGS_ENDPOINT` at your Wayscribe API's `/v1/logs` and use
  TLS when the Collector and Wayscribe are on different hosts.
- Extend the allowlist only with `wayscribe.*` attributes you use; everything
  else is ignored by Wayscribe anyway.
- Add your own patterns to the `replace_all_patterns` statements for other
  values that must not leave the host.

The configuration is checked in CI with `otelcol-contrib validate` on the
release `compose.yaml` pins (0.161.0), which parses every processor statement.
