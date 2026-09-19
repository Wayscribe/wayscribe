import { createHash } from "node:crypto";

const LEGACY_NAME = "demo-integration (corrected)";

const describeUrl = (url) => new URL(url).host;

const nameFor = (url) => {
  const fingerprint = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `demo-integration (${describeUrl(url)} / ${fingerprint})`;
};

const disabled = (destination, url) =>
  new Error(
    `Replay destination "${destination.name}" for ${describeUrl(url)} is disabled. ` +
      "Enable it explicitly or choose a different DEMO_REPLAY_URL."
  );

/**
 * Reuses only recorder-owned, enabled destinations for the exact URL. A
 * disabled destination stops the recording with an actionable error; a
 * same-name destination for another URL stays untouched. The first free
 * deterministic suffix is safe to create under the database's project/name
 * uniqueness constraint.
 */
export function planReplayDestination(destinations, url) {
  const legacy = destinations.find(
    (destination) => destination.name === LEGACY_NAME && destination.baseUrl === url
  );
  if (legacy !== undefined) {
    if (!legacy.enabled) throw disabled(legacy, url);
    return { destinationId: legacy.id, name: legacy.name };
  }

  const baseName = nameFor(url);
  for (let index = 0; index <= destinations.length; index += 1) {
    const name = index === 0 ? baseName : `${baseName} (${String(index + 1)})`;
    const existing = destinations.find((destination) => destination.name === name);
    if (existing === undefined) return { destinationId: undefined, name };
    if (existing.baseUrl === url) {
      if (!existing.enabled) throw disabled(existing, url);
      return { destinationId: existing.id, name };
    }
  }

  throw new Error("No replay destination name was available.");
}
