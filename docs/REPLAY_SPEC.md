# Replay Specification

> **Written before implementation, and kept as the original plan.**
>
> Where this and [the decision log](DECISIONS.md) disagree, the decision log
> wins. That is the precedence `AGENTS.md` already sets, and it records what
> was actually built, including the decisions that reversed something here.
>
> Where this and the built server disagree, the section says so in place rather
> than being quietly rewritten. For the replay request and its response,
> [the API specification](API_SPEC.md) is normative.

## 1. Purpose

Replay helps a developer rerun a historical input against current development code and compare the new result with the original result.

V0 replay is a debugging laboratory, not a production recovery mechanism.

## 2. Core use case

A transformation defect changed a valid phone number to `null`.

After fixing the code, the developer selects the original input and replays it to a local or development endpoint.

Wayscribe shows:

- original input
- original output
- replay input
- replay output
- original error
- replay response
- structural differences

## 3. V0 goals

- make historical inputs reusable for debugging
- allow payload review and editing; **narrowed by ADR-032: V0 reviews but does not
  edit.** The prepare screen shows exactly what will be sent; changing it before sending
  moves to V1.
- restrict targets to approved development destinations
- remove unsafe headers
- record an audit history
- compare results deterministically

## 4. V0 non-goals

- production replay
- replay directly to payment providers
- automatic retry of failed business operations
- queue reinsertion into production
- replay with captured production credentials
- bulk replay
- scheduled replay
- side-effect simulation across every dependency

## 5. Replay destination

A destination includes:

```typescript
interface ReplayDestination {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  environmentType: "local" | "development" | "test";
  enabled: boolean;
}
```

The server validates the resolved destination against configured host policy.

The draft of this section carried an `encryptedHeaders` field on the type. The
destination's configured headers are real, and they are encrypted at rest
(ADR-040), but they are not part of this shape: the row stores them as one
encrypted string, and neither the read of a single destination nor the list
returns it. A caller that is about to send a request asks for them explicitly,
so a credential cannot reach a list response by accident.

## 6. Replay request

What `POST /v1/replays` accepts:

```typescript
interface CreateReplayRequest {
  eventId: string;
  destinationId: string;
  method?: "POST" | "PUT" | "PATCH";
  path: string;
}
```

`method` is `POST` when omitted. `path` is appended to the destination's base
URL. The body sent to the destination is the recorded event's stored input,
exactly as it was captured, and the headers are the destination's own plus the
three Wayscribe sets (section 8). Nothing about the request is chosen by the
caller except where it goes.

An earlier draft of this section put `payload` and `headers` on the request, so
that a caller could supply its own. V0 deliberately accepts neither, and the
server has never read them. Replay sends what was recorded, which is what makes
the result evidence about the recorded failure rather than about a body
somebody typed. Reviewing the payload without editing it is ADR-032, and it is
why the prepare screen shows exactly what will be sent. Caller-supplied
payloads are V1 work, and the field comes back with them.

Unknown keys in the body are ignored rather than refused. The parser reads the
four fields above and nothing else, so an extra key, a leftover `payload` or
`headers`, or a misspelling of an optional field, all produce an ordinary
replay with no sign that anything was dropped. Do not read this as symmetry
with ingestion: ingestion also accepts and drops unknown fields, but there it
is a decided rule with a compatibility promise behind it (ADR-049), and here it
is only what the parser happens to do. A misspelled *required* field is still
refused, because the field it was meant to be is then missing.

GET replay is excluded initially because payload-oriented debugging is the primary use case.

## 7. Safety checks

Before sending:

1. authenticate the user or local actor
2. verify the event belongs to the project
3. verify destination is enabled
4. verify destination is development-like
5. resolve and validate final URL
6. block redirects outside allowed hosts
7. remove blocked headers
8. validate request size
9. apply redaction and capture policy
10. create audit event
11. send with strict timeout
12. limit response size
13. sanitize stored response

Three of these are not things a replay does. Steps 8 and 9 happen at ingestion:
a payload's size is bounded and the redaction and capture policy applied before
it is ever stored, so what replay sends is already bounded and already
redacted, and there is no second pass at send time. Step 4 is settled when the
destination is created, because `environmentType` can only be `local`,
`development` or `test` and no value of it means production. The rest is what
the route does, in about this order, and the audit row of step 10 is written
before the request is made so that a refusal still leaves one.

## 8. Header policy

Always block historical:

- authorization
- proxy-authorization
- cookie
- set-cookie
- x-api-key
- cloud-provider session tokens
- webhook signatures
- payment-provider signatures

Allow safe headers such as:

- content-type
- accept
- user-agent generated by Wayscribe
- destination-specific test secret configured separately

V0 never sends a recorded header at all, so the block list above is not a
filter that runs on each replay. The route builds the outgoing headers from the
destination's configured ones plus `content-type`, `user-agent` and
`x-wayscribe-replay`, and offers the policy no caller headers and no historical
ones; the list is what would be stripped if a header from the original request
were ever offered to it. `SECURITY.md` section 9 holds the exact names, and a
test holds that list to the code.

What a run records is not what it sends. The request carries every header's
real value. The run row, and `GET /v1/replays/:replayId`, carry every header by
name, with the value `[REDACTED]` for each header the destination configured
and for any blocked name. Destination headers are encrypted at rest because they
are credentials; a plain copy in each run would undo that. The result screen
lists the headers and states that a redacted value was sent with its real value.

A destination that echoes its request would return those values. Before the
response body and any error message are stored, each destination header value
of at least 8 characters is replaced with `[REDACTED]` wherever it occurs
exactly: within the strings of a JSON body, and in a text body. A shorter value
is not replaced, and neither is a fragment of one left where the response size
cap cut the body.

## 9. Redirect policy

Default:

- do not follow redirects

A future option may allow redirects only when every resolved host remains allowlisted.

## 10. Network policy

The application should protect against server-side request forgery.

At minimum:

- validate scheme
- block unsupported schemes
- resolve host before request
- restrict allowed hostnames
- consider blocking private network ranges unless explicitly configured
- revalidate after DNS resolution
- use short connection and request timeouts

Local development needs intentional support for names such as:

- `localhost`
- `host.docker.internal`
- Compose service names

## 11. Result comparison

Compare:

- original event output
- replay response body
- original error
- replay status
- structural field changes

Comparison should not claim semantic correctness. It presents evidence.

## 12. Audit record

Every attempt records:

- actor
- source event
- destination
- method and path
- sanitized request, with header names but never destination header values
  (section 8)
- sanitized response
- timestamps
- duration
- status
- blocked reason where applicable

## 13. User interface flow

1. Select an event with captured input.
2. Click **Prepare replay**.
3. Choose destination.
4. Review payload.
5. Review safe headers.
6. Confirm that destination is non-production.
7. Send.
8. View response and diff.

Avoid one-click replay from the timeline.

The screen built to this flow differs in two places. It states the header
policy in a sentence rather than listing the headers before sending (step 5);
the headers actually sent, with every credential value shown as `[REDACTED]`,
are on the result. And there is no separate non-production confirmation
(step 6), because the destination list only ever holds local, development and
test destinations, so there is nothing for the operator to confirm that the
schema has not already settled. Step 2 is a link reading "Replay this input",
not a button, for the reason the line above gives.

## 14. Future replay modes

Potential later modes:

- dry-run transformation function
- external side effects mocked
- queue replay to an isolated sandbox
- approved production replay
- two-person approval
- bulk migration validation

None should change the V0 safety contract.
