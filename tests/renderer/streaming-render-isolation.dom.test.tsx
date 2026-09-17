import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentTurn,
  type AppSnapshot,
  type ChatMessage,
  type ConversationDetail,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import { continuationIdentityForSelection } from "../../src/shared/model-routing";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

const counting = vi.hoisted(() => {
  const renders: Record<string, number> = {};
  const memoType = Symbol.for("react.memo");
  type Render = (props: object) => unknown;
  type Memo = { $$typeof: symbol; type: Render; compare: null | ((left: object, right: object) => boolean) };
  function counted<Component>(
    name: string,
    component: Component,
    memo: (render: Render, compare?: (left: object, right: object) => boolean) => unknown,
  ): Component {
    const target = component as unknown as Memo | Render;
    const inner = typeof target === "function" ? target : target.type;
    const wrapped = (props: object) => {
      renders[name] = (renders[name] ?? 0) + 1;
      return inner(props);
    };
    if (typeof target === "function" || target.$$typeof !== memoType) {
      return wrapped as unknown as Component;
    }
    return memo(wrapped, target.compare ?? undefined) as Component;
  }
  return { renders, counted };
});

const harness = vi.hoisted(() => ({
  connection: null as unknown,
  listeners: new Set<(event: unknown) => void>(),
}));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));
vi.mock("../../src/renderer/src/components/AppLayout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/AppLayout")>();
  const { memo } = await import("react");
  return { ...actual, AppLayout: counting.counted("AppLayout", actual.AppLayout, memo as never) };
});
vi.mock("../../src/renderer/src/components/Sidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/Sidebar")>();
  const { memo } = await import("react");
  return { ...actual, Sidebar: counting.counted("Sidebar", actual.Sidebar, memo as never) };
});
vi.mock("../../src/renderer/src/components/WorkspaceHeader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/WorkspaceHeader")>();
  const { memo } = await import("react");
  return { ...actual, WorkspaceHeader: counting.counted("WorkspaceHeader", actual.WorkspaceHeader, memo as never) };
});
vi.mock("../../src/renderer/src/components/WorkspaceScene", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/WorkspaceScene")>();
  const { memo } = await import("react");
  return { ...actual, WorkspaceScene: counting.counted("WorkspaceScene", actual.WorkspaceScene, memo as never) };
});
vi.mock("../../src/renderer/src/components/ChatWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/ChatWorkspace")>();
  const { memo } = await import("react");
  return { ...actual, ChatWorkspace: counting.counted("ChatWorkspace", actual.ChatWorkspace, memo as never) };
});
vi.mock("../../src/renderer/src/components/Composer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/Composer")>();
  const { memo } = await import("react");
  return { ...actual, Composer: counting.counted("Composer", actual.Composer, memo as never) };
});
vi.mock("../../src/renderer/src/components/response-timeline/viewport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/response-timeline/viewport")>();
  const { memo } = await import("react");
  return { ...actual, ResponseTimeline: counting.counted("ResponseTimeline", actual.ResponseTimeline, memo as never) };
});
vi.mock("../../src/renderer/src/components/response-timeline/turn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/response-timeline/turn")>();
  const { memo } = await import("react");
  return { ...actual, TurnTimeline: counting.counted("TurnTimeline", actual.TurnTimeline, memo as never) };
});

