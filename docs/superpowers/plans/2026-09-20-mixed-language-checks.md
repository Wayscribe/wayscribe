# Mixed-language workflow and ingestion checks implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one journey across Node, Python and Go and give operators an explicit ingestion-key check and stored-form dry-run preview.

**Architecture:** Small loopback example programs use their real public SDKs and frozen carriers. The existing read CLI gains a separate ingestion configuration path and bounded dry-run client; existing read credentials/behavior stay intact.

**Tech Stack:** Existing native SDKs, Node/Python/Go standard libraries, existing TypeScript CLI, protocol/payload-security packages, Vitest and isolated PostgreSQL/API tests.

**Spec:** `docs/superpowers/specs/2026-09-20-mixed-language-checks-design.md`.

## Global Constraints

- Execute after Python and Go pass their individual local conformance gates. No package publication, GitLab work, push, deployment or account changes.
- Use public recorder APIs, the existing API and frozen propagation. No framework, queue broker, new protocol or mandatory service.
- Only synthetic data and owned loopback processes/databases. Children and temporary Go binaries must be cleaned on success, failure and interruption; do not touch a live stack.
- The application reads configuration and passes it explicitly to its SDK. Default propagation omits entity IDs, so consumers use the entity in their own business message.
- Node → Python via HTTP carrier; Python → Go via payload carrier. One journey contains identity/alias, transformation, failure, explicit retry and completion.
- check sends a synthetic event only to `/v1/events/batch?dryRun=true`; it does not prove an arbitrary installed application SDK works.
- preview replays the supplied protocol batch unchanged. Never mutate IDs, rebuild event bodies or silently fall back to live ingestion.
- Ingestion credentials come from WAYSCRIBE_API_KEY or a named environment variable, never the read CLI's WAYSCRIBE_TOKEN/--token or ADMIN_TOKEN.
- Validate inputs before network requests, bound file/request/response sizes, use short deadlines and refuse redirects. No keys or authorization headers in output.
- Require the server's dryRun:true marker before reporting preview success. JSON output has the same bounds and secret guards as human output.
- Dry runs may update API-key usage/verifier bookkeeping; they store no event/journey/alias/replay rows. Leadline dogfood remains a separate pilot gate.

### Task 1: A real Node → Python → Go journey

**Files:**
- Create `examples/mixed-language/{README.md,package.json,node-entry.mjs,python-worker.py,go-worker.go,run.mjs}` and minimal Go module metadata using the locally implemented module.
- Create `apps/api/src/routes/mixed-language.integration.test.ts` and focused child-process lifecycle tests/support as needed.
- Modify example/SDK documentation and explicit local test scripts; no CI or publication wiring.

**Interfaces:**
- The driver accepts an API URL and synthetic ingestion configuration through explicit arguments/environment, builds Go into an owned temporary directory, starts workers on port 0 and reads one bounded machine-readable readiness line from each.
- The Node entry returns a bounded summary `{ journeyId, entity, alias }`; this is business/test coordination output, not an alternative event emitter.
- Each worker imports its public SDK; the exact Go API/module signatures come from its completed Task3 report and are copied into this task brief before dispatch.
- The example's private ESM package declares `@wayscribe/node` as `file:../../packages/sdk-node`, following `examples/instrument-a-service`. Build that public package first and document the local example install; do not rely on undeclared root package resolution or change the root workspace membership. Integration setup may create an owned local dependency link, with bounded cleanup, to avoid repeated installs.

- [ ] **Step 1: Write the real integration expectation first.** Start the existing isolated test API/database, seed a project/environment/key, then run the three-program driver. Query the API by the returned alias and assert one journey, expected entity and services, one transformed event with literal before/after payloads and a field diff, failed/retried delivery and terminal completion. Check the synthetic secret is redacted, not merely absent because no payload recorded.

```ts
expect(journey.items).toHaveLength(1);
expect(new Set(detail.services)).toEqual(new Set(["mixed-node", "mixed-python", "mixed-go"]));
expect(detail.status).toBe("completed");
expect(transformation.inputPayload).toMatchObject({ email: " Mixed@Example.invalid ", password: "[REDACTED]" });
expect(transformation.outputPayload).toMatchObject({ email: "mixed@example.invalid", password: "[REDACTED]" });
expect(transformation.payloadDiff.changes).toContainEqual(expect.objectContaining({ path: "email", kind: "changed" }));
```

Use actual API response field names and literal expectations; do not construct expected journeys from SDK events.

- [ ] **Step 2: Implement the public-SDK applications.** Node records receipt and alias, injects HTTP context while preserving a supplied traceparent, and posts a business message with entity and payload to Python. Python extracts/resumes with that authoritative entity, transforms input/output, then sends a payload-envelope message to Go. Go unwraps/resumes, records a deterministic simulated failed delivery, a successful explicit retry and completion. Simulate the destination locally; no external SaaS is contacted. Flush/shutdown each recorder within a deadline and return diagnostic counters on failure without credentials. Check that default carriers exclude the entity ID while all events still name the correct entity from the business message.

- [ ] **Step 3: Add lifecycle and boundary evidence.** Refuse malformed readiness/worker responses, bound startup/request/child output and total run time, and terminate only owned children with bounded escalation. Test one worker failing before ready, one hanging and successful cleanup; remove the owned Go executable/temp directory in finally. Assert an incompatible API-key environment refuses events without crossing the existing journey boundary. Reuse installed Python artifacts and a separate Go consumer module with a local replace where practical; document any source-checkout prerequisite.

