import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AgentActivity,
  type AgentPlan,
  type AgentTurn,
  type ChatMessage,
  type ConversationShell,
  type Project,
  type WorkspaceRun,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { usePlanSteps } from "../../src/renderer/src/hooks/usePlanSteps";
import { createStreamingAgentStore } from "../../src/renderer/src/hooks/useStreamingAgentState";
import { planFromText } from "../../src/renderer/src/utils/planFromText";
import {
  markdownReferenceDefinitions,
  splitStreamingMarkdown,
} from "../../src/renderer/src/utils/streamingMarkdownSplit";
import { applyConversationShellEvent } from "../../src/renderer/src/utils/runtimeSnapshotProjection";
import { sidebarThreadViewMap } from "../../src/renderer/src/utils/sidebarModel";
import { conversationWorkspaceOptions } from "../../src/renderer/src/components/workspace-scene/conversationWorkspaceOptions";
import { buildWorkspaceSurfaceSummary } from "../../src/renderer/src/utils/environmentSummary";
import { useComposerSkillCompletion } from "../../src/renderer/src/components/composer/useComposerSkillCompletion";
import { useTextareaAutosize } from "../../src/renderer/src/components/composer/useTextareaAutosize";
import {
  buildResponseTimeline,
  stabilizeResponseTimeline,
  updateResponseTimelineForActivityDelta,
} from "../../src/renderer/src/utils/response-timeline/model";
import {
  captureVirtualizedTranscriptPosition,
  createCoalescedScrollRemember,
} from "../../src/renderer/src/components/response-timeline/row-lookup";
import {
  appendStreamingReasoning,
  appendStreamingText,
  compareCreatedRecords,
  mergeProjectionRecords,
  sameAgentPlan,
  sameAgentPlanSteps,
} from "../../src/renderer/src/utils/terminalTurnProjection";
import { deliverDecodedServerEventSync } from "../../src/renderer/src/utils/connectionMessages";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConversation(index: number, overrides: Partial<ConversationShell> = {}): ConversationShell {
  const updatedAt = new Date(Date.parse("2026-10-25T12:00:00.000Z") - index * 60_000).toISOString();
  return {
    id: `conv-${String(index).padStart(4, "0")}`,
    projectId: `proj-${index % 3}`,
    title: `Chat ${index}`,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: updatedAt,
    lastViewedAt: updatedAt,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: updatedAt,
    updatedAt,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

describe("Proposal 1 invariants: streaming delta hot path", () => {
  it("gates usePlanSteps subscription when streamedEnabled is false and short-circuits reasoning deltas", () => {
    const store = createStreamingAgentStore();
    const subscribeSpy = vi.spyOn(store, "subscribe");
    const buildHook = renderHook(() => usePlanSteps([], [], "running", store, false));
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(buildHook.result.current).toEqual([]);

    const planHook = renderHook(() => usePlanSteps([], [], "running", store, true));
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    act(() => store.update(["1. First step\n2. Second step", "", "text"]));
    const initial = planHook.result.current;
    expect(initial).toHaveLength(2);

    act(() => store.update(["1. First step\n2. Second step", "Thinking step 1", "reasoning"]));
    act(() => store.update(["1. First step\n2. Second step", "Thinking step 1 and 2", "reasoning"]));
    expect(planHook.result.current).toBe(initial);
  });

  it("caps planFromText at 20 steps without scanning trailing lines", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `- Step item ${i + 1}`).join("\n");
    const steps = planFromText("", "running", lines);
    expect(steps).toHaveLength(20);
    expect(steps[0]).toMatchObject({ id: "step-0", status: "in-progress", source: "streamed" });
    expect(steps[19]).toMatchObject({ id: "step-19", status: "pending", source: "streamed" });
  });

  it("coalesces same-channel streaming updates into one rAF notification and flushes transitions synchronously", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const store = createStreamingAgentStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.update(["a", "", "text"]);
    expect(listener).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 20; index += 1) {
      store.update([`a${index}`, "", "text"]);
    }
    expect(store.getSnapshot()[0]).toBe("a19");
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(20);
    expect(listener).toHaveBeenCalledTimes(2);

    // Channel switch cancels pending rAF and notifies immediately.
    store.update(["a19x", "", "text"]);
    expect(listener).toHaveBeenCalledTimes(2);
    store.update(["a19x", "reason", "reasoning"]);
    expect(listener).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(20);
    expect(listener).toHaveBeenCalledTimes(3);

    // Unsubscribing last listener cancels pending frame.
    store.update(["a19x", "reason more", "reasoning"]);
    unsubscribe();
    vi.advanceTimersByTime(20);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("caches reference definitions incrementally on StreamingMarkdownSplit", () => {
    let split = splitStreamingMarkdown("Intro [doc][d]\n\n");
    split = splitStreamingMarkdown("Intro [doc][d]\n\n[d]: https://example.com\n\nTail", split);
    expect(split.definitions).toBe(markdownReferenceDefinitions(split.blocks));
    expect(split.definitions).toBe("[d]: https://example.com");
  });
});

