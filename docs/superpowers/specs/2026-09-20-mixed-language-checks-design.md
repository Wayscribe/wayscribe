# Mixed-language workflow and ingestion preview

## Scope

After Python and Go pass their individual conformance gates, add the practical
adoption checks approved in ADR-065. Use public recorder APIs and the existing
server. Do not add a framework, queue broker, protocol variant or mandatory
service. These are optional examples/tools; normal SDK use stays unchanged.

## One journey through three languages

Add `examples/mixed-language/` with a small Node entry point, Python worker and
Go worker. A local driver starts the workers on loopback-assigned ports, provides
configuration explicitly through its process environment, invokes one synthetic
business operation, and cleans up only its children. Each application reads its
own configuration and passes it explicitly to its SDK. No application credentials
or customer data are embedded in source.

Node creates a journey and records receipt/identity, Python resumes it through
the frozen HTTP carrier and records a transformation with distinct input/output,
and Go resumes through the payload carrier and records a failed delivery, an
explicit retry and completion. Default propagation intentionally omits the
entity identifier; each consumer obtains the authoritative entity from its own
business message. Preserve traceparent without treating it as the journey ID.
One alias makes the complete journey searchable. An embedded synthetic secret
must be redacted by the SDK and again by server policy.

The actual-ingest integration creates an owned test database/API, drives all
three programs and queries the result. Assert one journey and entity, all three
service identities, the alias, redacted payload, field-level diff, failed/retried
outcomes and final completion. Assert stable journey identity across both
carriers and explicit environment isolation. Do not call a handcrafted wire
generator in place of any language's public SDK. Run the Go worker as a built
temporary executable and delete that owned binary after the test.

## Ingestion check and preview

Extend the existing read CLI with two explicit dry-run commands. `check` verifies
server readiness and sends a synthetic minimal event through
`POST /v1/events/batch?dryRun=true` to check an ingestion key's environment and
wire compatibility. It does not claim to test an arbitrary application's installed
SDK. Pair it in each SDK README with that SDK's real diagnostic/counter example.

`preview <batch.json>` reads an existing protocol batch and shows the response's
stored-form preview. It does not re-create supplied events, mutate their IDs or
silently fall back to live ingestion. Require explicit URL/environment/service
settings for a synthetic check and an ingestion key from `WAYSCRIBE_API_KEY` or
a named environment variable; do not accidentally reuse the CLI's admin token.
The API validates the supplied environment against that key. Existing CLI reads
continue using their present credential configuration.

Validate arguments and local JSON before any request. Bound file, request and
response size to the documented route limits, use a short timeout and refuse
redirects. Never include keys or authorization headers in output. Validate the
server's `dryRun: true` response marker before describing anything as a preview;
a non-dry-run response is an error, never success. Server errors produce stable
safe messages and a nonzero exit code.

Preview output separates accepted/rejected verdicts from stored-form payloads
and explains when environment capture policy omits them. Apply built-in secret
masking to displayed diagnostic/error text as a final output guard. Display only
the structured fields intentionally requested, never a raw HTTP dump. `--json`
may emit the same bounded, guarded result for tooling. A dry run still touches
API-key usage/rotation bookkeeping as the existing contract specifies; it stores
no event, journey, alias or replay rows. Document that distinction precisely.

## Evidence and boundaries

Unit tests cover command parsing, credential separation, safe output, redirects,
timeouts and refusing a response without the dry-run marker. Real API tests
compare counts before/after check and preview, including rejected batches, and
verify redaction/omission under environment policies. Test existing CLI read
commands for regression and use installed native SDK artifacts where practical.
Do not publish packages or start GitLab work. The independent Leadline dogfood
gate from ADR-059 remains distinct from this controlled example.
