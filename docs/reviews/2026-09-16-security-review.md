# Pre-release security review, 2026-09-16

A record of the security review done before the first release, kept so that
[the security review packet](../SECURITY_REVIEW.md) can cite it.

## Scope

Every change from `2de5d00` to `4a68a1e`, 149 commits:

- the language-neutral contract and dry-run validation
- SDK payload fitting
- `journeyIdFor`
- displayable aliases and journey labels
- journey browsing (ADR-054)
- migrations 017 to 019
- the authentication throttle and proxy handling
- web Content-Security-Policy and redirect hardening
- the measurement and migrate scripts

Later changes, the secret-name warning (ADR-055) and the SDK API changes
(ADR-056), were reviewed separately before they were merged.

## Method

Reading ADRs 049 to 054, [`docs/SECURITY.md`](../SECURITY.md), the diff and
the code it touches, with reproductions against PostgreSQL 17.

## Result

No Critical, High or Medium findings.

### Low and informational notes

1. ADR-050 overstated what the dry-run preview returns. It returns the whole
   journey as the sending key could already read it. Corrected in `0ad2d2f`.
2. A text search that matches nothing scans the whole window, bounded only by
   the statement timeout. Documented in ADR-054 and
   [OPERATIONS §10](../OPERATIONS.md#listing-journeys).
3. A dry run holds its row locks for the whole batch and has no separate
   limit. Documented in ADR-050 and
   [INGESTION_CONTRACT §8](../INGESTION_CONTRACT.md#8-validating-without-storing).
4. `bearerToken` requires exactly one space between the scheme and the token,
   so an admin token containing a space would fail to authenticate. Not
   exploitable.

### Areas checked and found sound

- Logging of storage errors leaks no payload values, reproduced on three
  ingestion paths.
- Handling of prototype keys such as `__proto__`.
- Scoping of the journey list and of search, and escaping of `q`.
- The invariant that a masked alias has no plain-text copy, enforced by a
  constraint and a trigger.
- Migration 019's dedicated database client.
- The SDK as a supply-chain component: it does not throw into the host, prints
  no key or secret, and shuts down within a bound.
- The authentication throttle and trust of proxy headers.
- Redirects and the Content-Security-Policy.
- The mapping of transport errors to codes.