describe("Proposal 2 invariants: sidebar, shell projection, and workspace options", () => {
  it("reuses unchanged SidebarThreadView objects across active chat switches and single mutations", () => {
    const conversations = Array.from({ length: 100 }, (_, i) => makeConversation(i));
    const first = sidebarThreadViewMap(conversations, conversations[0]!.id, []);
    const switched = sidebarThreadViewMap(conversations, conversations[1]!.id, []);

    let reused = 0;
    for (let i = 2; i < conversations.length; i += 1) {
      if (switched.get(conversations[i]!.id) === first.get(conversations[i]!.id)) reused += 1;
    }
    expect(reused).toBe(98);

    const mutated = conversations.slice();
    mutated[5] = { ...mutated[5]!, title: "Renamed" };
    const afterMutation = sidebarThreadViewMap(mutated, conversations[1]!.id, []);
    expect(afterMutation.get(conversations[5]!.id)).not.toBe(switched.get(conversations[5]!.id));
    expect(afterMutation.get(conversations[4]!.id)).toBe(switched.get(conversations[4]!.id));
  });

  it("maintains sorted order in applyConversationShellEvent and preserves references on no-op collections", () => {
    const conversations = Array.from({ length: 10 }, (_, i) => makeConversation(i));
    const snapshot = {
      projects: [],
      conversations,
      runs: [] as WorkspaceRun[],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: "proj-0",
      activeConversationId: conversations[0]!.id,
    };
    const bumped = { ...conversations[8]!, updatedAt: "2026-10-26T00:00:00.000Z" };
    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: bumped,
      runs: [],
    });
    expect(next.conversations[0]).toBe(bumped);
    expect(next.conversations).toHaveLength(10);
    expect(next.runs).toBe(snapshot.runs);
  });

  it("matches sorted and unsorted conversationWorkspaceOptions identically", () => {
    const projects: Project[] = [0, 1, 2].map((i) => ({
      id: `proj-${i}`,
      name: `Project ${i}`,
      path: `/work/proj-${i}`,
      normalizedPath: `/work/proj-${i}`,
      repositoryIdentity: null,
      repositoryRoot: null,
      repositoryRelativePath: "",
      groupingMode: null,
      gitRepositoryLimit: 64,
      color: "#6366f1",
      status: "ready",
      createdAt: "2026-10-25T10:00:00.000Z",
      updatedAt: "2026-10-25T10:00:00.000Z",
    }));
    const sorted = Array.from({ length: 20 }, (_, i) => makeConversation(i));
    const unsorted = [...sorted].reverse();
    const active = sorted[4]!;
    const fromSorted = conversationWorkspaceOptions({
      conversations: sorted,
      projects,
      providers: [],
      persistedConversationId: active.id,
      conversation: active,
      project: projects[1]!,
      workspaceToolsUnavailable: false,
    });
    const fromUnsorted = conversationWorkspaceOptions({
      conversations: unsorted,
      projects,
      providers: [],
      persistedConversationId: active.id,
      conversation: active,
      project: projects[1]!,
      workspaceToolsUnavailable: false,
    });
    expect(fromSorted).toEqual(fromUnsorted);
    expect(fromSorted.resumeOptions[0]?.conversationId).toBe(active.id);
  });

  it("skips conversation indexing in buildWorkspaceSurfaceSummary when no runs are visible", () => {
    const summary = buildWorkspaceSurfaceSummary({
      projectId: "proj-0",
      conversationId: "conv-0000",
      connectionStatus: "online",
      workspaceGitStatus: null,
      runs: [],
      messages: [],
      conversations: Array.from({ length: 50 }, (_, i) => makeConversation(i)),
    });
    expect(summary.checks).toEqual([]);
    expect(summary.localServers).toEqual([]);
  });
});

