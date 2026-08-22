/**
 * Compatibility entrypoint for the renderer, desktop shell, and runtime.
 * Domain modules must import one another directly rather than through this
 * facade so shared contracts remain acyclic and independently testable.
 */
export * from "./model-routing";
export * from "./backend-profile-settings";
export * from "./attachments";
export * from "./provider-maintenance";
export * from "./provider-terminal-resume";
export * from "./run-state";
export * from "./conversation-context";
export type {
  PromptPreset,
  PromptPresetDraft,
  PromptPresetRoute,
} from "./prompt-presets";
export * from "./contracts/agent";
export * from "./contracts/agent-workflows";
export * from "./contracts/app";
export * from "./contracts/client-command";
export * from "./contracts/conversation-detail";
export * from "./contracts/daily-work";
export * from "./contracts/duo";
export * from "./contracts/events";
export * from "./contracts/git";
export * from "./contracts/usage-dashboard";
export * from "./contracts/workspace";
