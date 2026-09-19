# Contributing

> **Where to contribute.** Development happens on
> [GitLab](https://gitlab.com/jojithedev/wayscribe). If you found this on
> GitHub, that is a read-only mirror: GitLab's `main` and tags are force-pushed
> to it once their pipeline has passed, so a pull request opened there cannot be
> merged and would be overwritten. Please open a merge request on GitLab instead.

Wayscribe is in early development. Contributions should protect the narrow V0 scope and the reliability of applications being observed.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Documentation improvements, examples, bug reports, tests, and focused code fixes
are welcome. For questions about using Wayscribe, see [Support](SUPPORT.md).
Discuss substantial features or design changes in a GitLab issue before
implementing them so we can agree on scope. A contribution is reviewed on its
merits and fit with the project; submission does not guarantee acceptance or a
review deadline.

## Contribution terms

Wayscribe uses the [Apache License 2.0](LICENSE). Contributions intentionally
submitted for inclusion are provided under that license, as described in its
section 5. Only submit work you have the right to contribute, and preserve any
required third-party notices and attribution.

There is no separate contributor license agreement (CLA) or mandatory Developer
Certificate of Origin (DCO) sign-off requirement.

AI-assisted contributions are welcome. You are responsible for reviewing and
understanding the submitted work, checking that you have the right to contribute
it, and testing the behavior you change. Explain what you verified and any
limitations; generated output does not replace that responsibility.

## Before contributing

Start with [local development](docs/LOCAL_DEVELOPMENT.md) for setup and commands.
For code or design changes, read the relevant parts of:

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

Please do not introduce additional SDK languages, AI features, new storage engines, or production replay without an accepted architecture decision. Kubernetes has one: ADR-042 covers the local-cluster Helm chart, and anything beyond it needs its own. Python has one too: ADR-059 makes it the next SDK, after the first release, and every other language still waits for a decision of its own.

Contributions must preserve:

- a free and useful self-hosted core
- a lightweight default installation
- a first useful journey in approximately 15 minutes, the target in [product principles](docs/PRODUCT_PRINCIPLES.md) (the demo showed its journey within a minute of a fresh clone, measured on 2026-09-14)
- clear entity-first terminology
- record-first navigation, identity mapping, transformation diffs, existing-architecture support, and safe development replay

## Development workflow

1. Create a focused branch.
2. Add or update tests.
3. Update affected documentation.
4. Run formatting, linting, type checks, and tests.
5. Open a merge request with a clear explanation of behavior and risk.

## Merge request expectations

A merge request should explain:

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