describe("Proposal 3 invariants: composer skill completion and textarea autosize", () => {
  it("skips selection state updates when there is no $ trigger in the draft", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useComposerSkillCompletion([], "plain typing without trigger", false);
    });
    renders = 0;
    act(() => {
      result.current.onSkillSelectionChange({
        value: "plain typing without trigger",
        selectionStart: 5,
        selectionEnd: 5,
      } as HTMLTextAreaElement);
      result.current.onSkillSelectionChange({
        value: "plain typing without trigger",
        selectionStart: 12,
        selectionEnd: 12,
      } as HTMLTextAreaElement);
    });
    expect(renders).toBe(0);
    expect(result.current.skillQuery).toBeNull();
  });

  it("skips scrollHeight reflows while textarea is clamped at 200px and growing", () => {
    let scrollHeightReads = 0;
    let currentScrollHeight = 260;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return currentScrollHeight;
      },
    });
    try {
      function Field({ content }: { content: string }): React.JSX.Element {
        const ref = useRef<HTMLTextAreaElement>(null);
        useTextareaAutosize(ref, content);
        return <textarea ref={ref} aria-label="Message" value={content} readOnly />;
      }
      const base = "line\n".repeat(15);
      const view = render(<Field content={base} />);
      expect(scrollHeightReads).toBe(1);

      view.rerender(<Field content={`${base}a`} />);
      view.rerender(<Field content={`${base}ab`} />);
      view.rerender(<Field content={`${base}abc`} />);
      expect(scrollHeightReads).toBe(1);

      // Equal-length edit that changes wrapping (not a strict append) re-measures.
      currentScrollHeight = 140;
      const equalLengthFlat = "x".repeat(`${base}abc`.length);
      view.rerender(<Field content={equalLengthFlat} />);
      expect(scrollHeightReads).toBe(2);
      const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
      expect(textarea.style.height).toBe("140px");
      expect(textarea.style.overflowY).toBe("hidden");

      // Exactly 200px with hidden overflow must still re-measure on append so overflow can turn on.
      currentScrollHeight = 200;
      view.rerender(<Field content="exact-200" />);
      expect(scrollHeightReads).toBe(3);
      expect(textarea.style.overflowY).toBe("hidden");
      currentScrollHeight = 220;
      view.rerender(<Field content="exact-200!" />);
      expect(scrollHeightReads).toBe(4);
      expect(textarea.style.overflowY).toBe("auto");

      // Shrinking re-measures.
      currentScrollHeight = 80;
      view.rerender(<Field content="short" />);
      expect(scrollHeightReads).toBe(5);
      expect(textarea.style.height).toBe("80px");
      expect(textarea.style.overflowY).toBe("hidden");
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    }
  });
});

