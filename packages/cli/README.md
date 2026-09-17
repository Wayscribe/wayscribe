# @flight-recorder/cli

Read journeys, timelines and payload diffs from a Flight Recorder installation,
without opening a browser.

It talks to the REST API over HTTP, so it works from a laptop against a remote
install. It reads and does nothing else — there is no command here that writes
or deletes.

## Configure

```bash
export FLIGHT_RECORDER_URL=http://localhost:8080    # default
export FLIGHT_RECORDER_TOKEN=…                      # your ADMIN_TOKEN
export FLIGHT_RECORDER_PROJECT=…                    # an admin token spans projects
```

`flight-recorder projects` lists the ids. An API key names its own project, so
it needs no `FLIGHT_RECORDER_PROJECT`; an admin token does.

Every variable has a flag — `--url`, `--token`, `--project` — and the flag wins.

## Use

```bash
flight-recorder search 0018Z00002ABC
```

```text
JOURNEY                                     ENTITY                    STATUS    EVENTS  STARTED
jrn_d0896441-25b9-4bd0-be9e-3a009e4d831b    customer:0018Z00002ABC    failed    10      09 Aug 20:15:05
```

```bash
flight-recorder journey jrn_d0896441-25b9-4bd0-be9e-3a009e4d831b
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
flight-recorder event evt_14babbcc-… --diff
```

```text
FIELD       BEFORE  →  AFTER
Phone       "+1 919 555 1234"  →  —
phone       —  →  null
```

There it is.

## For scripts

`--json` on any command prints the raw response and no colour, whether or not a
terminal is attached:

```bash
flight-recorder search 0018Z00002ABC --json | jq -r '.[0].journeyId'
```

Colour is off automatically when output is piped, and `NO_COLOR` is honoured.

`flight-recorder --version` prints the CLI's version, from its own
`package.json`, and nothing else.

Exit codes: `0` success, `1` the request failed or the configuration is wrong,
`2` the command line itself was wrong.

## Notes

- **No runtime dependencies.** Argument parsing is `node:util`, and colour is
  four escape codes.
- **Aliases come back masked.** A listing shows `0018…ABC`, never the whole
  value; that is the API's behaviour, not the CLI's.
- **A journey outside your key's project or environment reads as absent.** 404
  rather than 403, deliberately — confirming that a record exists is itself a
  disclosure.
- Timelines follow cursors to the end. A truncated timeline would hide exactly
  the part worth seeing, which is where the record stopped.