const TOKENS = 200;
const COUNTED_SHELL = [
  "App",
  "AppLayout",
  "Sidebar",
  "WorkspaceHeader",
  "WorkspaceScene",
  "ChatWorkspace",
  "Composer",
  "ResponseTimeline",
  "TurnTimeline",
] as const;
const projectId = "51515151-5151-4151-8151-515151515151";
const conversationId = "52525252-5252-4252-8252-525252525252";
const now = "2026-09-15T10:00:00.000Z";
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
const draft = buildDraftConversation(
  buildNewConversationPayload(projectId, defaultSettings),
  { id: conversationId, now },
);
const selection = draft.modelSelection;
const turn: AgentTurn = {
  id: "streaming-turn",
  conversationId,
  runId: "streaming-run",
  userMessageId: "streaming-request",
  terminalAssistantMessageId: null,
  providerId: draft.providerId,
  modelSelection: selection,
  continuationIdentity: continuationIdentityForSelection(selection),
  harnessId: selection.harnessId,
  backendProfileId: selection.backendProfileId,
  model: selection.modelId,
  modelAlias: selection.alias,
  reasoningEffort: selection.reasoningEffort ?? "medium",
  interactionMode: "build",
  accessMode: "supervised",
  providerSessionBefore: null,
  providerSessionAfter: null,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  status: "running",
  terminalReason: null,
  checkpointId: null,
  usageAtStart: null,
  usageAtCompletion: null,
  configurationRevision: selection.backendConfigurationRevision,
  association: "authoritative",
  createdAt: now,
  updatedAt: now,
};
const conversation = {
  ...draft,
  title: "Streaming chat",
  status: "running" as const,
  latestTurn: {
    id: turn.id,
    runId: turn.runId,
    status: "running" as const,
    providerId: draft.providerId,
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    modelSelection: selection,
    continuationIdentity: continuationIdentityForSelection(selection),
    model: selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? "medium",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    terminalReason: null,
    updatedAt: now,
  },
  pendingApproval: false,
  pendingInput: false,
};
const request: ChatMessage = {
  id: turn.userMessageId,
  conversationId,
  turnId: turn.id,
  role: "user",
  content: "Explain the streaming path.",
  attachments: [],
  createdAt: now,
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
  agentTurns: [turn],
  turnGitArtifacts: [],
  messages: [request],
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

function emit(event: ServerEvent): void {
  for (const listener of harness.listeners) listener(event);
}

beforeEach(async () => {
  harness.listeners.clear();
  harness.connection = {
    snapshot,
    runtimeGeneration: "streaming-generation",
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
          result: {
            kind: "conversation.detail",
            conversationId,
            state: "ready",
            detail,
          },
        } as unknown as ServerEvent;
      }
      return await new Promise<ServerEvent>(() => undefined);
    },
    subscribe: (listener) => {
      harness.listeners.add(listener as (event: unknown) => void);
      return () => {
        harness.listeners.delete(listener as (event: unknown) => void);
      };
    },
  } satisfies InertiaConnection;
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
  // Measure streaming renders after the real lazy transcript module is ready.
  await import("../../src/renderer/src/components/ResponseTimeline");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "inertia");
});

describe("streamed agent text", () => {
  it("re-renders only the transcript for each token", async () => {
    // LiveElapsed ticks independently of token delivery. Keep its clock fixed
    // while counting token commits, including on slower Windows workers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { default: App } = await import("../../src/renderer/src/App");
    let commits = 0;
    function CountedApp(): React.JSX.Element {
      counting.renders.App = (counting.renders.App ?? 0) + 1;
      return App();
    }
    const view = render(
      <Profiler id="app" onRender={() => { commits += 1; }}>
        <CountedApp />
      </Profiler>,
    );
    await waitFor(() => expect(
      view.container.querySelector(`[data-turn-id="${turn.id}"]`),
    ).not.toBeNull());
    let quietCycles = 0;
    for (let cycle = 0; cycle < 200 && quietCycles < 3; cycle += 1) {
      const commitsBefore = commits;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      const mounted = COUNTED_SHELL.every((name) => (counting.renders[name] ?? 0) > 0);
      quietCycles = mounted && commits === commitsBefore ? quietCycles + 1 : 0;
    }
    expect(COUNTED_SHELL.filter((name) => !counting.renders[name])).toEqual([]);

    for (const name of Object.keys(counting.renders)) counting.renders[name] = 0;
    commits = 0;
    for (let index = 0; index < TOKENS; index += 1) {
      act(() => {
        emit({
          type: "agent.text",
          conversationId,
          runId: turn.runId,
          turnId: turn.id,
          text: `token${index} `,
        });
      });
    }
    expect({ commits, ...counting.renders }).toEqual({
      commits: TOKENS,
      App: 0,
      AppLayout: 0,
      Sidebar: 0,
      WorkspaceHeader: 0,
      WorkspaceScene: 0,
      ChatWorkspace: 0,
      Composer: 0,
      ResponseTimeline: TOKENS,
      TurnTimeline: TOKENS,
    });
    await waitFor(() => expect(view.container.textContent)
      .toContain(`token${TOKENS - 1}`));
  });

  it("reveals each streamed word in its own commit behind the caret", async () => {
    const { default: App } = await import("../../src/renderer/src/App");
    const view = render(<App />);
    await waitFor(() => expect(
      view.container.querySelector(`[data-turn-id="${turn.id}"]`),
    ).not.toBeNull());
    const words = Array.from({ length: 12 }, (_, index) => `word${index}`);
    const revealed: Element[] = [];
    for (const [index, word] of words.entries()) {
      act(() => {
        emit({
          type: "agent.text",
          conversationId,
          runId: turn.runId,
          turnId: turn.id,
          text: index === 0 ? word : ` ${word}`,
        });
      });
      const spans = [...view.container.querySelectorAll(
        `[data-turn-id="${turn.id}"] [data-stream-motion="word-reveal"] .response-stream-word`,
      )];
      expect(spans.map((span) => span.textContent))
        .toEqual(words.slice(0, index + 1));
      expect(revealed.every((span, position) => spans[position] === span))
        .toBe(true);
      expect(spans[index]!.parentElement!.lastElementChild).toBe(spans[index]);
      revealed.push(spans[index]!);
    }
  });
});
