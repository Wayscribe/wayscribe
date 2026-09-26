# Mixed-language journey

This controlled local example records one synthetic customer journey through
three public SDKs: Node sends an HTTP business message to Python, and Python
sends a payload-envelope business message to Go. It is an interoperability
check, separate from the independent Leadline dogfood pilot.

The business message is authoritative for the entity. Both carriers use the
default `journey-and-type` level, so they carry the journey ID and entity type
but deliberately omit the entity ID. The Node HTTP carrier also preserves an
existing `traceparent`; the Python payload carrier wraps data under `data` and
puts Wayscribe context beside it under `_wayscribe`.

Build the checked-out Node package, install this standalone example, and create
an owned Python environment from the reviewed local wheel:

```sh
pnpm --filter @wayscribe/node build
cd examples/mixed-language
npm install
python3 -m venv .venv
.venv/bin/python -m pip install --no-index \
  ../../packages/sdk-python/dist/wayscribe-0.2.0-py3-none-any.whl
```

Run it against a local API with an ingestion key for the named environment:

```sh
WAYSCRIBE_PYTHON=.venv/bin/python node run.mjs \
  --api-url http://127.0.0.1:8080 \
  --api-key "$WAYSCRIBE_API_KEY" \
  --environment development
```

The driver builds the Go consumer module with its local `replace`, starts both
workers on loopback port `0`, bounds readiness, requests, output and total run
time, and removes its temporary executable and owned children on every exit.
It prints one JSON summary containing `journeyId`, `entity`, and `alias`.

Search for `crm-mixed-9001`. The result is one completed journey for
`customer:customer-mixed-42`, with services `mixed-node`, `mixed-python`, and
`mixed-go`. `normalize-email` shows the email changing from
`" Mixed@Example.invalid "` to `"mixed@example.invalid"`; the synthetic
password is `[REDACTED]`. `deliver-customer` then shows a failed delivery, a
successful explicit second attempt recorded as `retried`, and completion.
