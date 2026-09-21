# One project-scoped view-only capability

## Scope

ADR-065 approves a small way to share journey status and timelines without an
operator's authority. Add one capability, not users, invitations, email, an
account directory, role hierarchies or enterprise authentication. Existing
admin and ingestion credentials retain their current behavior.

A viewer credential belongs to one project across that project's environments.
It may list its own project, search/list journeys, read a journey's identity,
public label and appropriately masked aliases, and read event timeline rows.
It cannot read individual event details, payloads, diffs, error bodies, replay
destinations/runs, ingestion, deletion, key management or administrative routes.
Known timing fields and the presence of input/output/error remain visible on a
timeline row, as status evidence. Do not add a generic metadata export.

## Credentials and database boundary

Add a dedicated `viewer_keys` table through the next numbered migration. Store
project ID, unique public prefix, name, a peppered verifier and its key ID,
created/revoked/last-used timestamps; never store the plaintext token. Reuse the
existing cryptographic key-generation/verifier primitives and key-rotation
conventions, with an unambiguous viewer prefix. A viewer is not an ingestion key
with a flag that callers can forget to inspect. The native/OTLP authentication
path must refuse it before ingestion.
Use `wsv_` plus 24 random bytes encoded as 32 base64url characters. Its public
lookup prefix has the existing twelve-character length.

Add database CLI commands `viewer:create <project> <name>`, `viewer:list
<project>` and `viewer:revoke <prefix>`, following existing key command patterns.
Creation prints a newly generated token once; listing never prints it. Tokens
are revocable and have no automatic expiry, consistent with existing ingestion
keys. No actual user credential is created by implementation tests. Include
viewer verifiers in key-status/rotation diagnostics and deletion foreign keys.

Extend API Principal with an explicit viewer kind and project scope. Route
authorization checks are the authority; hiding controls in the UI is not one.
A caller-supplied project cannot widen a viewer's scope. Use the existing
not-found behavior for other projects' record IDs. Deny event-detail routes
entirely rather than loading payloads and hoping presentation strips them.
Authentication failures remain indistinguishable, and revocation takes effect
on the next authenticated API request. Use bounded last-used bookkeeping.

## Browser access

The existing login form accepts either an admin token or a viewer token, without
an account or separate login flow. Resolve a viewer through an authenticated
API capability/project response before issuing a session. Never probe a token
by trying a write. A viewer lands in its sole project and cannot use project
selection to switch scope. Show a concise view-only indicator and explain why
payload/replay controls are unavailable.
`GET /v1/access` supplies that response: admin credentials return kind `admin`;
viewer credentials return kind `viewer` and their sole project's ID, name and
slug. It rejects ingestion credentials and never returns a token or verifier.

The viewer credential check adds asynchronous work to login. Preserve bounded
login admission before that await; concurrent guesses must not all pass the
existing lock check while waiting for an API reply. Bound the upstream request
and release any reservation on success, refusal, timeout and cancellation.
Keep the same-origin check before spending login attempts. A temporary API
outage is distinct from an invalid credential and must not mint a session.

Keep existing admin sessions and their historical HKDF signing label compatible.
A viewer session must carry its API credential for server-side reads without
putting a plaintext token in the cookie. Add a versioned authenticated-encryption
cookie envelope using AES-256-GCM and a separate HKDF purpose derived from the
web admin secret, random nonce per cookie, strict bounded decoding, a twelve-hour
expiry and the existing HttpOnly/SameSite/Secure cookie policy. Do not put the
viewer token in URLs, client component props, HTML, diagnostics or browser
storage. Rotation of the admin secret invalidates sessions as it does today.

Replace implicit admin-only read credentials in the web API helpers with an
explicit server-only access union obtained from the verified session. A viewer
request must always call the API with its viewer credential. Missing/malformed
viewer state fails closed; it must never fall back to `ADMIN_TOKEN`. Mutation
helpers and proxy routes require admin access in both runtime guards and types.
Every server page and proxy request uses the same session/access resolution.

Viewer journey pages load only overview/timeline resources. They must not
prefetch event detail, replay, deletion or payload data, including server-side
rendering and background polling. Preserve the existing admin experience and
layout. A revoked viewer session is cleared or redirected to login when the API
refuses it; its cached cookie is not independent authorization.

## Verification

Test mint/list/revoke and verifier rotation using isolated databases. Build a
route permission matrix across viewer/admin/ingest credentials and two projects:
allowed reads, forbidden payload/replay/admin/write routes, cross-project IDs,
query/project overrides, revoked keys and malformed tokens. Inspect complete
responses to prove forbidden data is absent. Include enabled OTLP in the matrix.

Test encrypted cookie tampering, expiry, malformed/oversized input, plaintext
absence and admin-cookie compatibility. Web tests must prove a viewer token is
used on upstream reads, admin credentials are never substituted, and forbidden
SSR/proxy requests do not occur. Finish with browser flows for both roles and
an API-level negative check independent of the UI. Cover project switching and
revocation while a viewer page polls. Document provisioning and restrictions in
the security/API/operations docs and an architecture decision. Public delivery
and GitLab execution remain deferred.
