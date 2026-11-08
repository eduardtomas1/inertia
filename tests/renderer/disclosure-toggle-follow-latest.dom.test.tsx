import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatWorkspace } from "../../src/renderer/src/components/ChatWorkspace";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
  Conversation,
  Project,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { createStreamingAgentStore } from "../../src/renderer/src/hooks/useStreamingAgentState";
import { forgetTranscriptPosition } from "../../src/renderer/src/utils/transcriptPosition";

vi.mock("../../src/renderer/src/hooks/useNativePreviewSuspension", () => ({
  useNativePreviewSuspension: () => undefined,
}));

vi.mock("../../src/renderer/src/components/Composer", () => ({
  Composer: () => <div data-testid="disclosure-composer" />,
}));

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Disclosure project",
  path: "/disclosure-project",
  normalizedPath: "/disclosure-project",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#5555ff",
  status: "ready",
  createdAt: "2026-08-02T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
};

const conversation: Conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: project.id,
  title: "Disclosure follow fixture",
  providerId: "codex",
  modelSelection: providerNativeModelSelection({
    providerId: "codex",
    modelId: "provider-default",
    reasoningEffort: "high",
  }),
  continuationIdentity: null,
  model: "",
  reasoningEffort: "high",
  interactionMode: "build",
  accessMode: "supervised",
  status: "completed",
  attentionKind: null,
  branch: "main",
  worktreePath: null,
  providerSessionId: null,
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: null,
  createdAt: "2026-08-02T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
};

function turn(index: number): AgentTurn {
  const at = `2026-08-02T10:00:${String(index).padStart(2, "0")}.000Z`;
  return {
    id: `turn-${index}`,
    conversationId: conversation.id,
    runId: `run-${index}`,
    userMessageId: `request-${index}`,
    terminalAssistantMessageId: `answer-${index}`,
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    continuationIdentity: {
      harnessId: conversation.modelSelection.harnessId,
      backendProfileId: conversation.modelSelection.backendProfileId,
      backendConfigurationRevision: conversation.modelSelection.backendConfigurationRevision,
      endpointIdentity: null,
      modelIdentity: conversation.modelSelection.modelId,
    },
    harnessId: conversation.modelSelection.harnessId,
    backendProfileId: conversation.modelSelection.backendProfileId,
    model: conversation.modelSelection.modelId,
    modelAlias: conversation.modelSelection.alias,
    reasoningEffort: conversation.reasoningEffort,
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at,
    updatedAt: at,
  };
}

function messages(index: number): ChatMessage[] {
  const at = `2026-08-02T10:00:${String(index).padStart(2, "0")}.000Z`;
  return [
    {
      id: `request-${index}`,
      conversationId: conversation.id,
      turnId: `turn-${index}`,
      role: "user",
      content: `Request ${index}`,
      attachments: [],
      createdAt: at,
    },
    {
      id: `answer-${index}`,
      conversationId: conversation.id,
      turnId: `turn-${index}`,
      role: "assistant",
      content: `Final answer ${index}`,
      attachments: [],
      createdAt: at,
    },
  ];
}

const readActivity: AgentActivity = {
  id: "read-activity",
  conversationId: conversation.id,
  runId: "run-2",
  turnId: "turn-2",
  kind: "tool",
  title: "Read src/renderer/main.ts",
  detail: "Output:\nimport { createRoot } from \"react-dom/client\";\ncreateRoot(document.body);",
  status: "completed",
  createdAt: "2026-08-02T10:00:02.000Z",
};

function workspaceProps(): ComponentProps<typeof ChatWorkspace> {
  const store = createStreamingAgentStore();
  store.update(["", "", null]);
  return {
    project,
    conversation,
    latestTurnSummary: null,
    turns: [turn(1), turn(2)],
    messages: [...messages(1), ...messages(2)],
    activities: [readActivity],
    subagents: [],
    reasonings: [],
    plans: [],
    checkpoints: [],
    turnGitArtifacts: [],
    usage: null,
    skills: [],
    skillsCapability: null,
    skillsLoading: false,
    skillsError: null,
    approvals: [],
    inputRequests: [],
    providers: [],
    backendProfiles: [],
    maintenanceStatus: null,
    maintenanceOperation: null,
    actions: [],
    mentionResults: [],
    showTimestamps: false,
    showThinking: false,
    usageDisplayMode: "compact",
    responseDensity: "default",
    defaultCodeWrap: false,
    autoCollapseWorkLog: false,
    showChangedFileSummaries: false,
    autoScrollToFinalAnswer: false,
    loading: false,
    sending: false,
    streaming: store,
    onAddProject: () => undefined,
    onCreateConversation: () => undefined,
    onSendMessage: async () => null,
    onListSkills: async () => undefined,
    onRespondToApproval: async () => undefined,
    onRespondToInput: async () => undefined,
    onUpdateConversation: async () => undefined,
    onChooseAttachments: async () => null,
    onImportAttachments: async () => null,
    onReleaseAttachment: async () => undefined,
    onRunAction: () => undefined,
    onMentionQuery: () => undefined,
    onConnectProvider: () => undefined,
    onRefreshProvider: () => undefined,
    onOpenProviderSetup: () => undefined,
    onOpenBackendSetup: () => undefined,
    onProbeBackendProfile: async () => undefined,
    onRefreshProviderMaintenance: async () => undefined,
    onUpdateProvider: async () => undefined,
    onCancelProviderUpdate: async () => undefined,
    onOpenProviderUpdateInstructions: () => undefined,
    onOpenResume: () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onStop: async () => undefined,
    onRevertCheckpoint: () => undefined,
    onOpenTurnDiff: () => undefined,
    onCompareTurnArtifacts: () => undefined,
    onOpenTurnFile: () => undefined,
  };
}

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 800,
    bottom: top + height,
    left: 0,
    width: 800,
    height,
    toJSON: () => ({}),
  };
}

