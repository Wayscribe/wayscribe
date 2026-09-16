# Secret-looking names that no rule covers: plan

Design: [`../specs/2026-09-16-secret-name-warning-design.md`](../specs/2026-09-16-secret-name-warning-design.md).

Each task is test-first: write the failing test, watch it fail for the right
reason, implement, run the package's tests and the repository gate
(`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`), self-review
the diff, commit. Integration tests run at the end of the task that touches the
database. No identifier carries the product name. No em dashes in docs.

## Task 1: the heuristic

Files: `packages/payload-security/src/secret-name.ts` (new),
`secret-name.test.ts` (new), `redaction.ts`, `index.ts`.

1. Table test: at least 40 true positives and 40 false positives from Stripe,
   Salesforce, HubSpot, GitHub, AWS, OAuth and Slack, each with its source;
   every built-in name is accepted; case and separator variants agree; the
   version suffix is dropped; a 10,000 character name is answered (linear).
2. Implement the folded suffix table with exceptions and qualified short terms.

## Task 2: the walk reports kept secret-looking scalars

Files: `packages/payload-security/src/redact.ts`, `redact.test.ts`.

1. Tests: a kept `sessionCredential` string is reported with its path; array
   indices are `[*]`; objects, booleans, null, empty strings and the marker are
   not reported; a built-in name in every spelling is never reported; a
   configured `**.name` is never reported; a scoped rule suppresses only where
   it applies; names inside a `Map` are reported; the result without an
   observer is identical to the result with one; an observer that throws
   propagates to the caller (the SDK guards it).
2. Implement with a segment stack, joined only when reporting.

## Task 3: the SDK warning and `knownSafeNames`

Files: `packages/sdk-node/src/diagnostics.ts`, `config.ts`, `recorder.ts`,
`index.ts`, `secret-name-warning.test.ts` (new), `config.test.ts`.

1. Tests: the diagnostic kind, detail and reason, never the value; once per
   recorder per folded name; printed once per process with `logDiagnostics`
   off and on; a second recorder does not print again; the counter; metadata is
   covered; `knownSafeNames` quiets it and does not stop redaction; a bad
   `knownSafeNames` entry is a `configuration_error`; the event is sent
   unchanged; a throwing `onDiagnostic` changes nothing; 100-name cap.
2. Implement.
3. Measure capture cost before and after on a realistic payload
   (`bench/secret-names.mjs`, not part of `pnpm test`).

## Task 4: conformance

Files: `packages/protocol/src/conformance.ts`,
`packages/protocol/conformance/sdk/unredacted-secret-name.json`, the manifest,
`packages/sdk-node/src/conformance-harness.ts`, `conformance.test.ts`,
`docs/INGESTION_CONTRACT.md` section 9.

1. `expect.diagnostics` in the schema; the harness collects diagnostics; the
   SDK test compares them; the case; the manifest.

## Task 5: the doctor check

Files: `packages/database/src/secret-names.ts` (new), `doctor.ts`,
`doctor.test.ts`, `secret-names.integration.test.ts` (new).

1. Unit tests on the result formatting: pass, warn with counts, the cap on
   names printed, long names cut, names the heuristic rejects are not printed.
2. Integration test on a seeded database: stored unredacted `authToken` and
   `sessionCredential` are reported with counts and no value appears in the
   output; `[REDACTED]` values, objects and booleans are not; the sample bound
   holds; the statement timeout applies.
3. `EXPLAIN (ANALYZE, BUFFERS)` on a larger seeded database, recorded in
   OPERATIONS.md.

## Task 6: documents

ADR-055 and the README count; SDK_SPEC SDK-61, SDK-62 and SDK-40; SECURITY.md
section 4; OPERATIONS.md §12; the SDK README; NODE_SDK_SPEC.md; CHANGELOG.

## Task 7: verification

The full gate, `pnpm test:integration`, gitleaks, the bundle test, and a live
stack from this worktree under its own Compose project name on free ports: an
SDK script sends `sessionCredential` and `authToken`, the warning prints once
each without the value, and doctor reports both from stored payloads. `down -v`
afterwards.
