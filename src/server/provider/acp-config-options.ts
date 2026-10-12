import type { SessionConfigOption } from "@agentclientprotocol/sdk";

export function acpConfigSelected(
  options: SessionConfigOption[],
  selected: { id: string; value: string },
): boolean {
  const option = options.find((candidate) => candidate.id === selected.id);
  return option?.type === "select" && option.currentValue === selected.value;
}

/** set_config_option returns the full configuration with its current values. */
export function assertAcpConfigSelection(
  provider: string,
  options: SessionConfigOption[],
  selected: { id: string; value: string },
): void {
  if (!acpConfigSelected(options, selected)) {
    throw new Error(`${provider} ACP did not confirm the requested session configuration.`);
  }
}
