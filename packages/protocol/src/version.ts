export const PROTOCOL_VERSION = "0.1";

const SUPPORTED_VERSIONS = new Set<string>([PROTOCOL_VERSION]);

export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_VERSIONS.has(version);
}
