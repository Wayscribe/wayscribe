# Preserve migration 019's database search path

This bounded repair supports the already authorized launch measurements. The controller reproduced migration 019 failing with PostgreSQL error 42P01 before benchmark ingestion: Knex resolves the private measurement schema, but the dedicated index-build connection resolves `public`.

Migration 019 must use the supplied Knex client's effective search path for concurrent index creation, invalid-index repair and rollback. Preserve its dedicated connections, lock timeout, concurrent writes, cleanup and original-error behavior. Use parameter binding for session configuration rather than interpolating schema identifiers into SQL. A quoted schema name must work. Public-schema objects and pooled session settings must remain unaffected by an isolated-schema migration.

The smallest design captures the pooled connection's `search_path` and applies it to the dedicated connection using parameterized `set_config` before index work. Keep connection settings and password handling unchanged. Inspect the existing implementation and tests before writing the correction; do not turn it into a generic migration framework or copy unrelated session state.

Add real PostgreSQL regression coverage for a quoted non-default schema, valid index creation, invalid-index repair and down/up, with public-schema and pool-setting controls. Inspect later migrations for this same dedicated-client defect and fix only confirmed instances. The existing public-schema lock/concurrency/cleanup tests remain required.

No dependency, application runtime contract, benchmark semantics, schema isolation or public-data guard changes are authorized by this repair. The controller owns fresh measurements after independent review; historical benchmark scale must not be relabeled as newly repeated.
