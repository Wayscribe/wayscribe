/**
 * The operations the server accepts.
 *
 * Duplicated from `@wayscribe/protocol` rather than imported, because
 * that package is private and unpublished — an SDK consumer could not import
 * the union even deliberately. `operations.test.ts` asserts the two lists stay
 * identical, so the copy cannot drift silently.
 *
 * Typing `RecordInput.operation` as a bare `string` meant a plausible verb like
 * "created" compiled cleanly, was refused by the server, and disappeared —
 * leaving a timeline that was not empty but wrong, which is worse.
 */
// debtwatch:start
// id: DEBT-4PM4D3
// owner: wayscribe
// expires: 2027-02-01
// reason: Duplicated from @wayscribe/protocol because that package is private and unpublishable
// tags: sdk, protocol
// debtwatch:end
export const OPERATIONS = [
  "received",
  "identified",
  "transformed",
  "validated",
  "persisted",
  "published",
  "consumed",
  "delivered",
  "failed",
  "retried",
  "completed"
] as const;

export type Operation = (typeof OPERATIONS)[number];