describe("Proposal 5 invariants: timeline delta patching and virtualized scroll tracking", () => {
  it("patches only the changed turn on single-activity deltas and matches full buildResponseTimeline", () => {
    const selection = providerNativeModelSelection({ providerId: "codex" });
    const turns: AgentTurn[] = [0, 1, 2].map((i) => ({
      id: `turn-${i}`,
      conversationId: "conv-1",
      runId: `run-${i}`,
      userMessageId: `msg-u-${i}`,
      terminalAssistantMessageId: null,
      providerId: "codex",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection),
      harnessId: selection.harnessId,
      backendProfileId: selection.backendProfileId,
      model: selection.modelId,
      modelAlias: null,
      reasoningEffort: "medium",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      providerSessionAfter: null,
      requestedAt: `2026-10-25T10:0${i}:00.000Z`,
      startedAt: `2026-10-25T10:0${i}:01.000Z`,
      completedAt: i < 2 ? `2026-10-25T10:0${i}:30.000Z` : null,
      status: i < 2 ? "completed" : "running",
      terminalReason: null,
      checkpointId: null,
      usageAtStart: null,
      usageAtCompletion: null,
      configurationRevision: 1,
      association: "authoritative",
      createdAt: `2026-10-25T10:0${i}:00.000Z`,
      updatedAt: `2026-10-25T10:0${i}:30.000Z`,
    }));
    const messages: ChatMessage[] = turns.map((turn, i) => ({
      id: turn.userMessageId,
      conversationId: "conv-1",
      turnId: turn.id,
      role: "user",
      content: `Prompt ${i}`,
      attachments: [],
      createdAt: turn.requestedAt,
    }));
    const initialActivities: AgentActivity[] = [
      {
        id: "act-1",
        conversationId: "conv-1",
        runId: "run-2",
        turnId: "turn-2",
        kind: "command",
        title: "Run tests",
        detail: "running...",
        status: "running",
        createdAt: "2026-10-25T10:02:02.000Z",
      },
    ];
    const baseInput = {
      turns,
      messages,
      activities: initialActivities,
      reasonings: [],
      checkpoints: [],
    };
    const initialTimeline = buildResponseTimeline(baseInput);
    const updatedActivities: AgentActivity[] = [
      { ...initialActivities[0]!, status: "completed", detail: "passed" },
      {
        id: "act-2",
        conversationId: "conv-1",
        runId: "run-2",
        turnId: "turn-2",
        kind: "tool",
        title: "Read file",
        detail: null,
        status: "completed",
        createdAt: "2026-10-25T10:02:05.000Z",
      },
    ];
    const nextInput = { ...baseInput, activities: updatedActivities };
    const patched = updateResponseTimelineForActivityDelta(
      nextInput,
      initialActivities,
      initialTimeline,
    );
    expect(patched).not.toBeNull();
    expect(patched).toEqual(buildResponseTimeline(nextInput));
    expect(patched![0]).toBe(initialTimeline[0]);
    expect(patched![1]).toBe(initialTimeline[1]);
    const stabilized = stabilizeResponseTimeline(patched!, initialTimeline);
    expect(stabilized[0]).toBe(initialTimeline[0]);
    expect(stabilized[1]).toBe(initialTimeline[1]);
  });

  it("captures virtualized scroll position without DOM queries and coalesces scroll events to one rAF", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const root = document.createElement("div");
    const scroll = document.createElement("div");
    Object.defineProperties(scroll, {
      scrollTop: { value: 250, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 2_000, configurable: true },
    });
    const querySpy = vi.spyOn(root, "querySelectorAll");
    const pos = captureVirtualizedTranscriptPosition(
      root,
      scroll,
      [
        { index: 0, start: 0, end: 200 },
        { index: 1, start: 200, end: 520 },
      ],
      [{ id: "turn-0" }, { id: "turn-1" }],
      false,
    );
    expect(querySpy).not.toHaveBeenCalled();
    expect(pos).toEqual({
      rowId: "turn-1",
      viewportOffset: -50,
      scrollTop: 250,
      wasFollowing: false,
    });

    // Accounts for virtual window origin (padding/history controls above virtual list) and measures row offset.
    const virtualWindow = document.createElement("div");
    virtualWindow.className = "response-virtual-window";
    virtualWindow.getBoundingClientRect = () => ({ top: -150, bottom: 370, left: 0, right: 800, width: 800, height: 520, x: 0, y: -150, toJSON: () => ({}) } as DOMRect);
    const article = document.createElement("article");
    article.dataset.index = "0";
    const rowEl = document.createElement("div");
    rowEl.dataset.responseRowId = "turn-0";
    rowEl.getBoundingClientRect = () => ({ top: -140, bottom: 60, left: 0, right: 800, width: 800, height: 200, x: 0, y: -140, toJSON: () => ({}) } as DOMRect);
    article.appendChild(rowEl);
    virtualWindow.appendChild(article);
    root.appendChild(virtualWindow);
    scroll.getBoundingClientRect = () => ({ top: 20, bottom: 520, left: 0, right: 800, width: 800, height: 500, x: 0, y: 20, toJSON: () => ({}) } as DOMRect);
    // windowOrigin = (-150 - 20 + 250) = 80; threshold = 250 - 80 + 8 = 178 -> item 0 (end 200 > 178) is still visible!
    const offsetPos = captureVirtualizedTranscriptPosition(
      root,
      scroll,
      [
        { index: 0, start: 0, end: 200 },
        { index: 1, start: 200, end: 520 },
      ],
      [{ id: "turn-0" }, { id: "turn-1" }],
      false,
    );
    expect(querySpy).not.toHaveBeenCalled();
    expect(offsetPos).toEqual({
      rowId: "turn-0",
      viewportOffset: -160,
      scrollTop: 250,
      wasFollowing: false,
    });

    // When the viewport starts inside turn-0's bottom turn-gap padding, turn-0's row bottom is <= scrollTopRect + 8
    // and capture must skip turn-0 and anchor to turn-1 instead.
    rowEl.getBoundingClientRect = () => ({ top: -156, bottom: 24, left: 0, right: 800, width: 800, height: 180, x: 0, y: -156, toJSON: () => ({}) } as DOMRect);
    const article1 = document.createElement("article");
    article1.dataset.index = "1";
    const rowEl1 = document.createElement("div");
    rowEl1.dataset.responseRowId = "turn-1";
    rowEl1.getBoundingClientRect = () => ({ top: 44, bottom: 344, left: 0, right: 800, width: 800, height: 300, x: 0, y: 44, toJSON: () => ({}) } as DOMRect);
    article1.appendChild(rowEl1);
    virtualWindow.appendChild(article1);
    const gapPos = captureVirtualizedTranscriptPosition(
      root,
      scroll,
      [
        { index: 0, start: 0, end: 200 },
        { index: 1, start: 200, end: 520 },
      ],
      [{ id: "turn-0" }, { id: "turn-1" }],
      false,
    );
    expect(querySpy).not.toHaveBeenCalled();
    expect(gapPos).toEqual({
      rowId: "turn-1",
      viewportOffset: 24,
      scrollTop: 250,
      wasFollowing: false,
    });

    const onCapture = vi.fn();
    const coalesced = createCoalescedScrollRemember(onCapture);
    for (let i = 0; i < 15; i += 1) coalesced.schedule();
    expect(onCapture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(onCapture).toHaveBeenCalledTimes(1);

    coalesced.schedule();
    coalesced.dispose();
    expect(onCapture).toHaveBeenCalledTimes(2);
  });
});

