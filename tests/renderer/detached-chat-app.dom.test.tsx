import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { taskTrace, taskTurn } from "./background-task-fixtures";

const counting = vi.hoisted(() => ({ composerRenders: 0 }));
const harness = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));
vi.mock("../../src/renderer/src/components/Composer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/Composer")>();
  const { memo } = await import("react");
  const inner = (actual.Composer as unknown as { type: (props: object) => React.JSX.Element }).type;
  return {
    ...actual,
    Composer: memo((props: object) => {
      counting.composerRenders += 1;
      return inner(props);
    }),
  };
});

const projectId = "61616161-6161-4161-8161-616161616161";
const conversationId = "62626262-6262-4262-8262-626262626262";
const now = "2026-09-20T10:00:00.000Z";
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
  title: "Detached chat",
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

const harnessDetail = vi.hoisted(() => ({ current: null as unknown }));

const sendCommand: InertiaConnection["sendCommand"] = async (command) => {
  if (command.type === "conversation.detail.load") {
    return {
      type: "request.result",
      requestId: command.requestId,
      result: {
        kind: "conversation.detail",
        conversationId,
        state: "ready",
        detail: harnessDetail.current ?? detail,
      },
    } as unknown as ServerEvent;
  }
  return await new Promise<ServerEvent>(() => undefined);
};
const subscribe: InertiaConnection["subscribe"] = () => () => undefined;
const clearError = (): void => undefined;

function connectionFor(nextSnapshot: AppSnapshot | null): InertiaConnection {
  return {
    snapshot: nextSnapshot,
    runtimeGeneration: "detached-generation",
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
  counting.composerRenders = 0;
  harnessDetail.current = null;
  harness.connection = connectionFor(snapshot);
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => {
        if (key === "getPlatform") return () => "darwin";
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

const context = {
  role: "detached-chat" as const,
  conversationId,
  alwaysOnTop: false,
  draft: "",
};

describe("detached chat window", () => {
  it("keeps the composer still when an unrelated snapshot update arrives", async () => {
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    const view = render(<DetachedChatApp initialWindowContext={context} />);
    await screen.findByRole("textbox", { name: "Message" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    counting.composerRenders = 0;

    harness.connection = connectionFor({ ...snapshot, runs: [] });
    view.rerender(<DetachedChatApp initialWindowContext={context} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(counting.composerRenders).toBe(0);
  });

  it("closes the window with Command+W only when it has no panel tab to close", async () => {
    const closes: string[] = [];
    const bridge = window.inertia as unknown as object;
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: new Proxy({}, {
        get: (_target, key) => key === "closeDetachedChat"
          ? (draft: string) => {
            closes.push(draft);
            return Promise.resolve();
          }
          : Reflect.get(bridge, key),
      }),
    });
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={{ ...context, draft: "keep this" }} />);
    const message = await screen.findByRole("textbox", { name: "Message" });
    message.focus();

    fireEvent.keyDown(message, { key: "w", code: "KeyW", ctrlKey: true });
    fireEvent.keyDown(message, { key: "w", code: "KeyW", metaKey: true, shiftKey: true });
    expect(closes).toEqual([]);

    const panel = document.createElement("aside");
    panel.className = "workspace-panel";
    const closedTabs: string[] = [];
    panel.addEventListener("inertia:close-active-panel-surface", (event) => {
      closedTabs.push("tab");
      event.preventDefault();
    });
    document.body.append(panel);
    fireEvent.keyDown(message, { key: "w", code: "KeyW", metaKey: true });
    expect(closedTabs).toEqual(["tab"]);
    expect(closes).toEqual([]);
    panel.remove();

    const shortcut = new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, bubbles: true, cancelable: true });
    message.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(closes).toEqual(["keep this"]);
  });

  it("connects with cached settings when browser storage is unavailable", async () => {
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    harness.connection = connectionFor(null);
    const storage = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage is disabled.", "SecurityError");
    });
    try {
      render(<DetachedChatApp initialWindowContext={context} />);
      expect(screen.getByRole("heading", { name: "Detached chat" })).toBeInTheDocument();
    } finally {
      storage.mockRestore();
    }
  });

  it("shows a turn's agents as plain status that cannot close the window", async () => {
    const turn = taskTurn({
      id: "detached-turn",
      conversationId,
      userMessageId: "detached-message",
      status: "completed",
      completedAt: "2030-01-01T00:02:00.000Z",
    });
    harnessDetail.current = {
      ...detail,
      agentTurns: [turn],
      messages: [{
        id: "detached-message",
        conversationId,
        turnId: turn.id,
        role: "user",
        content: "Split the work across helpers.",
        attachments: [],
        createdAt: turn.requestedAt,
      }],
      subagents: [
        taskTrace({ id: "done", conversationId, turnId: turn.id, runId: turn.runId, status: "completed" }),
        taskTrace({ id: "broken", conversationId, turnId: turn.id, runId: turn.runId, status: "failed" }),
      ],
    };
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);
    await act(async () => { await vi.dynamicImportSettled(); });
    const status = await screen.findByText("2 agents finished");
    expect(status.closest("button")).toBeNull();
    expect(status.parentElement).toHaveTextContent(/^2 agents finished · 1 failed$/u);
    expect(screen.queryByRole("button", { name: /agents finished/u })).toBeNull();
  });

  it("opens with the carried draft when this window's storage rejects writes", async () => {
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    const storage = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full.", "QuotaExceededError");
    });
    try {
      render(<DetachedChatApp initialWindowContext={{ ...context, draft: "Carried into the window" }} />);
      expect(await screen.findByRole("textbox", { name: "Message" })).toHaveValue("Carried into the window");
    } finally {
      storage.mockRestore();
    }
  });
});
