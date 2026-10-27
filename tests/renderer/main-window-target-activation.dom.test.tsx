import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ClientCommand,
  type ConversationDetail,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import type { MainWindowTargetRequest } from "../../src/shared/desktop";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

const harness = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));

const projectId = "61616161-6161-4161-8161-616161616161";
const sourceId = "62626262-6262-4262-8262-626262626262";
const targetId = "63636363-6363-4363-8363-636363636363";
const now = "2026-10-27T10:00:00.000Z";
const project: Project = {
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

function thread(id: string, title: string) {
  return {
    ...buildDraftConversation(buildNewConversationPayload(projectId, defaultSettings), { id, now }),
    title,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
}

const source = thread(sourceId, "Source chat");
const target = thread(targetId, "Target chat");
const snapshot: AppSnapshot = {
  projects: [project],
  conversations: [source, target],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: projectId,
  activeConversationId: sourceId,
  settings: defaultSettings,
};

function detail(conversation: typeof source): ConversationDetail {
  return {
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
}

let commands: ClientCommand[] = [];
let detachedIds: string[] = [];
let pushTarget: (request: MainWindowTargetRequest) => void = () => {
  throw new Error("Main-window targets were not subscribed.");
};
const focusDetachedChat = vi.fn(async () => true);

beforeEach(() => {
  commands = [];
  detachedIds = [];
  focusDetachedChat.mockClear();
  harness.connection = {
    snapshot,
    runtimeGeneration: "main-generation",
    status: "online",
    error: null,
    databaseRecoveryNotice: null,
    dismissDatabaseRecoveryNotice: () => undefined,
    clearError: () => undefined,
    sendCommand: async (command) => {
      commands.push(command);
      if (command.type === "conversation.detail.load") {
        const conversationId = (command.payload as { conversationId: string }).conversationId;
        return {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "conversation.detail",
            conversationId,
            state: "ready",
            detail: detail(conversationId === targetId ? target : source),
          },
        } as unknown as ServerEvent;
      }
      if (command.type === "conversation.select") {
        return { type: "request.ok", requestId: command.requestId } as ServerEvent;
      }
      return await new Promise<ServerEvent>(() => undefined);
    },
    subscribe: () => () => undefined,
  } satisfies InertiaConnection;
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => {
        if (key === "getPlatform") return () => "darwin";
        if (key === "getDetachedChatWindows") {
          return async () => detachedIds.map((conversationId) => ({ conversationId, alwaysOnTop: false }));
        }
        if (key === "getPendingDetachedChatDrafts") return async () => [];
        if (key === "focusDetachedChat") return focusDetachedChat;
        if (key === "onMainWindowTarget") {
          return (listener: (request: MainWindowTargetRequest) => void) => {
            pushTarget = listener;
            return () => undefined;
          };
        }
        if (typeof key === "string" && key.startsWith("on")) {
          return () => () => undefined;
        }
        return () => new Promise(() => undefined);
      },
    }),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
});

async function renderApp(): Promise<void> {
  const { default: App } = await import("../../src/renderer/src/App");
  render(<App />);
  await act(async () => { await vi.dynamicImportSettled(); });
  await screen.findByRole("region", { name: "Message composer" }, { timeout: 5_000 });
}

function send(request: MainWindowTargetRequest["target"]): void {
  act(() => pushTarget({ sourceConversationId: sourceId, target: request }));
}

function selected(): string[] {
  return commands
    .filter((command) => command.type === "conversation.select")
    .map((command) => (command.payload as { conversationId: string }).conversationId);
}

describe("conversation targets from a chat window", () => {
  it("closes the open palette and selects the chat through the main window's activation", async () => {
    await renderApp();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(await screen.findByRole("dialog", { name: "Search Inertia" }, { timeout: 5_000 })).toBeInTheDocument();

    send({ kind: "conversation", conversationId: targetId });
    await act(async () => { await vi.dynamicImportSettled(); });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search Inertia" })).not.toBeInTheDocument());
    await waitFor(() => expect(selected()).toEqual([targetId]));
  });

  it("focuses a target chat's own window without leaving the current main view", async () => {
    detachedIds = [targetId];
    await renderApp();
    send({ kind: "settings", page: "agents" });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(await screen.findByRole("main", { name: "Settings" }, { timeout: 5_000 })).toBeInTheDocument();

    send({ kind: "conversation", conversationId: targetId });
    await act(async () => { await vi.dynamicImportSettled(); });

    await waitFor(() => expect(focusDetachedChat).toHaveBeenCalledWith(targetId));
    expect(screen.getByRole("main", { name: "Settings" })).toBeInTheDocument();
    expect(selected()).toEqual([]);
  });
});
