# SDK Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the cross-language propagation contract and record the approved Python → Go → optional OTLP sequence.

**Architecture:** Preserve the released Node carrier names and wire behavior while specifying a reusable contract with literal test vectors. Adapt those fixtures to the existing Node public propagation functions. Record the owner's expanded roadmap in a new architecture decision, keeping historical decisions readable.

**Tech Stack:** Markdown, JSON, TypeScript, Vitest; no new runtime dependencies.

**Spec:** docs/superpowers/specs/2026-09-20-sdk-expansion-design.md (deliverable 1 and program boundaries)

## Global Constraints

- Native SDKs send directly to the existing event API and never depend on OTLP.
- PostgreSQL stays the only required data store.
- Full payload capture remains an explicit opt-in.
- Implementation and validation proceed locally; GitLab-dependent work and publication remain deferred.
- Preserve existing propagation wire names and the three privacy levels.
- No framework, OTLP, Python or Go runtime dependency is added by this foundation task.

### Task 1: Approve the language sequence and specify/test propagation

**Files:**
- Create: `docs/PROPAGATION_SPEC.md`
- Create: `packages/protocol/fixtures/propagation.json`
- Create: `packages/sdk-node/src/propagation-vectors.test.ts`
- Modify: `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/FAQ.md`, `docs/TASKS.md`, `AGENTS.md`
- Modify: `docs/SDK_SPEC.md`, `packages/sdk-node/src/propagation.ts`, `packages/sdk-node/README.md` only to link the settled contract and correct experimental-status claims.
- Modify: `README.md` and existing documentation checks only where an ADR count or source-of-truth link must change.

**Interfaces:**
- Consumes the public `injectHttpHeaders`, `extractHttpContext`, `injectSqsAttributes`, `extractSqsContext`, `injectPayload`, `extractPayload`, and `hasJourney` exports in `packages/sdk-node/src/propagation.ts`. Read their exact signatures before constructing the test adapter.
- Produces a versioned JSON fixture `{ "version": 1, "cases": [...] }`. Each case has `name`, `carrier` (`http`, `sqs`, or `payload`), `action` (`inject` or `extract`), `input`, and a literal `expected`. Each injection input supplies context/level/carrier or data as needed; each extraction input supplies the complete carrier. Null expected context represents no usable context. The specification defines the schema sufficiently for independent Python/Go runners.

- [ ] **Step 1: Inspect current propagation behavior and document the contract boundaries.** Read the complete propagation implementation and tests, SDK_SPEC section 10, SECURITY propagation rules, and ADR-059/060/062/064. Use released behavior as the compatibility boundary. Distinguish HTTP case-folding from SQS/envelope case sensitivity, list/malformed values, data unwrapping without context, and carrier stripping from context parsing. Do not silently create environment metadata that existing carriers never send.
- [ ] **Step 2: Add a fixture-driven test and literal vectors.** Use independent expected values, including this required privacy case:

```json
{
  "name": "default privacy omits entity id and strips stale HTTP context",
  "carrier": "http",
  "action": "inject",
  "input": {
    "context": { "journeyId": "jrn_123", "entity": { "type": "order", "id": "ORD-42" } },
    "level": "journey-and-type",
    "carrier": { "X-Wayscribe-Entity-Id": "stale", "accept": "application/json" }
  },
  "expected": { "accept": "application/json", "x-wayscribe-journey-id": "jrn_123", "x-wayscribe-entity-type": "order" }
}
```

Cover all three levels and carriers; empty/invalid journey IDs; non-ASCII and control characters; 256/257-character boundaries; malformed optional identity; HTTP mixed case and arrays; SQS data type; unknown fields; stale identity removal; aliases never injected; traceparent preservation; payload pass-through and empty context. Expected output must never be derived by a production helper.
- [ ] **Step 3: Run the focused vectors against released behavior.** This task formalizes existing behavior: new fixtures may pass immediately. Where the documented behavior and implementation differ, report the contradiction and obtain a controller ruling before changing runtime behavior. Any approved behavior repair needs a failing regression first. Run `pnpm exec vitest run packages/sdk-node/src/propagation-vectors.test.ts packages/sdk-node/src/propagation.test.ts packages/sdk-node/src/propagation-recorder.test.ts`.
- [ ] **Step 4: Write the normative specification and reconcile the approved roadmap.** Add ADR-065 recording Python, then Go, then optional OTLP and the approved practical additions. Explain it supersedes the ordering/pilot requirement for Go in ADR-049/059, without rewriting historical rationale. Update current-facing docs and AGENTS consistently. Explain environment isolation enforced by recorder configuration/server contract, because current carriers do not carry an environment field. Remove experimental claims only for behavior now covered by the specification; do not imply unbuilt SDKs or endpoints are shipped.
- [ ] **Step 5: Validate and commit.** Run SDK propagation/vector tests, existing documentation truth/drift checks, SDK typecheck and formatting for changed files. Inspect the final diff for unbuilt claims. Commit only this task's files with `docs(protocol): specify propagation and native SDK roadmap`. Write the task report with commands/results, count of vectors, compatibility decisions and any concerns.
