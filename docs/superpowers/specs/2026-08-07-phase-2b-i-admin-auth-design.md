# Phase 2b-i: Admin Authentication and Sessions — Design

**Date:** 2026-08-07
**Status:** Approved
**Scope:** The API's admin authentication path with project-wide read scope, and the web
application's session handling. The interface itself is Phase 2b-ii.

## 1. Context

ADR-016 settled that the web interface authenticates against a single admin token, and
deferred the implementation to "Phase 2, with the first data-bearing interface". That
interface is now next, so the auth path has to exist first.

The API today accepts only environment-scoped API keys. The interface needs project-wide
reads: a developer investigating a record should not have to know which environment it
landed in before they can search for it.

This phase is deliberately separated from the interface work. An auth-scope change
reviewed alongside CSS is an auth-scope change that does not get read carefully.

## 2. Two principals

Authentication resolves a request to one of two principals.

| | API key | Admin |
|---|---|---|
| Identifies | One project, one environment | The operator |
| Read scope | That environment only | All environments of a named project |
| Can ingest | Yes | No |
| Source | `api_keys` table | `ADMIN_TOKEN` configuration |

An admin principal cannot ingest. Ingestion writes an event into a specific environment,
and an admin token names no environment; accepting it there would mean guessing.
`POST /v1/events` continues to require an API key.

## 3. Scope widening

Read repositories currently take `{ projectId, environmentId }`. They become
`{ projectId, environmentId? }`.

**Environment absent means every environment of that one project. It never means every
project.** This is the single most dangerous line in the phase: it is a widening that
looks inert in a diff. It is expressed in the type, enforced by the query always
filtering on `project_id`, and asserted directly in tests — including a test that an
admin reading project A sees nothing from project B.

## 4. Project selection

The admin token is a single global secret with no project baked into it, so the caller
names the project it wants.

That is not an escalation: an admin can read any project by definition. But the API
validates the project exists and returns `404` when it does not, rather than returning an
empty result set — an empty list reads as "this record has no events", which is a
different and much more misleading answer than "wrong project".

## 5. Session handling

Login lives in the web application, not the API.

1. The browser posts the admin token to a Next.js route handler.
2. The handler compares it to `ADMIN_TOKEN` in constant time.
3. On success it sets a session cookie: `httpOnly`, `SameSite=Strict`, `Secure` outside
   local development, `Path=/`.
4. Server components read the session, then call the API server-side with the admin
   token.

The browser never receives the admin token and never contacts the API directly. There is
no CORS surface because there are no cross-origin requests.

### Cookie signing

The session cookie is signed with a key derived from `ADMIN_TOKEN` through HKDF-SHA256
with the label `flight-recorder/web-session` — the same derivation pattern the API uses
for its three subkeys.

The web application therefore needs one secret rather than two. Rotating the admin token
invalidates every existing session, which is correct behavior rather than an
inconvenience.

The payload holds the selected project ID and an expiry. It is signed, not encrypted:
nothing in it is secret, and it must be tamper-evident rather than confidential.

## 6. Login attempt limiting

A login endpoint guarding a single global secret invites guessing. Constant-time
comparison prevents timing disclosure but says nothing about volume.

An in-process limiter rejects further attempts after a threshold within a window, then
recovers after a cooldown.

This is deliberately crude. It is per-process rather than distributed, so it would not
survive horizontal scaling. For a self-hosted single-instance tool it closes the obvious
hole, and the alternative — documenting "put this behind a reverse proxy" — is a way of
not solving the problem for exactly the user this product targets.

The limiter counts failures only. A successful login clears the counter, so an operator
who mistypes twice and then succeeds is not penalized.

## 7. Configuration

The web application gains:

```env
ADMIN_TOKEN=<same value the API holds>
API_URL=http://api:8080
```

`ADMIN_TOKEN` must match the API's. The seed already prints one; the quick start will
show both services receiving it.

## 8. Error handling

Login failures return one message regardless of cause, and never reveal whether the
token was close. Session rejection — tampered, expired, or absent — redirects to login
rather than returning an error page, because the only useful action is to log in again.

API-side, an admin token for a nonexistent project returns `404`; a malformed or unknown
bearer token returns `401`, identical to the API-key path.

## 9. Testing

- **API integration:** an admin token is accepted; an API key still works unchanged; an
  admin read spans two environments of one project while an API key sees only its own;
  an admin reading project A sees nothing belonging to project B; an admin token for an
  unknown project returns 404; an admin token is rejected by `POST /v1/events`.
- **Session unit:** a signed cookie round-trips; a tampered payload is rejected; an
  expired session is rejected; a cookie signed with a different admin token is rejected.
- **Login unit:** correct token accepted; wrong token rejected with the same message;
  comparison is constant time; the limiter trips after the threshold and recovers after
  the cooldown; a success clears the failure counter.

## 10. Acceptance criteria

- The API accepts the admin token and grants project-wide, all-environment reads.
- An API key's environment scoping is unchanged.
- No principal can read across projects.
- `POST /v1/events` rejects the admin token.
- The session cookie is httpOnly, signed, and rejected when tampered or expired.
- Repeated failed logins are throttled.
- `pnpm test`, `pnpm test:integration`, and CI pass on a clean clone.

## 11. Not in this phase

Every page of the interface: search, timeline, event detail, and the diff viewer, plus
Playwright coverage. Those are Phase 2b-ii, which consumes this.
