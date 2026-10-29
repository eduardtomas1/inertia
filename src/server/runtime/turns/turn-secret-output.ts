import type { ProviderEvent, ProviderRunResult } from "../../provider/contracts";

export interface TurnSecretOutputFilter {
  events(event: ProviderEvent): readonly ProviderEvent[];
  result(result: ProviderRunResult): { events: readonly ProviderEvent[]; result: ProviderRunResult };
}

export function secretFilteredEvents(
  filter: TurnSecretOutputFilter | undefined,
  event: ProviderEvent,
): readonly ProviderEvent[] {
  return filter ? filter.events(event) : [event];
}

export function secretFilteredResult(
  filter: TurnSecretOutputFilter | undefined,
  result: ProviderRunResult,
  project: (event: ProviderEvent) => void,
): ProviderRunResult {
  if (!filter) return result;
  const output = filter.result(result);
  for (const event of output.events) project(event);
  return output.result;
}
