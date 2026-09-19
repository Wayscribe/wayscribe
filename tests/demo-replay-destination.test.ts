import { describe, expect, it } from "vitest";
import { planReplayDestination } from "../scripts/demo-replay-destination.mjs";

const DEFAULT_URL = "http://demo-integration:3200";
const HOST_URL = "http://127.0.0.1:3200";
const HOST_NAME = "demo-integration (127.0.0.1:3200 / 8cc359aea794)";
const HOST_NAME_3 = `${HOST_NAME} (3)`;

describe("planReplayDestination", () => {
  it("uses a URL-specific name when a reused project already has the legacy Compose destination", () => {
    expect(
      planReplayDestination(
        [
          {
            id: "compose-destination",
            name: "demo-integration (corrected)",
            baseUrl: DEFAULT_URL,
            enabled: true
          }
        ],
        HOST_URL
      )
    ).toEqual({ destinationId: undefined, name: HOST_NAME });
  });

  it("refuses to bypass a disabled URL-specific recorder destination", () => {
    expect(() =>
      planReplayDestination(
        [
          {
            id: "disabled-host-destination",
            name: HOST_NAME,
            baseUrl: HOST_URL,
            enabled: false
          }
        ],
        HOST_URL
      )
    ).toThrow(
      'Replay destination "demo-integration (127.0.0.1:3200 / 8cc359aea794)" for 127.0.0.1:3200 is disabled. Enable it explicitly or choose a different DEMO_REPLAY_URL.'
    );
  });

  it("does not re-enable a disabled legacy destination for the configured URL", () => {
    expect(() =>
      planReplayDestination(
        [
          {
            id: "disabled-legacy-destination",
            name: "demo-integration (corrected)",
            baseUrl: HOST_URL,
            enabled: false
          }
        ],
        HOST_URL
      )
    ).toThrow(
      'Replay destination "demo-integration (corrected)" for 127.0.0.1:3200 is disabled. Enable it explicitly or choose a different DEMO_REPLAY_URL.'
    );
  });

  it("reuses an enabled recorder destination with the exact configured URL", () => {
    expect(
      planReplayDestination(
        [
          {
            id: "host-destination",
            name: HOST_NAME,
            baseUrl: HOST_URL,
            enabled: true
          }
        ],
        HOST_URL
      )
    ).toEqual({ destinationId: "host-destination", name: HOST_NAME });
  });

  it("leaves a same-name unrelated destination untouched and selects a free suffix", () => {
    expect(
      planReplayDestination(
        [
          {
            id: "unrelated-destination",
            name: HOST_NAME,
            baseUrl: "http://127.0.0.1:3201",
            enabled: true
          }
        ],
        HOST_URL
      )
    ).toEqual({ destinationId: undefined, name: `${HOST_NAME} (2)` });
  });

  it("does not treat an unrelated same-length name as a recorder suffix", () => {
    expect(
      planReplayDestination(
        [
          {
            id: "unrelated-suffix",
            name: `${"x".repeat(HOST_NAME.length)} (3)`,
            baseUrl: HOST_URL,
            enabled: false
          }
        ],
        HOST_URL
      )
    ).toEqual({ destinationId: undefined, name: HOST_NAME });
  });

  it("reuses a later enabled exact-URL suffix before allocating into a gap", () => {
    expect(
      planReplayDestination(
        [
          {
            id: "unrelated-base",
            name: HOST_NAME,
            baseUrl: "http://127.0.0.1:3201",
            enabled: true
          },
          {
            id: "host-destination-3",
            name: HOST_NAME_3,
            baseUrl: HOST_URL,
            enabled: true
          }
        ],
        HOST_URL
      )
    ).toEqual({ destinationId: "host-destination-3", name: HOST_NAME_3 });
  });

  it("honors a later disabled exact-URL suffix before allocating into a gap", () => {
    expect(() =>
      planReplayDestination(
        [
          {
            id: "unrelated-base",
            name: HOST_NAME,
            baseUrl: "http://127.0.0.1:3201",
            enabled: true
          },
          {
            id: "disabled-host-destination-3",
            name: HOST_NAME_3,
            baseUrl: HOST_URL,
            enabled: false
          }
        ],
        HOST_URL
      )
    ).toThrow(
      `Replay destination "${HOST_NAME_3}" for 127.0.0.1:3200 is disabled. Enable it explicitly or choose a different DEMO_REPLAY_URL.`
    );
  });

  it.each([
    [
      "enabled first",
      [
        {
          id: "enabled-host-destination",
          name: HOST_NAME,
          baseUrl: HOST_URL,
          enabled: true
        },
        {
          id: "disabled-host-destination-3",
          name: HOST_NAME_3,
          baseUrl: HOST_URL,
          enabled: false
        }
      ]
    ],
    [
      "disabled first",
      [
        {
          id: "disabled-host-destination-3",
          name: HOST_NAME_3,
          baseUrl: HOST_URL,
          enabled: false
        },
        {
          id: "enabled-host-destination",
          name: HOST_NAME,
          baseUrl: HOST_URL,
          enabled: true
        }
      ]
    ]
  ])("honors a disabled exact-URL match with mixed matches: %s", (_label, destinations) => {
    expect(() => planReplayDestination(destinations, HOST_URL)).toThrow(
      `Replay destination "${HOST_NAME_3}" for 127.0.0.1:3200 is disabled. Enable it explicitly or choose a different DEMO_REPLAY_URL.`
    );
  });
});
