# Demo Scenario

## 1. Purpose

The demo is the product acceptance test.

It should prove that Flight Recorder can reconstruct a complete entity journey and reveal where a data defect first appeared.

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

### Flight Recorder services

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

```diff
{
  "name": "Jorge Polanco",
- "phone": "+1 919 555 1234",
+ "phone": null,
- "status": "Active",
+ "status": "active"
}
```

The status change is valid. The phone change is the defect.

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
