import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentInputRequest,
  type AppSnapshot,
  type ClientCommand,
  type ConversationDetail,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";
import { taskTurn } from "./background-task-fixtures";

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

type ConnectionListener = Parameters<InertiaConnection["subscribe"]>[0];

function contextInputRequest(
  id: string,
  requestedSource: { conversationId: string; conversationTitle: string } | null,
  workspaceRelation: "same-workspace" | "different-workspace" = "same-workspace",
): AgentInputRequest {
  return {
    id,
    providerId: "claude",
    conversationId,
    runId: "detached-run",
    turnId: "detached-turn",
    questions: [],
    autoResolutionMs: 300_000,
    conversationContextRequest: {
      requestId: id,
      targetConversationId: conversationId,
      targetTurnId: "detached-turn",
      requestedSourceConversationId: requestedSource?.conversationId ?? null,
      ...(requestedSource ? {
        requestedSource: {
          ...requestedSource,
          projectName: "Source project",
          workspaceLabel: "Project checkout",
          targetWorkspaceLabel: "Project checkout",
          workspaceRelation,
        },
      } : {}),
      createdAt: now,
      expiresAt: "2026-09-20T10:05:00.000Z",
    },
  };
}

function liveConnection(): {
  commands: ClientCommand[];
  emit(event: ServerEvent): void;
} {
  const listeners = new Set<ConnectionListener>();
  const commands: ClientCommand[] = [];
  harness.connection = {
    ...connectionFor(snapshot),
    subscribe: (listener: ConnectionListener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    sendCommand: async (command: ClientCommand) => {
      commands.push(command);
      if (command.type === "conversation.context.agent.respond") {
        return { type: "request.ok", requestId: command.requestId } as ServerEvent;
      }
      return await sendCommand(command);
    },
  };
  return {
    commands,
    emit: (event) => {
      act(() => {
        for (const listener of listeners) listener(event as Parameters<ConnectionListener>[0]);
      });
    },
  };
}

describe("detached chat window", () => {
  it("answers its own chat's request for a named chat in the window", async () => {
    const live = liveConnection();
    const sourceConversationId = "63636363-6363-4363-8363-636363636363";
    const requestId = "64646464-6464-4464-8464-646464646464";
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);
    await screen.findByRole("textbox", { name: "Message" });

    live.emit({
      type: "agent.input.requested",
      request: contextInputRequest(requestId, {
        conversationId: sourceConversationId,
        conversationTitle: "Source chat",
      }),
    });
    await act(async () => { await vi.dynamicImportSettled(); });

    const card = await screen.findByRole("region", { name: "Agent requested chat context" });
    expect(card).toHaveTextContent("Source chat");
    expect(card).toHaveTextContent("From Source project · Project checkout");
    expect(screen.queryByText("Review this request in the main window.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Share chat" }));
    expect(await screen.findByText("Sharing approved.")).toBeInTheDocument();
    expect(live.commands.filter(({ type }) => type === "conversation.context.agent.respond"))
      .toEqual([expect.objectContaining({
        payload: {
          decision: "select",
          contextRequestId: requestId,
          sourceConversationId,
          targetConversationId: conversationId,
          acknowledgedWorkspaceDifference: false,
        },
      })]);
  });

  it("announces each new request for a named chat", async () => {
    const live = liveConnection();
    const source = {
      conversationId: "63636363-6363-4363-8363-636363636363",
      conversationTitle: "Source chat",
    };
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);
    await screen.findByRole("textbox", { name: "Message" });

    live.emit({
      type: "agent.input.requested",
      request: contextInputRequest("67676767-6767-4767-8767-676767676767", source),
    });
    const first = screen.getByText("The agent asked to read another chat.");
    expect(first).toHaveAttribute("role", "status");
    expect(first).toHaveAttribute("aria-live", "polite");

    live.emit({
      type: "agent.input.resolved",
      conversationId,
      runId: "detached-run",
      turnId: "detached-turn",
      requestId: "67676767-6767-4767-8767-676767676767",
    });
    expect(screen.queryByText("The agent asked to read another chat.")).toBeNull();
    live.emit({
      type: "agent.input.requested",
      request: contextInputRequest("68686868-6868-4868-8868-686868686868", source),
    });
    const second = screen.getByText("The agent asked to read another chat.");
    expect(second).toHaveAttribute("role", "status");
    expect(second).not.toBe(first);
  });

  it("returns focus to the message box when the answered request card closes", async () => {
    const live = liveConnection();
    const requestId = "66666666-6666-4666-8666-666666666666";
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);
    const message = await screen.findByRole("textbox", { name: "Message" });

    live.emit({
      type: "agent.input.requested",
      request: contextInputRequest(requestId, {
        conversationId: "63636363-6363-4363-8363-636363636363",
        conversationTitle: "Source chat",
      }),
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    fireEvent.click(await screen.findByRole("button", { name: "Share chat" }));
    await screen.findByText("Sharing approved.");
    const preview = screen.getByRole("button", { name: "Preview" });
    preview.focus();
    expect(preview).toHaveFocus();

    live.emit({
      type: "agent.input.resolved",
      conversationId,
      runId: "detached-run",
      turnId: "detached-turn",
      requestId,
    });

    expect(screen.queryByRole("region", { name: "Agent requested chat context" })).toBeNull();
    await waitFor(() => expect(message).toHaveFocus());
  });

  it("sends a request that leaves the chat open to the main window", async () => {
    const live = liveConnection();
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);
    await screen.findByRole("textbox", { name: "Message" });

    live.emit({
      type: "agent.input.requested",
      request: contextInputRequest("65656565-6565-4565-8565-656565656565", null),
    });
    await act(async () => { await vi.dynamicImportSettled(); });

    expect(await screen.findByText("Review this request in the main window.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent requested chat context" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share chat" })).toBeNull();
  });

  it("shows context shared in an earlier message as plain text it cannot open", async () => {
    const turn = taskTurn({
      id: "context-turn",
      conversationId,
      userMessageId: "context-message",
      status: "completed",
      completedAt: "2030-01-01T00:02:00.000Z",
    });
    harnessDetail.current = {
      ...detail,
      agentTurns: [turn],
      messages: [{
        id: "context-message",
        conversationId,
        turnId: turn.id,
        role: "user",
        content: "Use the referenced chat.",
        attachments: [],
        createdAt: turn.requestedAt,
      }],
      contextPackets: [{
        id: "69696969-6969-4969-8969-696969696969",
        sourceConversationId: "63636363-6363-4363-8363-636363636363",
        targetConversationId: conversationId,
        sourceProjectId: projectId,
        targetProjectId: projectId,
        sourceConversationTitle: "Source chat",
        sourceProjectName: "Inertia",
        sourceWorkspaceLabel: "Project checkout",
        targetWorkspaceLabel: "Project checkout",
        workspaceRelation: "same-workspace",
        note: null,
        messageCount: 2,
        characterCount: 120,
        droppedMessageCount: 0,
        createdAt: turn.requestedAt,
        consumedMessageId: "context-message",
        consumedAt: turn.requestedAt,
        sourceState: "available",
      }],
    };
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);
    await act(async () => { await vi.dynamicImportSettled(); });

    const shared = await screen.findByRole("generic", { name: "Shared chat context" });
    expect(shared).toHaveTextContent("Context from Source chat");
    expect(within(shared).queryByRole("button")).toBeNull();
  });

  describe("named context request card", () => {
    const sourceConversationId = "63636363-6363-4363-8363-636363636363";
    const requestId = "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";
    const source = { conversationId: sourceConversationId, conversationTitle: "Source chat" };

    async function openCard(
      requests: AgentInputRequest[],
    ): Promise<{ live: ReturnType<typeof liveConnection>; card: HTMLElement }> {
      const live = liveConnection();
      const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
      render(<DetachedChatApp initialWindowContext={context} />);
      await screen.findByRole("textbox", { name: "Message" });
      for (const request of requests) live.emit({ type: "agent.input.requested", request });
      await act(async () => { await vi.dynamicImportSettled(); });
      return {
        live,
        card: await screen.findByRole("region", { name: "Agent requested chat context" }),
      };
    }

    function respondCommands(commands: ClientCommand[]): ClientCommand[] {
      return commands.filter(({ type }) => type === "conversation.context.agent.respond");
    }

    it("offers only the named chat, without a chooser", async () => {
      const { card } = await openCard([contextInputRequest(requestId, source)]);
      expect(within(card).queryByRole("combobox")).toBeNull();
      expect(card).toHaveTextContent("Source chat");
      expect(screen.getAllByRole("region", { name: "Agent requested chat context" })).toHaveLength(1);
    });

    it("declines the request from the window", async () => {
      const { card, live } = await openCard([contextInputRequest(requestId, source)]);
      fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
      expect(await within(card).findByText("Request declined.")).toBeInTheDocument();
      expect(respondCommands(live.commands)).toEqual([expect.objectContaining({
        payload: {
          decision: "cancel",
          contextRequestId: requestId,
          targetConversationId: conversationId,
        },
      })]);
    });

    it("previews the named chat through the request it answers", async () => {
      const { card, live } = await openCard([contextInputRequest(requestId, source)]);
      fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
      await act(async () => { await vi.dynamicImportSettled(); });
      await waitFor(() => expect(live.commands.filter(({ type }) =>
        type === "conversation.context.agent.source.load")).toEqual([expect.objectContaining({
        payload: {
          contextRequestId: requestId,
          sourceConversationId,
          targetConversationId: conversationId,
        },
      })]));
      expect(live.commands.some(({ type }) => type === "conversation.context.source.load")).toBe(false);
    });

    it("closes when the request ends without an answer", async () => {
      const { live } = await openCard([contextInputRequest(requestId, source)]);
      live.emit({
        type: "agent.input.resolved",
        conversationId,
        runId: "detached-run",
        turnId: "detached-turn",
        requestId,
      });
      expect(screen.queryByRole("region", { name: "Agent requested chat context" })).toBeNull();
      expect(screen.queryByText("Review this request in the main window.")).toBeNull();
      expect(respondCommands(live.commands)).toEqual([]);
    });

    it("shows one card for the named request and the notice for an open one at the same time", async () => {
      const { card } = await openCard([
        contextInputRequest("6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b", null),
        contextInputRequest(requestId, source),
      ]);
      expect(screen.getAllByRole("region", { name: "Agent requested chat context" })).toEqual([card]);
      expect(card).toHaveTextContent("Source chat");
      expect(screen.getByText("Review this request in the main window.")).toBeInTheDocument();
    });

    it("asks before sharing a chat from a different workspace", async () => {
      const { card, live } = await openCard([
        contextInputRequest(requestId, source, "different-workspace"),
      ]);
      const share = within(card).getByRole("button", { name: "Share chat" });
      expect(share).toBeDisabled();
      fireEvent.click(within(card).getByRole("checkbox", {
        name: "Share context across these different workspaces",
      }));
      expect(share).toBeEnabled();
      fireEvent.click(share);
      expect(await within(card).findByText("Sharing approved.")).toBeInTheDocument();
      expect(respondCommands(live.commands)).toEqual([expect.objectContaining({
        payload: {
          decision: "select",
          contextRequestId: requestId,
          sourceConversationId,
          targetConversationId: conversationId,
          acknowledgedWorkspaceDifference: true,
        },
      })]);
    });
  });

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

  it("shows the Duo judge notice on a Duo chat in its own window", async () => {
    const launchId = "63636363-6363-4363-8363-636363636363";
    const judgeId = "64646464-6464-4464-8464-646464646464";
    const duoCommand: InertiaConnection["sendCommand"] = async (command) => {
      if (command.type === "duo.pending") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "duo.pending", launchIds: [launchId], hasMore: false },
        };
      }
      if (command.type === "duo.status") {
        return {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "duo.status",
            launchId,
            state: "running",
            error: null,
            sides: [
              { ordinal: 0, conversationId, turnId: null, dispatchState: "started" },
              { ordinal: 1, conversationId: "65656565-6565-4565-8565-656565656565", turnId: null, dispatchState: "started" },
            ],
            comparison: {
              state: "failed",
              conversationId: judgeId,
              turnId: null,
              attempt: 1,
              error: "The judge turn failed: provider exited.",
            },
          },
        } as ServerEvent;
      }
      return await sendCommand(command);
    };
    harness.connection = { ...connectionFor(snapshot), sendCommand: duoCommand };
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    render(<DetachedChatApp initialWindowContext={context} />);

    expect(await screen.findByText("Judge didn't finish")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("closes the window with Command+W and ignores other W chords", async () => {
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

  it("shows the transcript in the first commit that shows the loaded chat", async () => {
    const turn = taskTurn({
      id: "preloaded-turn",
      conversationId,
      userMessageId: "preloaded-message",
      status: "completed",
      completedAt: "2030-01-01T00:02:00.000Z",
    });
    harnessDetail.current = {
      ...detail,
      agentTurns: [turn],
      messages: [{
        id: "preloaded-message",
        conversationId,
        turnId: turn.id,
        role: "user",
        content: "Preloaded transcript request.",
        attachments: [],
        createdAt: turn.requestedAt,
      }],
    };
    vi.resetModules();
    const { default: DetachedChatApp } = await import("../../src/renderer/src/DetachedChatApp");
    await act(async () => { await vi.dynamicImportSettled(); });
    const transcriptInCommit: boolean[] = [];
    render(<Profiler id="detached-transcript" onRender={() => {
      const scroll = document.querySelector(".message-scroll");
      if (!scroll || scroll.closest("[aria-busy='true']")) return;
      transcriptInCommit.push(scroll.textContent?.includes("Preloaded transcript request.") ?? false);
    }}><DetachedChatApp initialWindowContext={context} /></Profiler>);

    expect(await screen.findByText("Preloaded transcript request.")).toBeInTheDocument();
    expect(transcriptInCommit.length).toBeGreaterThan(0);
    expect(transcriptInCommit).not.toContain(false);
  });
});
