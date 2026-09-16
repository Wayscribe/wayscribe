/**
 * Protocol limits that code outside the server applies before sending.
 *
 * On their own, with no import, so the Node SDK can take them from here: its
 * bundle inlines what it imports, and the package root would bring Zod with it.
 */

/** The longest `journeyLabel` accepted, in Unicode code points, which is how Zod and Ajv both count. */
export const MAX_JOURNEY_LABEL_LENGTH = 200;
