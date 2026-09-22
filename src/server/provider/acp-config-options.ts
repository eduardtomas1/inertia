import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** set_config_option returns the full configuration with its current values. */
export function assertAcpConfigSelection(
  provider: string,
  options: SessionConfigOption[],
  selected: { id: string; value: string },
): void {
  const option = options.find((candidate) => candidate.id === selected.id);
  if (option?.type !== "select" || option.currentValue !== selected.value) {
    throw new Error(`${provider} ACP did not confirm the requested session configuration.`);
  }
}
