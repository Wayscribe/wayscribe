export interface DemoReplayDestination {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
}

export interface ReplayDestinationPlan {
  destinationId: string | undefined;
  name: string;
}

export function planReplayDestination(
  destinations: DemoReplayDestination[],
  url: string
): ReplayDestinationPlan;
