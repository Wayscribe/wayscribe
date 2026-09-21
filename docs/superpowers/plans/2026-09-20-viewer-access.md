# Project viewer access implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator share one project's journey status and timelines without sharing payload, replay, deletion or administrative authority.

**Architecture:** A separate revocable viewer credential authenticates to an explicit API principal. The web carries that credential only inside an authenticated-encrypted server cookie and uses it on upstream reads. The API enforces scope and permissions independently of the UI.

**Tech Stack:** Existing PostgreSQL/Knex, payload-security keyring primitives, Fastify, Next.js, Node crypto, Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-20-viewer-access-design.md`.

## Global Constraints

- Local work only; no GitLab usage, push, publication, deployment, account changes or actual user credential provisioning. Tests use synthetic keys and isolated owned resources.
- One project-scoped capability across that project's environments. No accounts, invitations, emails, role hierarchy or enterprise authentication.
- Allowed: own project, search/journey lists, journey identity/public labels/masked aliases, timeline rows and known timing/payload-presence fields.
- Forbidden: individual event details, payloads, diffs, error bodies, replay destinations/runs, ingestion, deletion, key management and administrative routes.
- Existing admin and ingestion credentials retain their behavior. A viewer is a distinct credential/principal, never an ingestion key with an optional flag.
- Store only a peppered verifier, key ID and public prefix, never plaintext. Revoke immediately on the next authenticated API request. Listing never reveals the token.
- Route authorization is authoritative. Caller-supplied project/query values cannot widen scope; another project's record IDs retain not-found behavior.
- Preserve historical admin-session signing format/HKDF label. Viewer cookies use versioned AES-256-GCM, a separate HKDF purpose, random nonce, strict bounded decoding and twelve-hour expiry.
- No viewer credential in URLs, HTML, client props, diagnostics or browser storage. Missing/malformed viewer state fails closed and never falls back to ADMIN_TOKEN.
- Preserve same-origin checks and bounded login admission before asynchronous credential verification. An API outage is not an invalid credential and cannot mint a session.
- Viewer SSR/polling must not fetch forbidden detail/replay/payload data. A revoked session is cleared or redirected when upstream authentication fails.

## File and interface map

Task 1 owns database keys and API permissions. Task 2 adds cookie/access primitives and asynchronous login reservation without exposing viewer login yet. Task 3 wires the web end to end and tests both roles. Shared web files are changed serially. Existing references are `apps/api/src/{auth,principal}.ts`, `routes/{projects,queries,present,replays,events,deletions}.ts`, database key-admin/key lookup/rotation repositories, web `session.ts`, `request-session.ts`, `current-project.ts`, `api.ts`, `login-limiter.ts`, and authenticated pages/proxies. The current last migration is 021; use `022_viewer_keys.js` unless a prior approved task has added a migration before dispatch.

### Task 1: Viewer credentials and API authorization

**Files:**
- Create `packages/database/migrations/022_viewer_keys.js`, `src/repositories/{viewer-keys,viewer-key-admin}.ts` and focused unit/integration tests.
- Modify database exports, CLI registry/parser/test maps/scripts, rotation/unreadable-key reporting and backup verification table/key accounting if already implemented.
- Add a focused viewer token issuer using existing payload-security verifier primitives and tests; no replacement cryptographic algorithm.
- Create `apps/api/src/viewer-auth.ts`, `routes/access.ts`, and viewer auth/permission integration tests. Modify principal resolution and allowed read routes, app registration and API documentation/ADR.

**Interfaces:**
- Viewer tokens use `wsv_` plus 24 random bytes encoded base64url, 36 characters total. The public prefix is the existing 12-character lookup length. `apiKeyRecordFor` and `verifyApiKeyWithKeyring` may verify the separate token/table; the distinct prefix and table prevent conflating scopes.
- `ViewerKeyContext` contains id, projectId, keyHash, keyHashKeyId and revokedAt; it has no environment grant.
- Database operations issue/list/revoke/find-by-prefix/touch/conditionally-replace-verifier with explicit project scoping and existing audit conventions.
- Principal adds `{ kind: "viewer", context: ViewerKeyContext }`; its project is context.projectId and its environment scope is project-wide.
- `GET /v1/access` accepts admin or viewer and returns `{ data: { kind: "admin" } }` or `{ data: { kind: "viewer", project: { id, name, slug } } }`. Invalid/revoked/ingestion credentials get the same 401. This endpoint performs no writes beyond bounded key-use/verifier bookkeeping and returns no token/verifier.

- [ ] **Step 1: Write isolated credential tests and observe RED.** Mint a synthetic key and verify shape/entropy length, prefix lookup, no plaintext database storage, one-time issuance, list redaction, revocation, unknown prefixes and previous/current key migration. Assert the database table has a project FK with cascading deletion, unique key prefix and bounded name. CLI commands are `viewer:create <project-slug> <name>`, `viewer:list <project-slug>` and `viewer:revoke <prefix>`; help executes before environment access. Follow existing parsing/audit/output patterns and expand exhaustive CLI registry maps.

```ts
const issued = await issueViewerKey(db, keyring, projectId, "reviewer");
expect(issued.token).toMatch(/^wsv_[A-Za-z0-9_-]{32}$/);
expect(JSON.stringify(await listViewerKeys(db, projectId))).not.toContain(issued.token);
await revokeViewerKey(db, issued.keyPrefix);
expect(await authenticateViewer(issued.token, authenticator)).toBeUndefined();
```

- [ ] **Step 2: Implement key storage, verification and rotation accounting.** Reuse strong random bytes and current HMAC/keyring verification; do not store the token. Authenticate by exact prefix/format, revoked check and verifier. Migrate previous-key verifiers conditionally on the expected hash, as ingestion keys do, with safe errors. Bound last-used bookkeeping without a permanently growing map. Include viewers separately in rotation status and missing-key diagnostics, preserving existing ingestion-key fields/behavior; add counts to backup verification without exposing hashes. Do not rewrite HMAC verifiers in a re-encryption job that lacks plaintext credentials.

- [ ] **Step 3: Add the permission matrix before route changes.** Seed two projects, multiple environments, non-displayable aliases, distinct payload/error/replay sentinels and all credential kinds. Assert viewer access to its sole project/search/journeys/timeline, refusal on every forbidden route including native/OTLP/dry-run ingestion, and no widening via project headers/query overrides/cross-project IDs/cursors. Check complete response bodies and forbidden repository call counts, not just status codes. Existing admin/ingestion read and write behavior must remain covered.

- [ ] **Step 4: Implement explicit route authorization.** Add access resolution and allow viewer project listing to return only its project. Resolve a viewer's project exclusively from its key; never apply admin-only project fallback. Refuse event-detail requests before invoking findEventDetail and preserve existing admin-only replay/deletion guards. Reuse journey alias masking. Present viewer timeline rows with an explicit list of approved existing fields, known timing keys and payload/error presence; never spread arbitrary metadata or load payload rows merely to redact them. Native and OTLP key authentication remains separate and refuses viewer tokens. Add an ADR and API permission table.

- [ ] **Step 5: Validate and commit.** Run credential/migration/rotation/CLI tests and database-backed permission matrix, plus existing API-key/admin auth and project isolation regressions. Run database/API typechecks and changed-file lint/format. Keep actual commands and outputs in the report, including up/down migration evidence on an isolated database. Commit `feat(api): add project-scoped viewer credentials`.

### Task 2: Compatible encrypted sessions and bounded asynchronous login admission

**Files:**
- Create `apps/web/src/lib/viewer-session.ts` and tests; extend `session.ts` with a unified verifier while preserving signSession/verifySession admin behavior.
- Create `apps/web/src/lib/access.ts` for server-only access types/guards and focused tests.
- Modify `apps/web/src/lib/{login-limiter,login-limiter.test}.ts` and its existing heap/lifecycle tests where necessary.

**Interfaces:**
```ts
export type SessionAccess =
  | { kind: "admin"; projectId: string }
  | { kind: "viewer"; projectId: string; credential: string };
