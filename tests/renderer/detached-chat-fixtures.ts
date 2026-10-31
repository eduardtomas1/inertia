import { act } from "@testing-library/react";

import {
  defaultSettings,
  type AppSettings,
  type AppSnapshot,
  type ClientCommand,
  type ConversationDetail,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import type { MainWindowTarget } from "../../src/shared/desktop";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

export const projectId = "61616161-6161-4161-8161-616161616161";
export const conversationId = "62626262-6262-4262-8262-626262626262";
const now = "2026-09-20T10:00:00.000Z";

export const project: Project = {
  id: projectId,
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: "",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#6366f1",
  status: "ready",
  createdAt: now,
  updatedAt: now,
};

export const conversation = {
  ...buildDraftConversation(
    buildNewConversationPayload(projectId, defaultSettings),
    { id: conversationId, now },
  ),
  title: "Detached chat",
  latestTurn: null,
  pendingApproval: false,
  pendingInput: false,
};

export function detachedSnapshot(settings: Partial<AppSettings> = {}): AppSnapshot {
  return {
    projects: [project],
    conversations: [conversation],
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    activeProjectId: projectId,
    activeConversationId: conversationId,
    settings: { ...defaultSettings, ...settings },
  };
}

export const detail: ConversationDetail = {
  conversation,
  agentTurns: [],
  turnGitArtifacts: [],
  messages: [],
  activities: [],
  subagents: [],
  reasonings: [],
  usage: [],
  plans: [],
  goals: [],
  checkpoints: [],
  reviewSummaries: [],
  reviewStates: [],
  reviewNotes: [],
  contextPackets: [],
};

export const windowContext = {
  role: "detached-chat" as const,
  conversationId,
  alwaysOnTop: false,
  draft: "",
  terminalIds: [] as readonly string[],
};

type Listener = Parameters<InertiaConnection["subscribe"]>[0];
type Responder = (command: ClientCommand) => ServerEvent | null | undefined;

export interface RecordingConnection {
  connection: InertiaConnection;
  commands: ClientCommand[];
  emit(event: ServerEvent): void;
  types(): string[];
}

export function recordingConnection(
  snapshot: AppSnapshot | null,
  respond: Responder = () => undefined,
  conversationDetail: ConversationDetail = detail,
): RecordingConnection {
  const listeners = new Set<Listener>();
  const commands: ClientCommand[] = [];
  const clearError = (): void => undefined;
  const connection: InertiaConnection = {
    snapshot,
    runtimeGeneration: "detached-generation",
    status: "online",
    error: null,
    databaseRecoveryNotice: null,
    dismissDatabaseRecoveryNotice: clearError,
    clearError,
    runtimeStopped: null,
    restartRuntime: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    sendCommand: async (command) => {
      commands.push(command);
      if (command.type === "conversation.detail.load") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "conversation.detail",
            conversationId,
            state: "ready",
            detail: conversationDetail,
          },
        } as unknown as ServerEvent;
      }
      const response = respond(command);
      if (response) return response;
      if (response === null) return { type: "request.ok", requestId: command.requestId } as ServerEvent;
      return await new Promise<ServerEvent>(() => undefined);
    },
  };
  return {
    connection,
    commands,
    emit: (event) => {
      act(() => {
        for (const listener of listeners) listener(event as Parameters<Listener>[0]);
      });
    },
    types: () => commands.map(({ type }) => type),
  };
}

export interface DetachedBridge {
  openedInMain: MainWindowTarget[];
  docked: unknown[][];
  persisted: unknown[][];
  mirrored: unknown[][];
  copied: string[];
  install(): void;
}

export function detachedBridge(): DetachedBridge {
  const bridge: DetachedBridge = {
    openedInMain: [],
    docked: [],
    persisted: [],
    mirrored: [],
    copied: [],
    install: () => {
      Object.defineProperty(window, "inertia", {
        configurable: true,
        value: new Proxy({}, {
          get: (_target, key) => {
            if (key === "getPlatform") return () => "darwin";
            if (key === "openInMainWindow") {
              return (target: MainWindowTarget) => {
                bridge.openedInMain.push(target);
                return Promise.resolve();
              };
            }
            if (key === "dockDetachedChat") {
              return (...args: unknown[]) => {
                bridge.docked.push(args);
                return Promise.resolve();
              };
            }
            if (key === "persistDetachedChatDraft" || key === "mirrorDetachedChatDraft") {
              return (...args: unknown[]) => {
                (key === "persistDetachedChatDraft" ? bridge.persisted : bridge.mirrored).push(args);
                return true;
              };
            }
            if (key === "copyText") {
              return (text: string) => {
                bridge.copied.push(text);
                return Promise.resolve(true);
              };
            }
            if (typeof key === "string" && key.startsWith("on")) {
              return () => () => undefined;
            }
            return () => new Promise(() => undefined);
          },
        }),
      });
    },
  };
  return bridge;
}