describe("Proposal 6 invariants: synchronous WS decode and zero-copy projection merge", () => {
  it("returns persisted array unchanged when live is empty and strictly ordered", () => {
    const persisted = [
      { id: "a", createdAt: "2026-10-25T10:00:00.000Z" },
      { id: "b", createdAt: "2026-10-25T10:00:01.000Z" },
      { id: "c", createdAt: "2026-10-25T10:00:02.000Z" },
    ];
    expect(mergeProjectionRecords(persisted, [], compareCreatedRecords)).toBe(persisted);

    const updated = { id: "b", createdAt: "2026-10-25T10:00:01.000Z", updated: true };
    const appended = { id: "d", createdAt: "2026-10-25T10:00:03.000Z" };
    expect(mergeProjectionRecords(persisted, [updated, appended], compareCreatedRecords))
      .toEqual([persisted[0], updated, persisted[2], appended]);
  });

  it("compares plan steps directly and avoids unnecessary streaming slice", () => {
    const plan: AgentPlan = {
      conversationId: "c",
      runId: "r",
      turnId: "t",
      explanation: null,
      steps: [{ step: "One", status: "inProgress" }, { step: "Two", status: "pending" }],
    };
    expect(sameAgentPlan(plan, { ...plan, steps: plan.steps.map((s) => ({ ...s })) })).toBe(true);
    expect(sameAgentPlanSteps(plan.steps, [{ step: "One", status: "completed" }, { step: "Two", status: "pending" }])).toBe(false);
    expect(appendStreamingText(["", "", null], "hello", 10)[0]).toBe("hello");
    expect(appendStreamingText(["hello", "", "text"], " world", 5)[0]).toBe("world");
    expect(appendStreamingReasoning(["", "", null], "think", 10)[1]).toBe("think");
  });

  it("delivers frames synchronously once the parser module has loaded", async () => {
    const events: unknown[] = [];
    const unreadable = vi.fn();
    const frame = JSON.stringify({ type: "request.ok", requestId: "req-1" });
    await deliverDecodedServerEventSync(frame, (event) => events.push(event), unreadable);
    expect(events).toHaveLength(1);

    // Subsequent call runs synchronously without returning a Promise.
    const syncResult = deliverDecodedServerEventSync(frame, (event) => events.push(event), unreadable);
    expect(syncResult).toBe(true);
    expect(events).toHaveLength(2);
    expect(unreadable).not.toHaveBeenCalled();
  });
});
