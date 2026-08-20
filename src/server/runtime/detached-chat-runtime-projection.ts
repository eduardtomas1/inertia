import type {
  AppSettings,
  AppSnapshot,
  RuntimeSequencedFrame,
} from "../../shared/contracts";
import { defaultSettings } from "../../shared/contracts/app";
import type { RuntimeDetailSubscription } from "../runtime-sequencing";
import { projectRuntimeFrame } from "../runtime-sequencing";
import type { RuntimeClientAuthority } from "./runtime-client-authority";

function projectedSettings(settings: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    theme: settings.theme,
    colorTheme: settings.colorTheme,
    showTimestamps: settings.showTimestamps,
    showThinking: settings.showThinking,
    usageDisplayMode: settings.usageDisplayMode,
    interfaceScale: settings.interfaceScale,
    responseDensity: settings.responseDensity,
    defaultCodeWrap: settings.defaultCodeWrap,
    autoCollapseWorkLog: settings.autoCollapseWorkLog,
    showChangedFileSummaries: settings.showChangedFileSummaries,
    autoScrollToFinalAnswer: settings.autoScrollToFinalAnswer,
    confirmDestructiveActions: settings.confirmDestructiveActions,
    providerIdentityLabels: { ...settings.providerIdentityLabels },
    keybindings: { ...defaultSettings.keybindings },
  };
}

/**
 * Projects the renderer-safe shell again at the detached-window boundary.
 * Provider/model catalog data remains available for the chat composer, while
 * unrelated workspace identities and global mutation surfaces are removed.
 */
export function projectDetachedChatSnapshot(
  snapshot: AppSnapshot,
  conversationId: string,
): AppSnapshot {
  const conversation = snapshot.conversations.find(
    ({ id }) => id === conversationId,
  ) ?? null;
  const project = conversation
    ? snapshot.projects.find(({ id }) => id === conversation.projectId) ?? null
    : null;

  return {
    projects: project ? [project] : [],
    conversations: conversation ? [conversation] : [],
    runs: snapshot.runs.filter(
      (run) => run.conversationId === conversationId,
    ),
    providers: snapshot.providers.map(({ maintenance: _maintenance, ...provider }) =>
      provider),
    maintenanceOperations: [],
    backendProfiles: snapshot.backendProfiles ?? [],
    backendDefaults: [],
    settings: projectedSettings(snapshot.settings),
    promptPresets: [],
    activeProjectId: project?.id ?? null,
    activeConversationId: conversation?.id ?? null,
    ...(snapshot.sync ? { sync: snapshot.sync } : {}),
  };
}

export function projectRuntimeFrameForAuthority(
  frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }>,
  subscription: RuntimeDetailSubscription,
  authority: RuntimeClientAuthority,
): RuntimeSequencedFrame {
  if (authority.kind === "main") {
    return projectRuntimeFrame(frame, subscription);
  }

  if (
    frame.scope.kind === "conversation-detail"
    && frame.scope.conversationId !== authority.conversationId
  ) {
    return { type: "runtime.cursor", sync: frame.sync };
  }

  switch (frame.event.type) {
    case "snapshot.updated":
      return {
        ...frame,
        event: {
          type: "snapshot.updated",
          snapshot: projectDetachedChatSnapshot(
            frame.event.snapshot,
            authority.conversationId,
          ),
        },
      };
    case "conversation.shell.updated":
      return frame.event.conversation.id === authority.conversationId
        ? {
            ...frame,
            event: {
              ...frame.event,
              runs: frame.event.runs.filter(
                (run) => run.conversationId === authority.conversationId,
              ),
            },
          }
        : { type: "runtime.cursor", sync: frame.sync };
    case "workspace.git.invalidated":
    case "provider.maintenance.updated":
    case "provider.maintenance.operation":
      return { type: "runtime.cursor", sync: frame.sync };
    default:
      return frame;
  }
}
