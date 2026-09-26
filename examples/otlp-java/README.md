# A Java service emitting journey records

`invoice-sync` is a billing worker that moves invoice `inv-2044` into a ledger.
It uses the stable OpenTelemetry Java logs API and SDK (1.66.0) and the
OTLP/HTTP exporter, with no Wayscribe library. Each business step is one log
record carrying `wayscribe.*` attributes:

| Event | Operation | What it shows |
| --- | --- | --- |
| `evt_otlp_java_received` | `received` | the invoice as loaded, and a billing-system alias |
| `evt_otlp_java_transformed` | `transformed` | input and output, so Wayscribe computes a diff |
| `evt_otlp_java_delivery_1` | `delivered` | first ledger attempt fails: structured error, HTTP 503 in metadata |
| `evt_otlp_java_delivery_2` | `retried` | second attempt works, which clears the failure |
| `evt_otlp_java_completed` | `completed` | the journey finished |

It also writes one ordinary operational log line with no journey, the kind of
record every service produces alongside these.

Payloads are real OTLP map values built with `Value.of(KeyValue...)` and set
with `setAttribute(String, Value<?>)`, which the Java API stabilized in 1.59.0.
The invoice deliberately carries a card number and a gateway API token, to show
what has to be removed before records leave the host.

## Run it through the Collector (recommended)

[`../otlp-collector`](../otlp-collector/README.md) runs this service behind an
OpenTelemetry Collector that drops the operational line, keeps only mapped
attributes, deletes the token, masks the card number and holds the API key. The
service itself sends no credentials.

## Run it straight at Wayscribe

Java 17 or later and Maven, or Docker. With Docker:

```sh
docker build -t invoice-sync .
docker run --rm --add-host host.docker.internal:host-gateway \
  -e OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://host.docker.internal:8080/v1/logs \
  -e WAYSCRIBE_API_KEY='<environment API key>' \
  invoice-sync
```

With a local JDK: `mvn -q package`, then
`java -cp 'target/invoice-sync-1.0.0.jar:target/lib/*' dev.wayscribe.examples.InvoiceSync`
with the same two variables.

Sent directly, the five journey records are stored and the operational line is
refused with `missing_attribute`. The HTTP answer is still 200, with a
`partialSuccess` count; the Java exporter does not print it, and the API logs
`OTLP log records rejected` with the refusal code.

Nothing on this path removes the token or the card number. Both cross the
network, and both are stored as sent: Wayscribe's arrival redaction matches
configured field names such as `password` or `apiKey` (case and separators
ignored), not names that merely contain one, so `gatewayApiToken` and
`cardNumber` pass. That is the reason to put the Collector in front. (An
environment's redaction paths can name them too, see
[SECURITY.md](../../docs/SECURITY.md), but only after they crossed the
network.)

Check the result:

```sh
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  http://127.0.0.1:8080/v1/journeys/jrn_otlp_java_inv_2044
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  'http://127.0.0.1:8080/v1/search?q=BIL-88213'
```

Expect a `completed` journey of five events from `invoice-sync`, version
`3.4.0`.

## Notes for a real service

- The event IDs and timestamps here are fixed so a second run proves
  idempotency. A real service stores each event's ID and timestamp with its work
  and resends both, and every annotation, unchanged on a retry. A changed event
  under an existing ID is refused with `event_id_conflict`.
- Keep the batch processor's maximum export size at 100 or less; Wayscribe
  refuses larger exports.
- Severity is ignored. The `delivered` record is a failed attempt because it
  carries `wayscribe.error`, not because it is logged at WARN.
