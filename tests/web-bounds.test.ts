import { describe, expect, it } from "vitest";
import { MAX_ENTITY_TYPE_LENGTH, MAX_TEXT_LENGTH } from "../apps/web/src/lib/journey-filters.js";
import { MAX_ENTITY_TYPE_LENGTH as PROTOCOL_ENTITY_TYPE_LENGTH } from "../packages/protocol/src/event.js";
import { MAX_JOURNEY_LABEL_LENGTH } from "../packages/protocol/src/limits.js";

/**
 * The Journeys page restates the API's bounds rather than importing them,
 * because the web app depends on no workspace package. These are the numbers
 * it restates.
 */
describe("the bounds the Journeys page restates", () => {
  it("are the protocol's", () => {
    // The API's q bound is the longest label, and its entityType bound the
    // longest type ingestion accepts.
    expect(MAX_TEXT_LENGTH).toBe(MAX_JOURNEY_LABEL_LENGTH);
    expect(MAX_ENTITY_TYPE_LENGTH).toBe(PROTOCOL_ENTITY_TYPE_LENGTH);
  });
});
