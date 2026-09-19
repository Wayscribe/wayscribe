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

const candidateRank = (name, baseName) => {
  if (name === LEGACY_NAME) return 0;
  if (name === baseName) return 1;
  if (!name.startsWith(baseName)) return undefined;
  const match = name.slice(baseName.length).match(/^ \(([0-9]+)\)$/);
  if (match === null) return undefined;
  const rank = Number(match[1]);
  return Number.isSafeInteger(rank) && rank >= 2 && String(rank) === match[1] ? rank : undefined;
};

/**
 * Reuses only recorder-owned, enabled destinations for the exact URL. A
 * disabled destination stops the recording with an actionable error; a
 * same-name destination for another URL stays untouched. The first free
 * deterministic suffix is safe to create under the database's project/name
 * uniqueness constraint.
 */
export function planReplayDestination(destinations, url) {
  const baseName = nameFor(url);
  const exact = destinations
    .map((destination) => ({ destination, rank: candidateRank(destination.name, baseName) }))
    .filter(({ destination, rank }) => rank !== undefined && destination.baseUrl === url)
    .sort((left, right) => left.rank - right.rank);
  const disabledExact = exact.find(({ destination }) => !destination.enabled);
  if (disabledExact !== undefined) throw disabled(disabledExact.destination, url);
  const enabledExact = exact.at(0);
  if (enabledExact !== undefined) {
    return {
      destinationId: enabledExact.destination.id,
      name: enabledExact.destination.name
    };
  }

  for (let index = 0; index <= destinations.length; index += 1) {
    const name = index === 0 ? baseName : `${baseName} (${String(index + 1)})`;
    const existing = destinations.find((destination) => destination.name === name);
    if (existing === undefined) return { destinationId: undefined, name };
  }

  throw new Error("No replay destination name was available.");
}