type Layout = { viewport: number; rows: [number, number] };

async function renderDisclosureScene(initial: Layout) {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element): void { this.targets.add(target); }
    unobserve(target: Element): void { this.targets.delete(target); }
    disconnect(): void { this.targets.clear(); }
    notify(): void {
      const entries = [...this.targets].map((target) => ({
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      }));
      if (entries.length > 0) this.callback(entries, this);
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);

  const layout = { viewport: initial.viewport, rows: [...initial.rows] as [number, number] };
  const contentHeight = (): number => layout.rows[0] + layout.rows[1];
  let scrollTop = 0;
  const clamp = (top: number): number =>
    Math.max(0, Math.min(top, contentHeight() - layout.viewport));

  render(<ChatWorkspace {...workspaceProps()} />);
  const transcript = screen.getByLabelText("Thread transcript");
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, get: () => layout.viewport },
    scrollHeight: { configurable: true, get: () => Math.max(contentHeight(), layout.viewport) },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = clamp(value); },
    },
  });
  transcript.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    transcript.scrollTop = typeof options === "number" ? y ?? 0 : options?.top ?? scrollTop;
  }) as typeof transcript.scrollTo;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this === transcript) return rect(0, layout.viewport);
      const rowId = this.dataset.responseRowId;
      if (rowId === "turn-1") return rect(-scrollTop, layout.rows[0]);
      if (rowId === "turn-2") return rect(layout.rows[0] - scrollTop, layout.rows[1]);
      return rect(0, 0);
    });

  const flush = async (): Promise<void> => {
    await act(async () => {
      let remaining = 200;
      while (frames.size > 0 && remaining > 0) {
        const [id, callback] = frames.entries().next().value!;
        frames.delete(id);
        callback(performance.now());
        remaining -= 1;
        await Promise.resolve();
      }
    });
  };
  const settleLayout = async (rows: [number, number]): Promise<void> => {
    const before = scrollTop;
    layout.rows = rows;
    act(() => {
      for (const observer of observers) observer.notify();
    });
    await flush();
    if (scrollTop !== before) {
      act(() => {
        fireEvent.scroll(transcript);
      });
      await flush();
    }
  };
  const toggleOutput = async (rows: [number, number]): Promise<void> => {
    const output = screen.getByRole("button", { name: /^Output: /u });
    fireEvent.click(output);
    expect(output).toHaveAttribute("aria-expanded", "true");
    await settleLayout(rows);
  };

  transcript.scrollTop = Number.MAX_SAFE_INTEGER;
  await flush();
  return { transcript, flush, toggleOutput };
}

beforeAll(async () => {
  await import("../../src/renderer/src/components/ResponseTimeline");
});

afterEach(() => {
  cleanup();
  forgetTranscriptPosition(conversation.id);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("disclosure toggles and following the latest message", () => {
  it("keeps following when a disclosure opens in a transcript that fits its viewport", async () => {
    const { transcript, toggleOutput } = await renderDisclosureScene({ viewport: 600, rows: [200, 200] });
    expect(transcript.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    await toggleOutput([200, 320]);

    expect(transcript.scrollTop).toBe(0);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it.each([
    { start: "fits", rows: [200, 200] as [number, number], bottom: 0 },
    { start: "overflows", rows: [300, 500] as [number, number], bottom: 200 },
  ])("stays at the latest message when a disclosure opened at the bottom overflows the viewport ($start)", async ({ rows, bottom }) => {
    const { transcript, toggleOutput } = await renderDisclosureScene({ viewport: 600, rows });
    expect(transcript.scrollTop).toBe(bottom);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    await toggleOutput([rows[0], rows[1] + 700]);

    expect(transcript.scrollTop).toBe(rows[0] + 700 + rows[1] - 600);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("keeps a reader who scrolled up anchored to the toggled row and keeps Jump to latest", async () => {
    const { transcript, flush, toggleOutput } = await renderDisclosureScene({ viewport: 400, rows: [300, 600] });
    expect(transcript.scrollTop).toBe(500);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.wheel(transcript, { deltaY: -300 });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);
    await act(async () => vi.advanceTimersByTime(750));
    vi.useRealTimers();
    await flush();
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();

    await toggleOutput([350, 900]);

    expect(transcript.scrollTop).toBe(150);
    expect(document.querySelector<HTMLElement>('[data-response-row-id="turn-2"]')!
      .getBoundingClientRect().top).toBe(200);
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  });
});
