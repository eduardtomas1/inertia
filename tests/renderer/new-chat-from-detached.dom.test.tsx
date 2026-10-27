import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ConversationDetail,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
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

const projectId = "53535353-5353-4353-8353-535353535353";
const conversationId = "54545454-5454-4454-8454-545454545454";
const now = "2026-10-18T10:00:00.000Z";
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
const conversation = {
  ...buildDraftConversation(
    buildNewConversationPayload(projectId, defaultSettings),
    { id: conversationId, now },
  ),
  title: "Popped out chat",
  latestTurn: null,
  pendingApproval: false,
  pendingInput: false,
};
const snapshot: AppSnapshot = {
  projects: [project],
  conversations: [conversation],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: projectId,
  activeConversationId: conversationId,
  settings: defaultSettings,
};
const detail: ConversationDetail = {
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

beforeEach(() => {
  harness.connection = {
    snapshot,
    runtimeGeneration: "detached-generation",
    status: "online",
    error: null,
    databaseRecoveryNotice: null,
    dismissDatabaseRecoveryNotice: () => undefined,
    clearError: () => undefined,
    sendCommand: async (command) => {
      if (command.type === "conversation.detail.load") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "conversation.detail", conversationId, state: "ready", detail },
        } as unknown as ServerEvent;
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
          return async () => [{ conversationId, alwaysOnTop: false }];
        }
        if (key === "getPendingDetachedChatDrafts") return async () => [];
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

describe("main window while the active chat is in its own window", () => {
  it("renders no tools panel or terminal for the detached chat", async () => {
    const { default: App } = await import("../../src/renderer/src/App");
    const { container } = render(<App />);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(await screen.findByRole("region", { name: "Detached chat: Popped out chat" }, { timeout: 5_000 }))
      .toBeInTheDocument();
    const rightPanelToggle = await waitFor(() => {
      const toggle = container.querySelector<HTMLButtonElement>("[data-right-panel-toggle]");
      expect(toggle).not.toBeNull();
      return toggle!;
    }, { timeout: 5_000 });
    fireEvent.click(rightPanelToggle);
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    await act(async () => { await vi.dynamicImportSettled(); });

    expect(screen.queryByRole("complementary", { name: "Workspace tools" })).not.toBeInTheDocument();
    expect(container.querySelector(".terminal-dock")).toBeNull();
    const toggles = screen.getAllByRole("button", {
      name: "Workspace tools are hidden while this chat is in its own window.",
    });
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) expect(toggle).toBeDisabled();
  });
});

describe("new chat while the active chat is in its own window", () => {
  it("shows the new chat instead of the detached chat placeholder", async () => {
    const { default: App } = await import("../../src/renderer/src/App");
    render(<App />);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(await screen.findByRole("region", { name: "Detached chat: Popped out chat" }, { timeout: 5_000 }))
      .toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "Start a new chat" }, { timeout: 5_000 }));
    await act(async () => { await vi.dynamicImportSettled(); });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Detached chat: Popped out chat" }))
      .not.toBeInTheDocument(), { timeout: 5_000 });
    expect(await screen.findByRole("region", { name: "Message composer" }, { timeout: 5_000 }))
      .toBeInTheDocument();
  });
});
