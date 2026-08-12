import type { ClientCommand } from "../../../shared/contracts";

export const RUNTIME_SAFETY_READ_COMMAND_TYPES = Object.freeze([
  "conversation.detail.load",
  "conversation.detail.subscription",
  "agent.workflow.saved.load",
] as const satisfies readonly ClientCommand["type"][]);

const readCommandTypes = new Set<ClientCommand["type"]>(
  RUNTIME_SAFETY_READ_COMMAND_TYPES,
);

export function runtimeSafetyAllowsCommand(
  type: ClientCommand["type"],
): boolean {
  return readCommandTypes.has(type);
}
