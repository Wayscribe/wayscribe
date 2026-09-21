# Native SDK refusal-budget parity

> **For agentic workers:** Use superpowers:subagent-driven-development for this bounded follow-up after Go's local task gates and before optional OTLP.

**Goal:** Make Node and Python enforce the existing per-event retry ceiling even when a transient event refusal is followed by whole-request transport failures.

**Architecture:** Retain each SDK's queue/transport ownership and immutable event bytes. Count one logical send containing actual HTTP work once an event has entered refusal tracking, independently of the HTTP attempts within that send. Recheck elapsed expiry before starting another attempt.

**Spec:** `docs/SDK_SPEC.md` SDK-9, SDK-30 through SDK-34 and SDK-65, plus `docs/INGESTION_CONTRACT.md` section 4. The Go task ledger records the interpretation: the first-refusal cycle counts, later nonempty logical send cycles count even without a fresh per-event verdict, and cycles with no HTTP work count zero.

## Global Constraints

- Local work only in the SDK expansion worktree. No push, GitLab, CI, publication, deployment, version/tag changes, account operations or outreach.
- Preserve released configuration names/defaults and API signatures, request bytes/IDs, permanent and missing-verdict behavior, and terminal accounting.
- Do not reset a refused event's first-refusal clock or logical-send count when requeued. HTTP attempts and logical sends remain separate budgets.
- A send that performs no nonempty HTTP attempt must neither increment nor reset the breaker. A cycle with actual unsuccessful HTTP work still counts appropriately; stored events prevent a failure count.
- Preserve every existing fixture expectation. This change corrects local unreleased source; it does not claim the published Node package already contains the fix.

### Task 1: Enforce logical-send and elapsed refusal budgets across earlier SDKs

**Files:**
- Modify `packages/sdk-node/src/transport.ts` and `transport.test.ts`.
- Modify `packages/sdk-python/src/wayscribe/_transport.py` and `packages/sdk-python/tests/test_transport.py`.
- Clarify the logical-send/HTTP-attempt distinction in `docs/INGESTION_CONTRACT.md` section 4 while preserving its existing limits and status rules.
- Update a focused README note only if needed to explain the existing logical-send/attempt distinction; no unrelated documentation rewrite.

- [ ] **Step 1: Reproduce the mixed-outcome gap with literal tests.** Use existing transport/collector test seams. Configure a small send cap, give one transient per-event refusal, then only transport failures or whole-request 5xx. Assert the event reaches retry-budget terminal accounting at the logical-send cap without waiting for another per-event refusal or the elapsed deadline. Also prove multiple HTTP attempts inside one logical send consume only one send unit. Capture actual RED evidence in both languages before changing implementation.
- [ ] **Step 2: Correct the counters and pre-attempt elapsed check.** Base logical-send accounting on whether a tracked event participated in actual HTTP work during that cycle, not whether it received a fresh refusal. Include the cycle in which refusal tracking first starts. Stop expired events before another HTTP attempt, including after backoff and breaker cooldown; preserve literal expiry-only breaker regressions and immutable event bytes. Node's current implementation checks expiry only when a fresh refusal arrives, so add the missing no-fresh-verdict case there as needed. Keep all terminal/drop accounting with its existing owner. Clarify in the existing ingestion contract that capped HTTP attempts belong to one logical send, the first-refusal send counts, later sends count without requiring a fresh refusal, and no-HTTP cycles do not count; this makes the existing upper bound unambiguous for future native implementations.
- [ ] **Step 3: Verify adjacent behavior.** Cover cap exhaustion, elapsed exhaustion, expiry-only/no-HTTP cycles, partial success, permanent 4xx, missing verdicts, requeue and stable IDs/bytes using existing deterministic time seams. Run the relevant Node transport tests and Python transport tests, affected package typechecks/lint and Python Ruff. Run Python covering tests on available 3.11–3.14 interpreters; do not repeat unrelated SDK conformance/API suites unless a change affects their contracts.
- [ ] **Step 4: Self-review and commit.** Report the exact discrepancy, fixed counter/clock ownership, commands and actual RED/GREEN output under the plan's ignored workspace, with raw logs separately. Commit `fix(sdks): bound retries across mixed refusal and transport failures`. The controller supplies task spec/quality review, followed by scoped fixes if needed. No implementer-owned subagents or reviewers.

## Discovery evidence

Go delivery preparation exposed that Node's `refusedHere` and Python's per-cycle `refused` set gate the send-count increment. Both omit later cycles consisting only of transport failures. The written contract bounds sends from the first refusal, regardless of a later response's shape. This follow-up closes that gap without changing the native protocol or optional OTLP scope.