- [ ] **Step 4: Verify, document and commit.** Run the real integration and child lifecycle checks, Go compile/vet for the example and Python/Node syntax checks. Add a short runnable README explaining explicit configuration, authoritative entity messages, the two carriers and expected query result. Clearly distinguish controlled interoperability from Leadline dogfood. Commit `test(examples): prove one journey across Node Python and Go`.

### Task 2: Explicit dry-run check and guarded stored-form preview

**Files:**
- Create `packages/cli/src/{ingestion-config,ingestion-client,ingestion-preview}.ts` and focused tests.
- Modify `packages/cli/src/{cli,index}.ts`, `cli.test.ts`, CLI README/package dependencies and relevant docs.
- Create `apps/api/src/routes/cli-preview.integration.test.ts` using the existing isolated API setup.
- Add real SDK diagnostic/counter examples to Node/Python/Go READMEs without changing runtime behavior.

**Interfaces:**
- `check --url <url> --environment <name> --service <name> [--api-key-env <NAME>] [--json]`; URL/environment/service may instead come from explicit WAYSCRIBE_URL/WAYSCRIBE_ENVIRONMENT/WAYSCRIBE_SERVICE values. No implicit localhost/service/environment for check.
- `preview <batch.json> --url <url> [--api-key-env <NAME>] [--json]`; the file supplies event environments/services and is never rewritten. Environment/service override flags are refused for preview.
- The default key variable is WAYSCRIBE_API_KEY. Validate alternate variable names as environment identifiers; reject read-only command flags --token/--project/--diff/--limit for these commands with safe fixed messages.
- `runIngestionCommand(command, args, io): Promise<number>` runs before existing resolveConfig, so an unset admin/read token cannot block check/preview and a configured one cannot leak into ingestion.
- `IngestionClient` has only ready() and dryRun(rawBatch), with endpoint construction fixed to readiness and dry-run paths. There is no live-ingest fallback method.

- [ ] **Step 1: Write configuration and request-shape tests and observe RED.** Assert help before credential access, exact arity, unknown/duplicate flags, no credentials in parser errors, no URL userinfo/query/fragment, missing explicit settings, invalid alternate env names and ingestion/admin token separation. Reject nonregular/over-limit input files, invalid JSON/batch shape and over-100 event lists before networking. Check validates protocol fields against public schemas but does not re-serialize preview input. Bound the file using open/fstat plus a bounded read from the same descriptor, not stat-then-unbounded-read.

```ts
const io = captureIo({ WAYSCRIBE_TOKEN: "admin-sentinel", WAYSCRIBE_API_KEY: "ingest-sentinel" });
await run(["check", "--url", endpoint, "--environment", "development", "--service", "setup-check"], io);
expect(receivedAuthorization).toBe("Bearer ingest-sentinel");
expect(receivedUrl).toBe("/v1/events/batch?dryRun=true");
expect(io.output()).not.toContain("ingest-sentinel");
expect(io.output()).not.toContain("admin-sentinel");
```

- [ ] **Step 2: Implement bounded dry-run transport.** Use explicit http(s) targets, no redirects, an overall short request deadline and bounded streamed response reads, including when content-length is missing or wrong. Derive/document the default request ceiling from the public 100-event/default event-budget contract and name a fixed response ceiling; a server with a smaller configured limit may refuse normally. Use a synthetic event with random fresh IDs only for check; preview sends exact UTF-8 file bytes. Require expected status, object/result structure, one verdict per input and dryRun:true before any success claim. A response without the marker, malformed/oversized body, network timeout or redirect returns a fixed safe code/nonzero exit without retrying live ingestion.

- [ ] **Step 3: Implement deliberate output.** Display accepted/rejected verdicts and selected stored event/journey fields, including input/output/diff only from the stored-form preview. Explain policy omission without guessing absent payloads are a client failure. Never dump raw HTTP headers/body. Reuse payload-security's maskSecretsInText for server diagnostic/error text through a workspace dependency or existing narrow export, strip terminal control characters from displayed text, and redact the exact presented key from every output path. JSON emits the same selected bounded result and guard policy. Update help's existing “Everything reads” statement: dry runs validate without storing journey evidence, though key bookkeeping can change. Do not broaden existing read commands in this task.

- [ ] **Step 4: Prove the server effects and read-command regression.** Against a real owned API/database, run check and previews under redacted, metadata-only and custom server-redaction policy. Compare literal stored-form response expectations and counts before/after across journeys/events/aliases/replay rows, including rejected batches. A loopback fake collector covers non-dry-run responses, secret-bearing errors, chunked oversized responses, redirects and delayed bodies. Assert preview request bytes equal the file bytes exactly. Run the current CLI read-command suite unchanged alongside these tests.

- [ ] **Step 5: Verify and commit.** Run CLI unit/type/build checks, API-backed preview integration, changed-file lint/format and relevant docs checks. Include public-SDK examples that record/flush/read diagnostics and explain check does not inspect an arbitrary installed SDK. Document key separation, file/body limits, environment policy, explicit dry-run marker and bookkeeping caveat. Commit `feat(cli): check ingestion and preview stored events safely`.

## Plan self-review

The example and CLI are independently useful and have distinct review gates. The example proves actual public SDK interoperability; the CLI proves explicit protocol/key/server configuration only. Existing read credentials cannot flow into new ingestion commands, supplied preview bytes remain unchanged, and the server's dry-run marker and database counts independently support the no-journey-write claim.
