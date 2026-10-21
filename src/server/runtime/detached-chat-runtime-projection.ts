import type {
  AgentInputRequest,
  AppSettings,
  AppSnapshot,
  RuntimeSequencedFrame,
} from "../../shared/contracts";
import { defaultSettings } from "../../shared/contracts/app";
import type { WatcherLinkView } from "../../shared/watcher";
import type { RuntimeDetailSubscription } from "../runtime-sequencing";
import { projectRuntimeFrame, runtimeCursorFrame } from "../runtime-sequencing";
import type { RuntimeClientAuthority } from "./runtime-client-authority";

function projectedSettings(settings: AppSettings): AppSettings {
  return {
    ...defaultSettings,
    theme: settings.theme,
    colorTheme: settings.colorTheme,
    lightColorTheme: settings.lightColorTheme,
    darkColorTheme: settings.darkColorTheme,
    lightCustomColor: settings.lightCustomColor,
    darkCustomColor: settings.darkCustomColor,
    mutedCustomColors: settings.mutedCustomColors,
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
    workingIndicator: { ...settings.workingIndicator },
  };
}

function watcherLinkTouches(
  link: Pick<WatcherLinkView, "watcherConversationId" | "watchedConversationId">,
  conversationId: string,
): boolean {
  return link.watcherConversationId === conversationId
    || link.watchedConversationId === conversationId;
}

export type DetachedWatcherLinkLookup = (
  linkId: string,
) => Pick<WatcherLinkView, "watcherConversationId" | "watchedConversationId"> | null;

/** Removes a foreign conversation identity from host-owned input prompts. */
export function projectDetachedChatInputRequest(
  request: AgentInputRequest,
  conversationId: string,
): AgentInputRequest {
  const contextRequest = request.conversationContextRequest;
  if (
    !contextRequest?.requestedSourceConversationId
    || contextRequest.requestedSourceConversationId === conversationId
    || detachedContextRequestShareable(contextRequest)
  ) {
    return request;
  }
  const { requestedSource: _requestedSource, ...unnamed } = contextRequest;
  return {
    ...request,
    conversationContextRequest: {
      ...unnamed,
      requestedSourceConversationId: null,
    },
  };
}

export function detachedContextRequestShareable(
  contextRequest: NonNullable<AgentInputRequest["conversationContextRequest"]>,
): boolean {
  return contextRequest.requestedSourceConversationId !== null
    && contextRequest.requestedSource?.conversationId
      === contextRequest.requestedSourceConversationId;
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
    todos: [],
    ...(snapshot.watchers ? {
      watchers: snapshot.watchers.filter((link) => watcherLinkTouches(link, conversationId)),
    } : {}),
    activeProjectId: project?.id ?? null,
    activeConversationId: conversation?.id ?? null,
    ...(snapshot.sync ? { sync: snapshot.sync } : {}),
  };
}

export function projectRuntimeFrameForAuthority(
  frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }>,
  subscription: RuntimeDetailSubscription,
  authority: RuntimeClientAuthority,
  watcherLink?: DetachedWatcherLinkLookup,
): RuntimeSequencedFrame {
  if (authority.kind === "main") {
    return projectRuntimeFrame(frame, subscription);
  }

  if (
    frame.scope.kind === "conversation-detail"
    && frame.scope.conversationId !== authority.conversationId
  ) {
    return runtimeCursorFrame(frame);
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
        : runtimeCursorFrame(frame);
    case "agent.input.requested": {
      const request = projectDetachedChatInputRequest(
        frame.event.request,
        authority.conversationId,
      );
      return request === frame.event.request
        ? frame
        : {
            ...frame,
            event: { ...frame.event, request },
          };
    }
    case "watcher.link.updated":
      return watcherLinkTouches(frame.event.link, authority.conversationId)
        ? frame
        : runtimeCursorFrame(frame);
    case "watcher.link.removed":
    case "watcher.live": {
      const named = frame.event.type === "watcher.link.removed" && frame.event.watcherConversationId !== undefined
        ? { watcherConversationId: frame.event.watcherConversationId, watchedConversationId: frame.event.watchedConversationId ?? null }
        : null;
      const link = named ?? watcherLink?.(frame.event.linkId) ?? null;
      return link
        && (frame.event.type !== "watcher.live" || link.watcherConversationId === frame.event.watcherConversationId)
        && watcherLinkTouches(link, authority.conversationId)
        ? frame
        : runtimeCursorFrame(frame);
    }
    case "workspace.git.invalidated":
    case "provider.maintenance.updated":
    case "provider.maintenance.operation":
      return runtimeCursorFrame(frame);
    default:
      return frame;
  }
}
