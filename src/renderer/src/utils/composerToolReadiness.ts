import type { AgentWorkflowSkillsCapability } from "@shared/contracts";

export type ComposerToolReadinessState =
  | "ready"
  | "checking"
  | "blocked"
  | "unavailable";

export interface ComposerToolReadiness {
  state: ComposerToolReadinessState;
  interactive: boolean;
  reason: string | null;
}

export function composerSkillsReadiness(input: {
  capability: AgentWorkflowSkillsCapability;
  composerDisabled: boolean;
  running: boolean;
  loading: boolean;
}): ComposerToolReadiness {
  if (!input.capability.available) {
    return {
      state: "unavailable",
      interactive: false,
      reason: input.capability.reason,
    };
  }
  if (input.composerDisabled) {
    return {
      state: "blocked",
      interactive: false,
      reason: "Skills are available when this chat is ready.",
    };
  }
  if (input.running) {
    return {
      state: "blocked",
      interactive: false,
      reason: "Skills can be changed after the current turn stops.",
    };
  }
  if (input.loading) {
    return {
      state: "checking",
      interactive: true,
      reason: "Refreshing available skills…",
    };
  }
  return { state: "ready", interactive: true, reason: null };
}
