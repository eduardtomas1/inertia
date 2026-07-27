/**
 * Compatibility entrypoint for the renderer, desktop shell, and runtime.
 * Domain modules must import one another directly rather than through this
 * facade so shared contracts remain acyclic and independently testable.
 */
export * from "./model-routing";
export * from "./backend-profile-settings";
export * from "./attachments";
export * from "./provider-maintenance";
export * from "./contracts/agent";
export * from "./contracts/app";
export * from "./contracts/client-command";
export * from "./contracts/conversation-detail";
export * from "./contracts/events";
export * from "./contracts/git";
export * from "./contracts/workspace";
