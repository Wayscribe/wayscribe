# Demo Scenario

## 1. Purpose

The demo is the product acceptance test.

It should prove that Wayscribe can reconstruct a complete entity journey and reveal where a data defect first appeared.

## 2. Services

### `demo-source`

Simulates Salesforce sending an account webhook.

### `demo-integration`

Receives the webhook, transforms the account, writes PostgreSQL, and publishes a message.

### `demo-worker`

Consumes the message and sends the customer to the target API.

This may initially run in the same application repository but should be a distinct process.

### `demo-target`

Simulates HubSpot and rejects customers without a phone number.

### Wayscribe services

- API
- web
- PostgreSQL

## 3. Test customer

```json
{
  "Id": "0018Z00002ABC",
  "Name": "Jorge Polanco",
  "Phone": "+1 919 555 1234",
  "Status__c": "Active"
}
```

Expected internal customer:

```json
{
  "externalId": "0018Z00002ABC",
  "name": "Jorge Polanco",
  "phone": "+1 919 555 1234",
  "status": "active"
}
```

## 4. Intentional defect

The transformation incorrectly reads:

```typescript
phone: account.Phone__c ?? null
```

The incoming payload uses `Phone`, so output becomes:

```json
{
  "phone": null
}
```

## 5. Journey identifiers

Primary entity:

```text
customer:0018Z00002ABC
```

Aliases added later:

```text
salesforceAccountId = 0018Z00002ABC
internalCustomerId = 18492
targetContactId = absent because creation failed
```

## 6. Expected timeline

```text
10:31:02  receive-salesforce-webhook
10:31:04  transform-salesforce-account
10:31:05  persist-customer
10:31:06  publish-customer-updated
10:31:07  consume-customer-updated
10:31:09  deliver-customer-to-target failed
10:31:39  retry-customer-delivery failed
10:32:39  retry-customer-delivery failed
10:34:38  move-message-to-dead-letter
```

## 7. Expected transformation diff

The transformation maps a Salesforce account onto an internal customer, and every
field is renamed in the process. The diff therefore shows the Salesforce fields
leaving and the internal fields arriving:

| Field | Before | After |
|---|---|---|
| `Id` | `"0018Z00002ABC"` | (absent) |
| `Name` | `"Jorge Polanco"` | (absent) |
| `Phone` | `"+1 919 555 1234"` | (absent) |
| `Status__c` | `"Active"` | (absent) |
| `externalId` | (absent) | `"0018Z00002ABC"` |
| `name` | (absent) | `"Jorge Polanco"` |
| `phone` | (absent) | `null` |
| `status` | (absent) | `"active"` |

The defect is visible in the pair of rows for the phone number: `Phone` went in
carrying a value, and `phone` came out `null`. Every other field arrives with its
value intact, which is what makes that pair stand out.

**This replaced an earlier version of this section** that showed `phone` changing
from `"+1 919 555 1234"` to `null` with `name` unchanged, as though input and
output shared field names. That diff is not producible from this step: section 3
defines the input as the Salesforce shape and the output as the internal shape, so
an input-versus-output comparison can only ever report removals and additions.

What the earlier version depicted was *expected output versus actual output*: the
correct internal customer against the defective one. That is the replay comparison
in `REPLAY_SPEC.md` section 11, not the transformation diff. See ADR-030.

## 8. Expected target response

```json
{
  "error": {
    "code": "phone_required",
    "message": "A phone number is required."
  }
}
```

HTTP status:

```text
422
```

## 9. Search acceptance cases

The journey should be found using:

- `0018Z00002ABC`
- `18492`
- journey ID
- queue message ID
- trace ID where present

## 10. Replay acceptance case

After correcting the transformation to:

```typescript
phone: account.Phone ?? null
```

The user replays the original source payload to a development replay endpoint.

Expected replay output:

```json
{
  "externalId": "0018Z00002ABC",
  "name": "Jorge Polanco",
  "phone": "+1 919 555 1234",
  "status": "active"
}
```

The comparison shows that the phone number is preserved.

## 11. Automated E2E test

The test should:

1. start the full Compose stack
2. wait for readiness
3. trigger the source webhook
4. poll for journey completion or failure
5. search by Salesforce ID
6. verify the event count and order
7. verify the phone diff
8. verify target rejection
9. verify retry events
10. invoke replay against corrected endpoint
11. verify replay result
12. verify replay audit event

## 12. Demo command goal

The final developer experience should approach:

```bash
docker compose -f infrastructure/compose.yaml \
  -f infrastructure/compose.demo.yaml up --build

pnpm demo:trigger
```

Then open the web UI and search:

```text
0018Z00002ABC
```

## 13. Other failure shapes

The defect above is the demo's story, and the reference journey (and the public demo's
pinned `+1 555 0100` journey) always fail that way. A demo whose every failure is that one
journey reads as canned, so the public demo's loop and its generated history also fail in
other ways a Salesforce-to-target sync really does. One definition,
`apps/demo/src/failures.ts`, drives the loop, the worker, the target and the history.

| Shape | Share of failures | What goes wrong | Events | Ends at |
|---|---|---|---|---|
| `dead-letter` | 40% | the defect: `phone_required` on all three attempts | 10 | `move-message-to-dead-letter` |
| `schema-rejected` | 20% | `Status__c` is `Former Customer`, which the target's `status` enum refuses with 422 `invalid_property_value`; the worker does not retry it | 7 | `deliver-customer-to-target` |
| `timeout` | 15% | the target is slow for the account, every attempt times out after 6 seconds, the worker backs off 4, 8 and 16 seconds, and the queue dead-letters it | 10 | `move-message-to-dead-letter` |
| `transform-failed` | 15% | the webhook arrives without `Status__c`, and the transformation throws | 2 | `transform-salesforce-account` |
| `persist-failed` | 10% | the webhook arrives without `Name`, and the insert breaks `name not null` | 3 | `persist-customer` |

The worker gives up at once only on a target error it knows no retry can change
(`invalid_property_value`). It still retries `phone_required`, which is the second half of
the defect: three attempts at a payload that could never succeed.

`POST /trigger` takes a `shape` field naming one of these, and the end-to-end test
triggers each.
