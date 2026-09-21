# Python SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a complete native Python recorder meeting the existing Wayscribe SDK and ingestion contracts, with local conformance and packaging evidence.

**Architecture:** Python-only capture/propagation modules feed immutable envelopes into a bounded background HTTP sender. The facade preserves synchronous/asynchronous host behavior. A fixture driver captures the real transport output for the existing API's dry-run validator.

**Tech Stack:** Python >=3.11 standard library, unittest, setuptools packaging; existing Node/Vitest/PostgreSQL integration harness.

**Spec:** docs/superpowers/specs/2026-09-20-python-sdk-design.md

## Global Constraints

- Python >=3.11; runtime uses only the standard library.
- Distribution `wayscribe-sdk`; import `wayscribe`; development version `0.1.0a1`, unpublished.
- `docs/SDK_SPEC.md` SDK-1 through SDK-67 and the ingestion/propagation contracts are authoritative.
- Existing protocol version `0.1`; no server schema or protocol version changes.
- No GitLab pipeline, push, PyPI publication or account changes.
- Work only in codex/sdk-expansion; preserve other worktrees and resources.
- No fixture expected values may be weakened to accommodate an implementation.
- Record calls never wait on the network; callbacks retain return/exception/cancellation semantics.

### Task 1: Safe Python protocol, capture and propagation core

**Files:**
- Create `packages/sdk-python/pyproject.toml`, `LICENSE`, `NOTICE`, `README.md`.
- Create `packages/sdk-python/src/wayscribe/{__init__.py,_version.py,py.typed,_config.py,_diagnostics.py,_capture.py,_errors.py,_event.py,propagation.py,timing.py}`.
- Create `packages/sdk-python/tests/{test_capture.py,test_event.py,test_config.py,test_propagation.py,test_timing.py,test_diagnostics.py}` and shared test helpers where needed.
- Modify `.gitignore` for Python-owned generated caches/build metadata only.

**Interfaces:**
- `resolve_config(options: Mapping[str, object], diagnostics: Diagnostics) -> Config`: detached settings with `endpoint`, `api_key`, `service`, `environment`, `capture_mode`, redaction/known-safe names, all delivery limits and deployment metadata. `Config.enabled` is false for unusable required values. Config does not start threads or perform network I/O.
- `Diagnostics`: guarded `emit(kind, **safe_fields)` plus counters and rejected-settings snapshots. Counters include recorded/sent/rejected/dropped, payload omissions/truncations and dropped-by-cause. Define one lock/ownership rule for Task 2 and document it.
- `build_envelope(config, diagnostics, *, journey_id, entity, operation, name, **fields) -> bytes | None`: returns compact UTF-8 JSON bytes containing `{protocolVersion:"0.1",event:{...}}`, already captured/redacted/fitted, or safely refuses unusable required identity. Do not count an event as queued; Task 2 owns recorded/delivery accounting. Payload omission/truncation diagnostics belong here.
- Public propagation/timing functions and signatures as in the spec, with JSON-compatible context shape and snake_case function names. Internal UNSET distinguishes omission from None.
- Produce a short interface map in the task report with actual dataclass fields/helper signatures for the next implementer.

- [ ] **Step 1: Add red tests for capture and validation.** Exercise actual functions; before implementation run `PYTHONPATH=packages/sdk-python/src python3 -m unittest discover -s packages/sdk-python/tests -v`. Representative expectation:

```python
payload = {"nested": {"API_KEY": "secret", "name": "Ada"}}
wire = build_envelope(config, diagnostics, journey_id="jrn_123",
    entity={"type": "order", "id": "42"}, operation="received",
    name="receive", input=payload)
payload["nested"]["name"] = "changed"
event = json.loads(wire)["event"]
self.assertEqual(event["input"], {"nested": {"API_KEY": "[REDACTED]", "name": "Ada"}})
self.assertNotIn(b'"secret"', wire)
```