export interface VerifiedAccessSession {
  access: SessionAccess;
  expiresAt: number;
}
// Existing admin signed cookies normalize to kind:admin.
verifyAccessSession(adminToken: string, cookie: string, now: number): VerifiedAccessSession | null;
sealViewerSession(adminToken: string, payload: { projectId: string; credential: string; expiresAt: number }): string;
```

- [ ] **Step 1: Write literal cookie regressions and observe RED.** Existing admin signed cookie fixtures must still verify under the historical `flight-recorder/web-session` label. Viewer cookies must not reveal a distinctive plaintext token, two encodings of identical payload must differ, and wrong secret/tampered tag/nonce/ciphertext/version/project/expiry/malformed base64url must fail. Cap total cookie input before decoding; refuse oversized/extra-field/invalid typed viewer payloads, invalid project/token shape and unreasonable future expiry. No failed viewer parse can fall back to an admin payload.

- [ ] **Step 2: Implement authenticated encryption and access guards.** Derive 32 bytes under a new documented HKDF purpose such as `wayscribe/web-viewer-session/v1`; use a 12-byte random nonce and 16-byte GCM tag, bind the envelope version as authenticated data, and authenticate before JSON parsing. Keep the plaintext token only in the verified server-side access object. Existing admin exports remain usable until Task 3 migrates call sites. A runtime require-admin guard accompanies the discriminated type; types alone do not authorize requests.

- [ ] **Step 3: Reserve login attempts before asynchronous work.** Extend LoginLimiter with a synchronous reservation returning an idempotent completion closure for success/failure/unavailable. Pending attempts count against the existing per-address allowance, cannot be evicted to bypass the limit, and remain bounded globally. Release exactly once; unavailable/timeout does not count as a wrong credential, while refusal does. Preserve same-origin checking order at call sites in Task 3. Avoid persistent Map iterators across mutation: this limiter's comments document a measured V8 retention issue. Test concurrent reservations, timeout/refusal/success races, success with other attempts pending, capacity pressure and address expiry with literal fake time.

- [ ] **Step 4: Validate and commit.** Run cookie/access/limiter tests and existing admin session plus limiter heap tests affected by the change, web typecheck and changed-file lint/format. Do not enable viewer login until Task 3 passes viewer credentials through every upstream read. Commit `feat(web): add encrypted viewer session primitives`.

### Task 3: Viewer web flow without elevated upstream requests

**Files:**
- Modify `apps/web/src/lib/{api,request-session,current-project}.ts` and all direct callers/tests.
- Modify login, select-project, events/timeline, replay and delete proxy routes and tests; authenticated layout/search/journeys/recent/project and detail/replay/delete pages.
- Modify SiteNav/JourneyTimeline/TimelineList and only related components necessary for a view-only journey; keep existing styling/layout.
- Add `apps/web/e2e/viewer.spec.ts`; update user/API/security/operations docs and local browser-test setup as needed.

**Interfaces:**
- Read helpers require an explicit SessionAccess; admin-only helpers accept/guard admin access. No default argument or fallback supplies ADMIN_TOKEN for a viewer.
- Server session resolution returns the verified access object. Only role booleans/project display data cross into client components, never the credential or full access object.
- Upstream viewer 401/revocation raises a dedicated authentication-expired outcome, distinguished from API unavailability; page/proxy handling clears/redirects without switching credentials.

- [ ] **Step 1: Add upstream-credential tests and observe RED.** Given a viewer cookie, mock only the API boundary and assert every allowed fetch bears that exact viewer token. Assert malformed cookies, missing viewer credential and project-switch attempts never make an admin fetch. Viewer SSR and selected-event URLs must not call getEvent or replay/detail/delete helpers. Direct forbidden proxy calls fail even if the UI is bypassed. Keep existing admin behaviors as explicit cases.

- [ ] **Step 2: Wire login and session resolution.** Keep constant-time local admin verification and compatible signed admin cookies. For viewer candidates, reserve login admission synchronously before awaiting a bounded, non-redirecting GET /v1/access request with the presented credential. Strictly validate its viewer response and sole project, then mint a twelve-hour encrypted cookie with existing HttpOnly/SameSite/Secure/path settings. Invalid credentials, timeout/outage and malformed upstream response cannot mint a session. Use try/finally reservation settlement. Never log the form token, forward it to an arbitrary URL, or put it in a redirect.

- [ ] **Step 3: Migrate all upstream helpers and page/proxy paths.** Replace implicit admin credential selection with the access union in get/post/delete helpers and all call sites. Mutation helpers reject viewer access before fetch. Viewer project selection stays fixed; no crafted selector request can re-sign an admin cookie. Viewer journey pages request only journey overview and timeline, render a concise view-only explanation, and disable detail selection/prefetch/payload/replay/deletion actions without hiding required status/timing evidence. Polling uses the same viewer access; revocation redirects to login. Preserve admin payload/diff/replay experience.

- [ ] **Step 4: Run real browser and independent API checks.** Start an owned local test API/web/database using synthetic admin/ingest/viewer keys, no existing live stack. Exercise viewer login, search by alias, timeline paging/live polling, forbidden direct URLs/project switching, revocation while polling and admin login/detail/replay controls. Inspect response/HTML/client-prop bodies for token/payload/error sentinels, including server rendering. Make independent API requests with the viewer token to prove the UI is not the authorization boundary. Include no-JavaScript initial navigation and failure messaging where existing forms support it.

- [ ] **Step 5: Document, validate and commit.** Document one-time credential issuance, listing/revocation, all-environment project scope, explicit data restrictions, key rotation, cookie secret rotation and distinction from ingestion keys. Run affected web unit tests, web/API typechecks, build and focused Playwright role flows; apply the repository's existing browser and React verification guidance where relevant. Report unrun platform/deployment checks honestly. Commit `feat(web): support project viewer journeys`.

## Plan self-review

Task 1 can be used directly through the API and CLI; Task 2's cryptographic and admission primitives are independently testable without enabling a half-migrated login path. Task 3 makes access explicit everywhere before exposing viewer sessions. API permission tests and browser tests independently enforce the same capability. The existing admin format, old ingestion-key behavior, source-controlled migration sequence and operator-only publication boundary remain explicit.
