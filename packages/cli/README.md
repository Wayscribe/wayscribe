# @wayscribe/cli

Read journeys, timelines and payload diffs, check ingestion configuration, and
preview stored-form events without opening a browser.

It talks to the REST API over HTTP, so it works from a laptop against a remote
install. Read commands remain read-only. The explicit `check` and `preview`
commands use the server dry run: no journey evidence is stored, although API-key
usage/verifier bookkeeping can change.

## Configure reads

```bash
export WAYSCRIBE_URL=http://localhost:8080    # default
export WAYSCRIBE_TOKEN=…                      # your ADMIN_TOKEN
export WAYSCRIBE_PROJECT=…                    # an admin token spans projects
```

`wayscribe projects` lists the ids. An API key names its own project, so
it needs no `WAYSCRIBE_PROJECT`; an admin token does.

Every variable has a flag — `--url`, `--token`, `--project` — and the flag wins.

## Use

```bash
wayscribe search 0018Z00002ABC
```

```text
JOURNEY                                     ENTITY                    STATUS    EVENTS  STARTED
jrn_d0896441-25b9-4bd0-be9e-3a009e4d831b    customer:0018Z00002ABC    failed    10      09 Aug 20:15:05
```

```bash
wayscribe journey jrn_d0896441-25b9-4bd0-be9e-3a009e4d831b
```

```text
customer:0018Z00002ABC
jrn_d0896441…  ·  failed  ·  10 events  ·  demo-integration, demo-worker
also known as  salesforceAccountId=0018…ABC

20:15:05   received     receive-salesforce-webhook    demo-integration
20:15:05   transformed  transform-salesforce-account  demo-integration 0ms
20:15:05   persisted    persist-customer              demo-integration 9ms
20:15:05   published    publish-customer-updated      demo-integration 18ms
20:15:05   consumed     consume-customer-updated      demo-worker
20:15:05 ! delivered    deliver-customer-to-target    demo-worker 14ms
20:15:08 ! retried      retry-customer-delivery       demo-worker 8ms
20:15:16 ! failed       move-message-to-dead-letter   demo-worker
```

```bash
wayscribe event evt_14babbcc-… --diff
```

```text
FIELD       BEFORE  →  AFTER
Phone       "+1 919 555 1234"  →  —
phone       —  →  null
```

There it is.

## For scripts

`--json` on read commands prints the raw response and no colour, whether or not a
terminal is attached:

```bash
wayscribe search 0018Z00002ABC --json | jq -r '.[0].journeyId'
```

Colour is off automatically when output is piped, and `NO_COLOR` is honoured.

`wayscribe --version` prints the CLI's version, from its own
`package.json`, and nothing else.

Exit codes: `0` success, `1` the request failed or the configuration is wrong,
`2` the command line itself was wrong.

## Notes

- **Workspace contracts.** Ingestion validation uses `@wayscribe/protocol`;
  output masking uses `@wayscribe/payload-security`. Argument parsing is `node:util`.
- **Aliases come back masked.** A listing shows `0018…ABC`, never the whole
  value; that is the API's behaviour, not the CLI's.
- **A journey outside your key's project or environment reads as absent.** 404
  rather than 403, deliberately — confirming that a record exists is itself a
  disclosure.
- Timelines follow cursors to the end. A truncated timeline would hide exactly
  the part worth seeing, which is where the record stopped.

## Check ingestion and preview stored events

```bash
# Set WAYSCRIBE_API_KEY securely in your shell; do not put keys in CLI arguments.
wayscribe check --url http://localhost:8080 --environment development --service setup-check
wayscribe preview batch.json --url http://localhost:8080 --json
# An alternate ingestion-key variable:
wayscribe check --url http://localhost:8080 --environment development --service setup-check --api-key-env DEV_INGEST_KEY
```

