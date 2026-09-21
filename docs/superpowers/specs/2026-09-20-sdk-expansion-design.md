# SDK expansion and practical self-hosting improvements

## Authorization and sequence

Jorge approved this program on September 20, 2026: Python SDK, native Go
SDK/module, then optional OTLP log ingestion. He also approved the proposed
mixed-language example, setup/redaction checks, backup/restore helpers,
per-project ingestion limits, and a small project-scoped view-only capability.
Implementation and validation proceed locally. GitLab-dependent work and
publication remain deferred because the usage allowance is exhausted.

This is a program of independently reviewable changes. Each subsystem gets
its own implementation plan before implementation. No version is republished,
no existing release tag moves, and no CI pipeline is started by this program.

## Product boundaries

The existing SDK_SPEC.md, EVENT_PROTOCOL.md and INGESTION_CONTRACT.md remain
the authority for native recorders. A second language does not relax privacy,
failure isolation, bounded buffering, stable retry IDs, or shutdown accounting.
Native SDKs send directly to the existing event API and never depend on OTLP.
PostgreSQL stays the only required data store. Extra frameworks and cloud
services stay optional. Full payload capture remains an explicit opt-in.

## Deliverables

1. Publish a normative propagation specification and language-neutral vectors
   covering the existing HTTP, SQS and payload carriers. Run the Node recorder
   against those vectors before using them for Python or Go. Document the
   three privacy levels, carrier replacement, malformed inputs, value grammar,
   and environment-boundary responsibilities. Preserve the released wire names.
2. Build a Python recorder with synchronous and asynchronous wrappers, bounded
   background delivery, capture/redaction, aliases, diagnostic counters,
   timing metadata, propagation, graceful shutdown and package documentation.
   Drive applicable SDK fixtures against captured request bodies and validate
   those bytes through the actual local API dry run. Record every fixture skip
   with its language-specific reason. Add a real Python workflow integration.
3. Build the corresponding native Go module with idiomatic context use,
   concurrency safety, cancellation-aware transport, race tests, the same
   wire/propagation vectors, and documented packaging. Framework integrations
   consume the public API rather than becoming required dependencies.
4. Exercise a Node → Python → Go workflow with one journey, an alias,
   transformation evidence, a retry/failure and HTTP/queue-style propagation.
   Add an explicit setup check/redaction preview built on the dry-run contract.
   The preview must explain what the server would store, mask secret output,
   and never silently record real journey events. Existing doctor remains the
   installation preflight.
5. Add optional OTLP logs over HTTP at /v1/logs, disabled by default. Support
   binary and JSON Protobuf, map an explicit wayscribe attribute vocabulary,
   reuse authoritative authentication/redaction/idempotent ingestion, bound
   parsing/decompression, and implement OTLP success/partial-success/failure
   responses. Verify interoperability with a real Collector or exporter.
   Traces, metrics and gRPC are separate future work.
6. Add small backup/restore helpers around PostgreSQL tools, scoped to an
   operator-selected database. Explain separate key custody. Restore exercises
   must use a newly created isolated database; never overwrite an existing
   user database. Verify schema, representative reads and encrypted identifiers.
7. Add configurable per-project ingestion controls shared by native and OTLP
   paths, bounded bookkeeping, honest process/replica scope, clear retry advice
   and counters. They must not introduce a broker, store, hosted service or
   billing system. Final algorithm/defaults belong to that subsystem's plan.
8. Add one project-scoped view-only capability for journey status/timelines.
   Server enforcement excludes payload access, replay, deletion and admin
   actions. Authentication is explicit and fail-closed; the capability never
   borrows an ingest key's authority. No account directory or role hierarchy.

## Validation and release boundaries

Use focused behavior tests during implementation, task review at each boundary,
then the appropriate integration suites and final branch review. Native SDKs
must pass cross-language fixtures and transport failure tests, not just produce
one successful event. Resource and permission changes require negative tests.
Local package builds may be prepared; registry/account actions and deployment
wait for the existing deferred delivery work. Human onboarding/pilot evidence
remains distinct from automated checks.

## Current working constraints

Use the isolated codex/sdk-expansion worktree. Available disk is approximately
2 GiB; reuse installed tools/caches and remove only generated resources owned by
this work. Do not prune other projects' containers, volumes, images or caches.
Commit locally in reviewable units. Keep progress and review evidence in the
plan's ignored SDD workspace so interrupted work can resume.
