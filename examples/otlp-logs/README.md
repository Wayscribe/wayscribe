# Annotated OTLP logs with the official Python exporter

Use Python 3.10+ and an API built from source with `OTLP_LOGS_ENABLED=true`.
Use your local environment API key; an admin token cannot ingest.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export OTLP_EXAMPLE_ENDPOINT=http://127.0.0.1:8080/v1/logs
export OTLP_EXAMPLE_API_KEY='<environment API key>'
.venv/bin/python export.py
```

The script exports two explicit business events, with gzip and batch size 100.
The generic body and severity are ignored. Input/output use structured AnyValue
attributes, not JSON strings. Stable synthetic IDs and timestamps are intentional:
running it twice proves idempotency. Real applications must persist their own
IDs/timestamps with their work and preserve them on retries. A changed event with
an existing ID is permanently refused. The exporter flush result alone does not
prove persistence; query the API:

```sh
curl -H "Authorization: Bearer $OTLP_EXAMPLE_API_KEY" 'http://127.0.0.1:8080/v1/search?q=crm-otlp-9001'
curl -H "Authorization: Bearer $OTLP_EXAMPLE_API_KEY" http://127.0.0.1:8080/v1/journeys/jrn_otlp_official/events
curl -H "Authorization: Bearer $OTLP_EXAMPLE_API_KEY" http://127.0.0.1:8080/v1/events/evt_otlp_official_transform
```

Expect two stored events, the searchable alias, a redacted password, and a diff
from `phone: "555-0100"` to null. Only the explicitly annotated failure is a
business failure. [Mapping and limits](../../docs/OTLP_LOGS.md) describe permanent
partial success and 503 retry behavior. The Python dependencies are tooling only.

From the repository root, reproduce the owned PostgreSQL/loopback integration
proof (Docker required, using only disposable test resources):

```sh
python3 -m venv /tmp/wayscribe-otlp-proof
/tmp/wayscribe-otlp-proof/bin/python -m pip install -r examples/otlp-logs/requirements.txt
OTLP_EXPORTER_PYTHON=/tmp/wayscribe-otlp-proof/bin/python pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/routes/otlp.integration.test.ts
rm -rf /tmp/wayscribe-otlp-proof
```

Choose a new environment path you own; remove only that environment after use.
The suite launches the exporter asynchronously against its owned loopback API,
bounds the child to 30 seconds and 64 KiB output, and awaits child exit. API,
pool and database cleanup also runs after failed setup. With no
`OTLP_EXPORTER_PYTHON`, only the official-exporter case is skipped; real storage
coverage still runs. Nothing sends telemetry to a public endpoint.