Add literal boundary cases for every SDK_SPEC capture repair, header shape, event-fitting step, invalid required/optional settings and safe diagnostic output. Assert an overlong secret is masked before truncation; a shared reference expands twice; Unicode-unit limits differ correctly; custom paths preserve built-ins; public aliases/labels retain their documented behavior.
- [ ] **Step 2: Implement core modules against SDK_SPEC.** Keep configuration, capture, error masking, event fitting and diagnostics separate. Never stringify arbitrary hostile objects outside a guard. Copy LICENSE/NOTICE accurately. Include build identity/version without reading host environment variables. Keep README clear that delivery facade follows in Task 2 and the package is unpublished.
- [ ] **Step 3: Implement/test shared propagation and derivation vectors.** Load the committed JSON vectors, dispatch all carrier/action cases and compare literal output. Derivation reproduces every journey-id vector. Malformed/empty/surrogate entities and missing/short secrets fall back to distinct cryptographic IDs and safe reports. Validate timing helpers with retry-ready, redelivery, zero, missing, negative and collision-length cases.
- [ ] **Step 4: Run all core tests on available Python versions and commit.** Capture RED and GREEN evidence. Use available 3.12/3.13 via explicit installed executable paths plus system 3.14. No registry install is required for tests. Report any behavior whose contract remains ambiguous before guessing. Commit only Task 1 files with `feat(sdk-python): add safe event capture and propagation`.

### Task 2: Public recorder, wrappers and bounded HTTP delivery

**Files:**
- Create `packages/sdk-python/src/wayscribe/{_transport.py,recorder.py}`.
- Modify public exports, README, and core modules only for needed integration.
- Create `packages/sdk-python/tests/{test_recorder.py,test_transport.py,test_wrappers.py,test_shutdown.py}` with loopback server utilities.

**Interfaces:**
- Consume Task 1 Config/Diagnostics/build_envelope and public helper interfaces; read its report's interface map before editing.
- Produce `create_recorder`, `Recorder`, `Journey` and every method in the Python design spec.
- `_transport` owns pending/inflight/retry identity exactly once; final Counters snapshots reconcile `recorded == sent + rejected + dropped` after shutdown.

- [ ] **Step 1: Write host-behavior tests before facade code.** Use a loopback server for captured bytes and a stopped port for failures. Examples:

```python
marker = object()
self.assertIs(journey.transform("transform", {}, lambda: marker), marker)
problem = ValueError("host sentinel")
def fails():
    raise problem
try:
    journey.deliver("deliver", {}, fails)
except ValueError as actual:
    self.assertIs(actual, problem)
else:
    self.fail("the host error was swallowed")
```

Repeat with awaitables/cancellation, failed projections and failed diagnostic callbacks; capture input before a callback mutates it; retry attempts record retried plus their own error; across executes once and emits one ID per distinct journey.
- [ ] **Step 2: Implement the recorder and guarded wrappers.** Never wrap host callbacks in a catch that swallows their exception. All configuration/capture/internal errors remain isolated. Preserve the user's exception object, callback result and sync/async shape. Support context managers and no-network fallback for rejected configuration. Derivation, labels, aliases, timing and build identity integrate through Task 1.
- [ ] **Step 3: Test and implement bounded delivery.** Loopback responses cover accepted+permanent+transient outcomes, unknown IDs, missing verdicts, malformed/oversized bodies, whole-request 4xx/5xx, network timeout and redirect refusal. Assert stable retry bytes, only transient events retried, a batch never exceeds 100, oldest eviction, sender concurrency and breaker behavior. Use injected monotonic clock/wait boundary where necessary to test 30-second/10-send budgets without long sleeps; keep dependency seams private and production-useful.
- [ ] **Step 4: Test and implement shutdown/concurrency/fork behavior.** Block a server response, call shutdown with a short deadline, and assert elapsed time is bounded, sockets/workers cannot produce later delivery, counters finalize once, and the host process exits. Race simultaneous record/flush/shutdown. An inherited recorder must not deadlock or resend copied buffered events; document the chosen disable/reset behavior. Add subprocess checks for process exit and invalid config safety.
- [ ] **Step 5: Run complete Python tests, update README with runnable examples and commit.** Run available interpreter matrix and retain actual test output in the task report. Commit `feat(sdk-python): deliver journeys with bounded background transport` after self-review.

