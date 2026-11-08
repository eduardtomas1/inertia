export const MAX_SUBAGENT_DESCRIPTION_CHARS = 4_000;
export const MAX_SUBAGENT_PROGRESS_CHARS = 4_000;
export const MAX_SUBAGENT_RESULT_CHARS = 16_000;
export const MAX_SUBAGENT_LABEL_CHARS = 200;
export const MAX_SUBAGENT_COMMAND_CHARS = 4_000;
export const MAX_SUBAGENT_ACTIVITY_ID_CHARS = 200;
export const MAX_SUBAGENT_STEPS = 8;
export const MAX_SUBAGENT_STEP_LABEL_CHARS = 200;
export const MAX_SUBAGENT_STEPS_JSON_CHARS = 4_096;

/**
 * Whether live work of this kind keeps the parent turn delegated. Background
 * commands, monitors, MCP tasks and remote sessions run beside the turn: the
 * provider may end its turn while they continue, which is not a failure.
 */
export function subagentTaskHoldsTurn(kind: string): boolean {
  return kind === "agent" || kind === "workflow";
}
