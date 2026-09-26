# OTLP JSON with curl

[`export.json`](export.json) is one OTLP/HTTP JSON export from a scheduled job
that imports order `ord-7731` from a shop into an ERP. It has three annotated
records: the order was received, mapped to an ERP order (dropping the
warehouse), and refused by the ERP. Nothing but `curl` is needed, which makes
it the quickest way to see what Wayscribe does with an OTLP record and a useful
template for a service with no OpenTelemetry SDK.

Run an API with `OTLP_LOGS_ENABLED=true` (see
[OTLP_LOGS.md](../../docs/OTLP_LOGS.md)) and use an environment API key; an
admin token cannot ingest.

```sh
export WAYSCRIBE_URL=http://127.0.0.1:8080
export WAYSCRIBE_API_KEY='<environment API key>'

curl -sS -X POST "$WAYSCRIBE_URL/v1/logs" \
  -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @export.json
```

The answer is `{}`: every record was stored. Send it again and the answer is the
same, with no new events, because each record states a stable
`wayscribe.event.id`. A record Wayscribe refuses still gets HTTP 200, with a
`partialSuccess` object naming the refusal codes; check for it.

Read the journey back:

```sh
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  "$WAYSCRIBE_URL/v1/journeys/jrn_otlp_json_ord_7731"
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  "$WAYSCRIBE_URL/v1/events/evt_otlp_json_transformed"
curl -sS -H "Authorization: Bearer $WAYSCRIBE_API_KEY" \
  "$WAYSCRIBE_URL/v1/search?q=SHOP-100482"
```

Expect a `failed` journey of three events from service `order-import-cron`,
failed at `post-erp-order`; a payload diff on the transform showing `warehouse`
changing from `"BER-2"` to `null`; and the shop's order number finding the
journey through its alias.

## Reading the file

- `service.name` is the only required resource attribute. There is no
  `deployment.environment.name`, so the records take the API key's environment.
- The five journey annotations (`wayscribe.journey.id`, `entity.type`,
  `entity.id`, `operation`, `name`) are required on every record.
- Payloads are structured OTLP values (`kvlistValue`, `arrayValue`), not JSON
  strings. 64-bit integers are strings in OTLP JSON (`"intValue": "12950"`), as
  are timestamps in nanoseconds.
- An empty value (`"value": {}`) is `null`, which is how the transform's output
  says the warehouse was dropped.
- Body and severity are ignored. The third record has severity ERROR (17), but
  what makes it a business failure is `wayscribe.operation` `failed` with a
  `wayscribe.error`.
- The timestamps are fixed so that resending proves idempotency. A real job
  keeps each event's ID and timestamp with its work and resends both unchanged.

The integration suite posts this file, unchanged, through the real route twice
and checks the journey, diff, error, alias and event count
(`apps/api/src/routes/otlp.integration.test.ts`).