### Task 3: Real conformance, integration and installable artifacts

**Files:**
- Create `packages/sdk-python/tests/conformance_driver.py` and fixture-runner test/support files.
- Create `apps/api/src/routes/python-sdk-conformance.integration.test.ts` and `python-sdk-workflow.integration.test.ts` (may combine when sharing one setup improves isolation).
- Create `examples/python-worker/{README.md,worker.py}`.
- Modify `packages/sdk-python/README.md`, packaging metadata and project documentation to report verified capabilities accurately.
- Modify root package scripts only to expose explicit local Python test commands; no CI triggers/publication changes.
- Modify `.dockerignore` and `scripts/verify-image-contents.sh` so native SDK sources, tests and Python build/cache artifacts do not enter server images. Add `packages/sdk-python` to the excluded image context and forbidden runtime directories; prepare the same exclusion for `packages/sdk-go` when that package is introduced. The API and web do not depend on either recorder. Preserve existing image runtime checks.

**Interfaces:**
- Driver runs `python3 packages/sdk-python/tests/conformance_driver.py` with source or installed-wheel import path, writes JSON to stdout containing `{cases:[{id,batches,events,diagnostics}],skipped:[{id,reason}]}`. Each `batches` member is the exact UTF-8 HTTP request body the real recorder sent to a loopback server; diagnostics go into structured output, never stray stdout.
- `cases` covers every fixture with languages `*`/`python`; Node-only fixtures are named in skipped. Expand the documented fixture DSL including special values, projections, across and patterns, but never generate expected results from production functions.
- Integration imports `buildApp`, creates a fresh test database and appropriate project/environment keys through existing helpers; it replays raw captured batch strings to `/v1/events/batch?dryRun=true` with that fixture's server settings, compares `expect.wire` and `expect.results[].stored`, and asserts rollback. Only authorization headers change, not request bodies.

- [ ] **Step 1: Add driver and coverage tests; observe failures for missing behavior.** Reuse the protocol manifest and TypeScript expectation comparator on the API side. Assert exact executed/skipped case IDs so missing coverage fails. Extend the SDK with a regression-first fix for every failure; do not weaken the fixture or replace captured bytes with handcrafted events.
- [ ] **Step 2: Add the actual API dry-run integration.** Run `pnpm --filter @wayscribe/api... build`, then `pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/routes/python-sdk-conformance.integration.test.ts`. Use existing owned test-container cleanup. Do not touch running Leadline or other project databases. Assert accepted/stored semantics and no new journeys after dry runs.
- [ ] **Step 3: Exercise real Python ingestion.** The worker records one business entity, an alias, transformation, failed/retried delivery and completion. Query the real local API to prove one journey, searchable alias, redacted payload, field diff and attempt outcome. The example reads configuration in application code and documents explicit SDK configuration.
- [ ] **Step 4: Build and install artifacts in a clean temporary environment.** Build a wheel/sdist with setuptools, install the wheel without runtime dependencies, and test public imports and loopback delivery outside the source tree. Check LICENSE/NOTICE/py.typed and fixed SDK build identity are packaged. Remove only this task's temporary environment/artifacts when finished.
- [ ] **Step 5: Verify interpreter coverage, docs and commit.** Keep the Python SDK out of server build context/runtime and extend the existing image-content guard to assert it. Check the changed shell syntax; run the real image guard if a locally built image is available and report the image-build gate honestly otherwise. Run the complete Python suite, relevant API integration suite, formatting/typechecks for changed TS, and documentation checks. Mark Python implemented only after this evidence passes; list any publication or platform gates still deferred. Commit `test(sdk-python): verify public wire conformance and packaged install`.
