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

import { routedProvider } from "./composer-fixtures";

const store = vi.hoisted(() => ({
  connection: null as unknown,
  listeners: new Set<() => void>(),
}));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
    useInertiaConnection: () => useSyncExternalStore(
      (listener: () => void) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      () => store.connection,
    ),
  };
});
vi.mock("../../src/renderer/src/utils/modelRouteTransition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/utils/modelRouteTransition")>();
  return {
    ...actual,
    resolveModelRouteTransition: (
      ...parameters: Parameters<typeof actual.resolveModelRouteTransition>
    ) => ({
      ...actual.resolveModelRouteTransition(...parameters),
      kind: "create-new-conversation",
      providerSessionDisposition: "start-unbound",
      continuationAction: "new-conversation-required",
      reason: "This route needs a new chat.",
    }),
  };
});

const projectId = "71717171-7171-4171-8171-717171717171";
const sourceId = "72727272-7272-4272-8272-727272727272";
const targetId = "73737373-7373-4373-8373-737373737373";
const now = "2026-09-27T10:00:00.000Z";
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

function shell(id: string, title: string) {
  return {
    ...buildDraftConversation(
      buildNewConversationPayload(projectId, defaultSettings),
      { id, now },
    ),
    title,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
}

function detail(conversation: ReturnType<typeof shell>): ConversationDetail {
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

const source = shell(sourceId, "Source chat");
const target = shell(targetId, "Target chat");
let snapshot: AppSnapshot;

function publish(next: AppSnapshot): void {
  snapshot = next;
  store.connection = connection(next);
  for (const listener of store.listeners) listener();
}

function result(requestId: string, value: unknown): ServerEvent {
  return { type: "request.result", requestId, result: value } as unknown as ServerEvent;
}

const sendCommand: InertiaConnection["sendCommand"] = async (command) => {
  if (command.type === "conversation.detail.load") {
    const owner = command.payload.conversationId === targetId ? target : source;
    return result(command.requestId, {
      kind: "conversation.detail",
      conversationId: owner.id,
      state: "ready",
      detail: detail(owner),
    });
  }
  if (command.type === "conversation.create") {
    act(() => publish({ ...snapshot, conversations: [target, source] }));
    return result(command.requestId, { kind: "conversation.created", conversationId: targetId });
  }
  if (command.type === "conversation.select") {
    act(() => publish({ ...snapshot, activeConversationId: command.payload.conversationId }));
    return result(command.requestId, { kind: "ok" });
  }
  return await new Promise<ServerEvent>(() => undefined);
};
const subscribe: InertiaConnection["subscribe"] = () => () => undefined;
const clearError = (): void => undefined;

function connection(next: AppSnapshot): InertiaConnection {
  return {
    snapshot: next,
    runtimeGeneration: "route-transfer-generation",
    status: "online",
    error: null,
    databaseRecoveryNotice: null,
    dismissDatabaseRecoveryNotice: clearError,
    clearError,
    sendCommand,
    subscribe,
  };
}

beforeEach(() => {
  store.listeners.clear();
  publish({
    projects: [project],
    conversations: [source],
    providers: [routedProvider],
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    activeProjectId: projectId,
    activeConversationId: sourceId,
    settings: defaultSettings,
  });
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => {
        if (key === "getPlatform") return () => "darwin";
        if (key === "getDetachedChatWindows") return async () => [];
        if (key === "getPendingDetachedChatDrafts") return async () => [];
        if (typeof key === "string" && key.startsWith("on")) {
          return () => () => undefined;
        }
        return () => new Promise(() => undefined);
      },
    }),
  });
});

const storageSpies: { mockRestore: () => void }[] = [];

afterEach(() => {
  cleanup();
  for (const spy of storageSpies.splice(0)) spy.mockRestore();
  Reflect.deleteProperty(window, "inertia");
  window.localStorage.clear();
});

describe("main window route transfer", () => {
  it("moves the draft into the new chat exactly once when storage rejects writes", async () => {
    const { default: App } = await import("../../src/renderer/src/App");
    render(<App />);
    const text = "Carry this request into the new chat";
    const input = await screen.findByRole("textbox", { name: "Message" }, { timeout: 5_000 });
    storageSpies.push(vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full.", "QuotaExceededError");
    }));
    expect(() => window.localStorage.setItem("probe", "value")).toThrow();
    fireEvent.change(input, { target: { value: text } });

    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click((await screen.findByTitle("Routed Agent")).closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "New chat" }));

    await waitFor(() => expect(snapshot.activeConversationId).toBe(targetId));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text));
    expect(screen.getAllByRole("textbox", { name: "Message" })).toHaveLength(1);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());

    act(() => publish({ ...snapshot, activeConversationId: sourceId }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(""));
    act(() => publish({ ...snapshot, activeConversationId: targetId }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text));
  });
});
