# Contributing

> **Where to contribute.** Development happens on
> [GitLab](https://gitlab.com/jojithedev/flight-recorder). If you found this on
> GitHub, that is a read-only mirror: it is force-pushed from GitLab on every
> green pipeline, so a pull request opened there cannot be merged and would be
> overwritten. Please open a merge request on GitLab instead.


Flight Recorder is in early development. Contributions should protect the narrow V0 scope and the reliability of applications being observed.

## Before contributing

Read:

- [Product principles and non-negotiables](docs/PRODUCT_PRINCIPLES.md)
- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Agent instructions](AGENTS.md)
- [Decision log](docs/DECISIONS.md)
- [Task list](docs/TASKS.md)

## Scope discipline

V0 is focused on:

- Node.js and TypeScript
- deterministic journey events
- HTTP and queue propagation
- PostgreSQL persistence
- field-level diffs
- development-only HTTP replay

Please do not introduce additional SDK languages, AI features, new storage engines, or production replay without an accepted architecture decision. Kubernetes has one — ADR-042 covers the local-cluster Helm chart, and anything beyond it needs its own.

Contributions must preserve:

- a free and useful self-hosted core
- a lightweight default installation
- a first useful journey in approximately 15 minutes
- clear entity-first terminology
- record-first navigation, identity mapping, transformation diffs, existing-architecture support, and safe development replay

## Development workflow

1. Create a focused branch.
2. Add or update tests.
3. Update affected documentation.
4. Run formatting, linting, type checks, and tests.
5. Open a pull request with a clear explanation of behavior and risk.

## Pull request expectations

A pull request should explain:

- the user or developer problem
- the chosen approach
- changed public contracts
- security implications
- migration requirements
- test coverage
- documentation updates
- intentionally deferred work

## Architecture decisions

Create or update an entry in `docs/DECISIONS.md` when changing:

- technology choices
- package boundaries
- public protocol semantics
- authentication
- encryption
- replay policy
- data retention
- storage strategy
- compatibility guarantees

## Security

Do not submit real customer payloads, credentials, access tokens, or production logs.

Security-sensitive changes require tests for failure and abuse cases, not only valid inputs.

## Compatibility

The public event protocol and SDK are expected to evolve during early development, but breaking changes must be deliberate, documented, and versioned.

## Commit guidance

Prefer concise commits that each preserve a working repository. Examples:

```text
feat(protocol): add journey event schema
feat(api): ingest idempotent event batches
fix(sdk): prevent transport failures from escaping
docs(security): define replay header filtering
test(e2e): cover failed customer sync journey
```