`check` requires an explicit URL, environment and service. Flags take precedence
over explicit `WAYSCRIBE_URL`, `WAYSCRIBE_ENVIRONMENT` and `WAYSCRIBE_SERVICE`;
there are no implicit defaults. It checks unauthenticated `/ready`, validates a
fresh synthetic event with the public parser, then posts only to
`/v1/events/batch?dryRun=true`. A configured URL path prefix is retained. URLs
must be HTTP(S) without userinfo, query or fragment; redirects are refused.

Both commands read only `WAYSCRIBE_API_KEY` or the variable named by
`--api-key-env` (an environment identifier). They never use `WAYSCRIBE_TOKEN`,
`ADMIN_TOKEN` or read-command flags `--token`, `--project`, `--limit`, `--diff`;
those two admin variable names are also refused as alternate sources. The key
must be a Bearer token of at least eight ASCII characters: letters, digits,
`- . _ ~ + /`, with optional trailing `=` padding. Invalid credentials and
arguments are refused with fixed messages that do not echo supplied values.

`preview` accepts exactly one regular UTF-8 JSON file with the public batch
shape `{ "events": [...] }`, at most 100 elements. Each event is validated by
the server, so invalid elements get per-position refusals. The request uses the
original file bytes unchanged, including whitespace, IDs and unknown fields.
It refuses environment/service overrides; environment/service variables do not
rewrite a preview. The ingestion key must match the file events' environments.
File validation happens before networking, using one nonblocking-open descriptor,
`fstat`, and a bounded read. Directories, FIFOs and invalid UTF-8/JSON are refused.

Success requires HTTP 200, a valid response, exactly one verdict per input, and
`dryRun: true`. There are no retries or live-ingestion fallback. Rejected verdicts
produce exit 1 even when other positions pass. Duplicate results and accepted
results without a stored form are identified explicitly. Neither establishes
that the environment omitted payloads.

Both output modes show a structured, selected result with the same guard policy:
per-position verdict/error, event identity/operation/service/time, capture
indicators, stored input/output/diff/error/aliases, and journey identity,
environment, status, services and aliases. Input, output and diff come only from
the server stored form. Environment capture policy may omit them; inspect
`hasInput`, `hasOutput`, `hasError`. Metadata-only capture is not an SDK failure.
Unknown response fields and HTTP error bodies/headers are never dumped. Displayed
strings and keys receive built-in text-secret masking, exact presented-key
redaction and terminal-control removal; secret-named property values are masked
as a final guard. These guards do not detect all personal data or arbitrary
unlabelled secrets. Use synthetic files or appropriately classified data.

`--json` writes one complete JSON value to stdout, including fixed errors. Human
mode uses the same structured preview, with errors on stderr. Oversized or unsafe
output fails closed instead of printing a partial preview. A numeric credential
that remains in a JSON scalar also refuses output rather than corrupting JSON.

| Bound | Limit |
| --- | --- |
| File/request bytes | 26,279,936 (100 events × default 262,144-byte event budget + 65,536-byte headroom) |
| Each HTTP request, including body | 5 seconds; check makes readiness then dry-run requests |
| Streamed response bytes | 4 MiB, enforced without trusting Content-Length |
| Rendered output including newline | 4 MiB, checked after masking and JSON escaping |
| Source string | 262,144 UTF-8 bytes |
| Response/output traversal | 10,000 nodes, counting object keys/array entries; depth 30 from response/output root |

An operator's smaller configured request/event limit may refuse a batch normally.
Stored-form diffs and journey aliases can amplify responses: even a single large
or deeply nested event can exceed the preview's response/work/output bounds.
Smaller batches help batch limits; reduce an individual fixture when it alone
exceeds a bound. Every limit error is fixed and safe.

A confirmed dry run stores no event, journey, alias or replay rows. API-key
`last_used_at` and verifier rotation bookkeeping may still change. `check` proves
explicit protocol/key/server configuration, not that an arbitrary installed SDK
or application works. Use the real record/flush/counter examples in the
[Node](../sdk-node/README.md#check-your-installed-recorder),
[Python](../sdk-python/README.md#check-your-installed-recorder) and
[Go](../sdk-go/README.md#check-your-installed-recorder) SDK READMEs for that.
