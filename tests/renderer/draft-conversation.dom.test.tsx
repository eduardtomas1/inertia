import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type Project,
  type ServerEvent,
} from "../../src/shared/contracts";
import { transferDraftWorkspacePanel, useWorkspaceLayout } from "../../src/renderer/src/hooks/useWorkspaceLayout";
import { useDraftConversation } from "../../src/renderer/src/hooks/useDraftConversation";
import { useProjectChatNavigation } from "../../src/renderer/src/hooks/useProjectChatNavigation";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  buildDraftConversation,
  buildNewConversationPayload,
} from "../../src/renderer/src/lib/newConversation";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type {
  TranscriptMessageSendAcceptance,
} from "../../src/renderer/src/utils/transcriptNavigation";
import {
  readPersistedDraftConversation,
  readPersistedMaterializedDraftConversation,
} from "../../src/renderer/src/utils/draftConversationPersistence";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-29T10:00:00.000Z";
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
const snapshot: AppSnapshot = {
  projects: [project],
  conversations: [],
  providers: [],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  activeProjectId: projectId,
  activeConversationId: null,
  settings: defaultSettings,
};

function materializedSnapshot(
  status: "idle" | "running" | "completed" = "idle",
  title = "New chat",
  latestTurnId: string | null = null,
): AppSnapshot {
  const conversation = buildDraftConversation(
    buildNewConversationPayload(projectId, defaultSettings),
    { id: conversationId, now },
  );
  const selection = conversation.modelSelection;
  return {
    ...snapshot,
    activeConversationId: status === "idle" ? null : conversationId,
    conversations: [{
      ...conversation,
      title,
      status,
      latestTurn: latestTurnId
        ? {
            id: latestTurnId,
            runId: `${latestTurnId}-run`,
            status: "running",
            providerId: conversation.providerId,
            harnessId: selection.harnessId,
            backendProfileId: selection.backendProfileId,
            modelSelection: selection,
            continuationIdentity: {
              harnessId: selection.harnessId,
              backendProfileId: selection.backendProfileId,
              backendConfigurationRevision:
                selection.backendConfigurationRevision,
              modelIdentity: selection.modelId,
              endpointIdentity: null,
            },
            model: selection.modelId,
            reasoningEffort: selection.reasoningEffort ?? "medium",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            terminalReason: null,
            updatedAt: now,
          }
        : null,
      pendingApproval: false,
      pendingInput: false,
    }],
  };
}

describe("useDraftConversation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(),
        getItem: vi.fn(() => null),
        key: vi.fn(() => null),
        length: 0,
        removeItem: vi.fn(),
        setItem: vi.fn(),
      } satisfies Storage,
    });
  });

  it("persists a reference target with its composer identity before selecting and sharing, without a turn", async () => {
    const commands: CommandWithoutId[] = [];
    const run = vi.fn(async (_key: string, command: CommandWithoutId): Promise<ServerEvent> => {
      commands.push(command);
      return command.type === "conversation.create"
        ? { type: "request.result", requestId: "create", result: {
            kind: "conversation.created", conversationId: command.payload.draftConversationId!,
          } }
        : { type: "request.ok", requestId: "context" };
    });
    const sendMessage = vi.fn();
    const hook = renderHook(() => useDraftConversation({
      snapshot, settings: defaultSettings, run, sendMessage,
      persistedConversationId: null, updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation!.id;
    const command = { type: "conversation.context.create", payload: {
      sourceConversationId: conversationId, targetConversationId: draftId,
      acknowledgedWorkspaceDifference: true,
    } } as const;
    await act(async () => { await hook.result.current.runConversationContextCommand("conversation.context.create", command); });
    expect(commands.map(({ type }) => type)).toEqual([
      "conversation.create", "conversation.select", "conversation.context.create",
    ]);
    expect(commands[0]).toMatchObject({ payload: { draftConversationId: draftId, activate: false } });
    expect(commands[1]).toMatchObject({ payload: { conversationId: draftId } });
    expect(commands[2]).toEqual(command);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(hook.result.current.conversation).toBeNull();
  });

  it("does not attach or select when the draft is replaced during target creation", async () => {
    let finishCreation!: (event: ServerEvent) => void;
    const run = vi.fn(() => new Promise<ServerEvent>((resolve) => { finishCreation = resolve; }));
    const hook = renderHook(() => useDraftConversation({
      snapshot, settings: defaultSettings, run, sendMessage: vi.fn(),
      persistedConversationId: null, updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const firstId = hook.result.current.conversation!.id;
    const request = hook.result.current.runConversationContextCommand("conversation.context.create", {
      type: "conversation.context.create", payload: {
        sourceConversationId: conversationId, targetConversationId: firstId,
        acknowledgedWorkspaceDifference: false,
      },
    });
    act(() => hook.result.current.start(projectId));
    const secondId = hook.result.current.conversation!.id;
    await act(async () => {
      finishCreation({ type: "request.result", requestId: "create", result: {
        kind: "conversation.created", conversationId: firstId,
      } });
      await expect(request).rejects.toThrow("new chat changed");
    });
    expect(run).toHaveBeenCalledOnce();
    expect(hook.result.current.conversation?.id).toBe(secondId);
  });

  it("retains the draft after a selection failure and retries without creating another chat", async () => {
    const run = vi.fn(async (_key: string, command: CommandWithoutId): Promise<ServerEvent> =>
      command.type === "conversation.create"
        ? { type: "request.result", requestId: "create", result: {
            kind: "conversation.created", conversationId: command.payload.draftConversationId!,
          } }
        : { type: "request.ok", requestId: "context" });
    const navigate = vi.fn().mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValue({ type: "request.ok", requestId: "select" });
    const hook = renderHook(() => useDraftConversation({
      snapshot, settings: defaultSettings, run, runNavigationCommand: navigate, sendMessage: vi.fn(),
      persistedConversationId: null, updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation!.id;
    const command = { type: "conversation.context.create", payload: {
      sourceConversationId: conversationId, targetConversationId: draftId,
      acknowledgedWorkspaceDifference: false,
    } } as const;
    await act(async () => {
      await expect(hook.result.current.runConversationContextCommand("conversation.context.create", command)).rejects.toThrow("Disconnected");
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    await act(async () => { await hook.result.current.runConversationContextCommand("conversation.context.create", command); });
    expect(run.mock.calls.map(([, value]) => value.type)).toEqual(["conversation.create", "conversation.context.create"]);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("restores a draft's identity and composer storage after a cross-project search", () => {
    const values = new Map<string, string>();
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => values.get(key) ?? null);
    vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => { values.set(key, value); });
    const other = { ...project, id: "33333333-3333-4333-8333-333333333333" };
    const run = vi.fn();
    let current = { ...snapshot, projects: [project, other] };
    const hook = renderHook(() => useDraftConversation({
      snapshot: current, settings: defaultSettings, run, sendMessage: vi.fn(),
      persistedConversationId: conversationId, updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId, true));
    const original = hook.result.current.conversation!;
    window.localStorage.setItem(`inertia:draft:${original.id}`, "Unsent prompt");
    act(() => hook.result.current.clear());
    current = { ...current, activeProjectId: other.id };
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
    act(() => hook.result.current.start(other.id, true, true));
    expect(hook.result.current.conversation).toMatchObject({ id: original.id, projectId, modelSelection: original.modelSelection });
    expect(window.localStorage.getItem(`inertia:draft:${original.id}`)).toBe("Unsent prompt");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { navigate: false, selected: true },
    { navigate: true, selected: true },
    { navigate: false, selected: false },
  ])("retains search-preserved draft ownership after remount (navigation: $navigate, selected chat: $selected)", ({ navigate, selected }) => {
    const values = new Map<string, string>();
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => values.get(key) ?? null);
    vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => { values.set(key, value); });
    vi.mocked(window.localStorage.removeItem).mockImplementation((key) => { values.delete(key); });
    const other = { ...project, id: "33333333-3333-4333-8333-333333333333" };
    let current = { ...snapshot, projects: [project, other] };
    let persistedConversationId: string | null = conversationId;
    const mount = () => renderHook(() => {
      const draft = useDraftConversation({
        snapshot: current, settings: defaultSettings, run: vi.fn(), sendMessage: vi.fn(),
        persistedConversationId, updatePersistedConversation: vi.fn(),
      });
      const navigation = useProjectChatNavigation({
        project: current.projects.find(({ id }) => id === current.activeProjectId)!, projects: current.projects,
        busyAction: null, draftConversation: draft, conversationSelectionGenerationRef: { current: 0 },
        selectionCommandQueue: vi.fn(),
        updateSplitConversationId: vi.fn(), setSidebarOpen: vi.fn(), setView: vi.fn(),
      });
      return { draft, navigation };
    });
    const first = mount();
    act(() => first.result.current.navigation.openGlobalChat());
    const original = first.result.current.draft.conversation!;
    const composerKey = `inertia:draft:${original.id}`;
    window.localStorage.setItem(composerKey, "Unsent prompt and attachment state");
    window.localStorage.setItem("inertia:draft:unrelated", "Another chat's draft");
    act(() => first.result.current.navigation.exitGlobalChat(true));
    first.unmount();
    current = { ...current, activeProjectId: selected ? other.id : projectId };
    persistedConversationId = selected ? conversationId : null;
    const restarted = mount();
    expect(restarted.result.current.draft.conversation).toBeNull();
    if (navigate) act(() => restarted.result.current.navigation.exitGlobalChat());
    act(() => restarted.result.current.navigation.openGlobalChat());
    expect(restarted.result.current.draft.conversation).toMatchObject({
      id: original.id, projectId, modelSelection: original.modelSelection,
    });
    expect(window.localStorage.getItem(composerKey)).toBe("Unsent prompt and attachment state");
    expect(readPersistedDraftConversation()?.resumeAfterSearch).not.toBe(true);
    act(() => restarted.result.current.navigation.exitGlobalChat());
    expect(readPersistedDraftConversation()).toBeNull();
    expect(window.localStorage.getItem(composerKey)).toBeNull();
    expect(window.localStorage.getItem("inertia:draft:unrelated")).toBe("Another chat's draft");
  });

  it("moves a saved Gemini draft to Antigravity's provider default", () => {
    const values = new Map<string, string>([[
      "inertia:new-project-conversation-draft:v1",
      JSON.stringify({
        version: 2,
        state: "draft",
        conversationId: "55555555-5555-4555-8555-555555555555",
        createdAt: "2026-09-01T10:00:00.000Z",
        payload: {
          projectId,
          title: "New chat",
          providerId: "gemini",
          modelSelection: {
            harnessId: "gemini-acp",
            backendProfileId: "builtin:gemini",
            backendProfileDisplayName: "Google Gemini",
            modelId: "gemini-2.5-pro",
            alias: null,
            reasoningEffort: "high",
            contextWindowOverride: null,
            providerOptions: {},
            capabilities: [],
            backendConfigurationRevision: 0,
          },
          model: "gemini-2.5-pro",
          reasoningEffort: "high",
          accessMode: "supervised",
        },
      }),
    ]]);
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => values.get(key) ?? null);

    const restored = readPersistedDraftConversation();

    expect(restored?.payload).toEqual({
      projectId,
      title: "New chat",
      providerId: "antigravity",
      accessMode: "supervised",
    });
    expect(restored?.conversation).toMatchObject({
      id: "55555555-5555-4555-8555-555555555555",
      providerId: "antigravity",
      modelSelection: {
        harnessId: "antigravity-cli",
        backendProfileId: "builtin:antigravity",
        modelId: "provider-default",
      },
    });
  });

  it("starts from the project backend default before the global default", () => {
    const globalSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "global-model",
    });
    const projectSelection = providerNativeModelSelection({
      providerId: "claude",
      modelId: "project-model",
    });
    const hook = renderHook(() => useDraftConversation({
      snapshot: {
        ...snapshot,
        backendDefaults: [
          { scope: "global", projectId: null, selection: globalSelection, updatedAt: now },
          { scope: "project", projectId, selection: projectSelection, updatedAt: now },
        ],
      },
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));

    act(() => hook.result.current.start(projectId));

    expect(hook.result.current.conversation?.modelSelection)
      .toEqual(projectSelection);
  });

  it("preserves a newly opened draft across an unchanged persisted selection refresh", () => {
    let currentSnapshot = materializedSnapshot("completed", "Existing chat");
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: conversationId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draft = hook.result.current.conversation;
    expect(draft).not.toBeNull();
    currentSnapshot = { ...currentSnapshot };
    hook.rerender();
    expect(hook.result.current.conversation?.id).toBe(draft?.id);
  });

  it("clears the draft when a different persisted chat is selected", () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    let currentSnapshot = materializedSnapshot("completed", "Existing chat");
    let selectedId = conversationId;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: selectedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    expect(hook.result.current.conversation).not.toBeNull();
    selectedId = otherId;
    currentSnapshot = {
      ...currentSnapshot,
      activeConversationId: otherId,
      conversations: [...currentSnapshot.conversations, {
        ...currentSnapshot.conversations[0]!, id: otherId,
      }],
    };
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
  });

  it("clears the draft when navigation selects a different project", () => {
    const otherProject = { ...project, id: "33333333-3333-4333-8333-333333333333" };
    let currentSnapshot = materializedSnapshot("completed", "Existing chat");
    let selectedId: string | null = conversationId;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: selectedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    expect(hook.result.current.conversation).not.toBeNull();
    selectedId = null;
    currentSnapshot = {
      ...currentSnapshot,
      activeConversationId: null,
      activeProjectId: otherProject.id,
      projects: [project, otherProject],
    };
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
  });

  it("retargets an independent draft in place without selecting a stored chat", async () => {
    const otherProject = { ...project, id: "33333333-3333-4333-8333-333333333333" };
    let currentSnapshot = { ...materializedSnapshot("completed", "Existing chat"), projects: [project, otherProject] };
    let selectedId = conversationId;
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result", requestId: "create", result: { kind: "conversation.created", conversationId: "created" },
    }));
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot, settings: defaultSettings, run,
      sendMessage: vi.fn(async () => null), persistedConversationId: selectedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId, true));
    const draftId = hook.result.current.conversation!.id;
    act(() => hook.result.current.changeProject(otherProject.id));
    expect(hook.result.current.conversation).toMatchObject({ id: draftId, projectId: otherProject.id });
    expect(run).not.toHaveBeenCalled();
    // A previously queued selection or a background refresh cannot take over
    // the route opened by the logo.
    selectedId = "late-selection";
    currentSnapshot = { ...currentSnapshot, activeConversationId: selectedId };
    hook.rerender();
    expect(hook.result.current.conversation).toMatchObject({ id: draftId, projectId: otherProject.id });
    await act(async () => { await hook.result.current.sendFromComposer("Keep my prompt", []); });
    expect(run).toHaveBeenCalledWith("conversation.create:draft", expect.objectContaining({
      payload: expect.objectContaining({ projectId: otherProject.id, activate: false }),
    }));
    act(() => hook.result.current.changeProject(projectId));
    expect(hook.result.current.conversation?.projectId).toBe(otherProject.id);
    act(() => hook.result.current.discard());
    expect(hook.result.current.conversation).toBeNull();
  });

  it("uses the new project's defaults until a model is explicitly selected", () => {
    const otherId = "33333333-3333-4333-8333-333333333333";
    const firstModel = providerNativeModelSelection({ providerId: "codex", modelId: "first-model" });
    const secondModel = providerNativeModelSelection({ providerId: "claude", modelId: "second-model" });
    const explicitModel = providerNativeModelSelection({ providerId: "codex", modelId: "chosen-model" });
    const hook = renderHook(() => useDraftConversation({
      snapshot: { ...snapshot, projects: [project, { ...project, id: otherId }], backendDefaults: [
        { scope: "project", projectId, selection: firstModel, updatedAt: now },
        { scope: "project", projectId: otherId, selection: secondModel, updatedAt: now },
      ] },
      settings: defaultSettings, run: vi.fn(), sendMessage: vi.fn(),
      persistedConversationId: null, updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId, true));
    act(() => hook.result.current.changeProject(otherId));
    expect(hook.result.current.conversation?.modelSelection).toEqual(secondModel);
    act(() => { hook.result.current.chooseModel(explicitModel, { accessMode: "full", interactionMode: "plan" }); });
    act(() => hook.result.current.changeProject(projectId));
    expect(hook.result.current.conversation?.modelSelection).toEqual(explicitModel);
    expect(hook.result.current.conversation).toMatchObject({ accessMode: "full", interactionMode: "plan" });
    expect(hook.result.current.conversation).toMatchObject({ providerSessionId: null, branch: null, worktreePath: null });
  });

  it("keeps a new-project chat local until its first message is sent", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "conversation.create") {
        throw new Error(`Unexpected command ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: { kind: "conversation.created", conversationId },
      };
    });
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId,
      turnId: "turn-1",
      userMessageId: "message-1",
      disposition: "new-turn" as const,
    }));
    const onMaterialized = vi.fn();
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
      onMaterialized,
    }));

    act(() => hook.result.current.start(projectId));
    expect(hook.result.current.conversation).toMatchObject({
      projectId,
      status: "idle",
      providerSessionId: null,
    });
    expect(hook.result.current.requiresWorkspaceMaterialization).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const draftId = hook.result.current.conversation?.id;
    let acceptance: TranscriptMessageSendAcceptance | null | undefined;
    await act(async () => {
      acceptance = await hook.result.current.sendFromComposer(
        "Start with the current implementation.",
        [],
      );
    });
    expect(run).toHaveBeenCalledWith(
      "conversation.create:draft",
      expect.objectContaining({
        type: "conversation.create",
        payload: expect.objectContaining({
          projectId,
          activate: false,
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      conversationId,
      "Start with the current implementation.",
      [],
      undefined,
      true,
    );
    expect(acceptance).toMatchObject({
      conversationId,
      materializedFromConversationId: draftId,
      turnId: "turn-1",
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: "turn-1",
      acceptedUserMessageId: "message-1",
      draftConversationId: draftId,
      materializedConversationId: conversationId,
    });

    await expect(hook.result.current.sendFromComposer(
      "Do not send this twice.",
      [],
    )).rejects.toThrow("was accepted");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(onMaterialized.mock.calls).toEqual([
      [projectId, draftId, conversationId],
    ]);
    expect(onMaterialized.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[0]);

    currentSnapshot = materializedSnapshot(
      "running",
      "Start with the current implementation.",
      "turn-1",
    );
    hook.rerender();
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);
    expect(readPersistedMaterializedDraftConversation()).not.toBeNull();

    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
  });

  it("rejects a mismatched materialized acceptance and blocks a duplicate", async () => {
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId: "33333333-3333-4333-8333-333333333333",
      turnId: "wrong-turn",
      userMessageId: "wrong-message",
      disposition: "new-turn" as const,
    }));
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;

    await act(async () => {
      await expect(hook.result.current.sendFromComposer(
        "Acknowledge only this chat.",
        [],
      )).rejects.toThrow("different chat");
    });

    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);
    await expect(hook.result.current.sendFromComposer(
      "Do not retry an uncertain acceptance.",
      [],
    )).rejects.toThrow("reconciling");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft visible when the accepted snapshot precedes the response", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    let settleAcceptance!: (value: TranscriptMessageSendAcceptance) => void;
    const sendMessage = vi.fn(() => (
      new Promise<TranscriptMessageSendAcceptance>((resolve) => {
        settleAcceptance = resolve;
      })
    ));
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    let sending!: Promise<TranscriptMessageSendAcceptance | null>;
    act(() => {
      sending = hook.result.current.sendFromComposer(
        "Snapshot this request before replying.",
        [],
      );
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    currentSnapshot = materializedSnapshot(
      "running",
      "Snapshot this request before replying.",
      "turn-snapshot-first",
    );
    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);

    let acceptance: TranscriptMessageSendAcceptance | null = null;
    await act(async () => {
      settleAcceptance({
        kind: "message.accepted",
        conversationId,
        turnId: "turn-snapshot-first",
        userMessageId: "message-snapshot-first",
        disposition: "new-turn",
      });
      acceptance = await sending;
    });
    expect(acceptance).toMatchObject({
      materializedFromConversationId: draftId,
      turnId: "turn-snapshot-first",
    });
    expect(hook.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
  });

  it("reconciles an accepted in-memory draft when localStorage is unavailable", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
        getItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
        key: vi.fn(() => null),
        length: 0,
        removeItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
        setItem: vi.fn(() => {
          throw new Error("storage unavailable");
        }),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId,
      turnId: "turn-memory-only",
      userMessageId: "message-memory-only",
      disposition: "new-turn" as const,
    }));
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    await act(async () => {
      await hook.result.current.sendFromComposer("Keep this in memory.", []);
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);

    currentSnapshot = materializedSnapshot(
      "running",
      "Keep this in memory.",
      "turn-memory-only",
    );
    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
  });

  it("requires the exact durable accepted turn after remount", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => ({
      kind: "message.accepted" as const,
      conversationId,
      turnId: "turn-durable-exact",
      userMessageId: "message-durable-exact",
      disposition: "new-turn" as const,
    }));
    const first = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => first.result.current.start(projectId));
    const draftId = first.result.current.conversation?.id;
    await act(async () => {
      await first.result.current.sendFromComposer("Persist the exact turn.", []);
    });
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: "turn-durable-exact",
      draftConversationId: draftId,
    });
    first.unmount();

    let currentSnapshot = materializedSnapshot(
      "running",
      "Persist the exact turn.",
    );
    const restored = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: conversationId,
      updatePersistedConversation: vi.fn(),
    }));
    expect(restored.result.current.conversation?.id).toBe(draftId);

    currentSnapshot = materializedSnapshot(
      "running",
      "Persist the exact turn.",
      "turn-unrelated",
    );
    restored.rerender();
    expect(restored.result.current.conversation?.id).toBe(draftId);

    currentSnapshot = materializedSnapshot(
      "running",
      "Persist the exact turn.",
      "turn-durable-exact",
    );
    restored.rerender();
    expect(restored.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
  });

  it("keeps isolated-worktree tools unavailable until the draft materializes", () => {
    const hook = renderHook(() => useDraftConversation({
      snapshot: null,
      settings: {
        ...defaultSettings,
        newThreadMode: "worktree",
      },
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    }));

    act(() => hook.result.current.start(projectId));

    expect(hook.result.current.conversation?.worktreePath).toBeNull();
    expect(hook.result.current.requiresWorkspaceMaterialization).toBe(true);
  });

  it("reconciles an ambiguous first send without restoring or resending the draft", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn(async () => {
      throw new RuntimeCommandError(
        "The local service disconnected before finishing the request.",
        "ambiguous",
      );
    });
    let currentSnapshot: AppSnapshot | null = null;
    let persistedId: string | null = null;
    const hook = renderHook(() => useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: persistedId,
      updatePersistedConversation: vi.fn(),
    }));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    const promptStorageKey = `inertia:draft:${draftId}`;
    const persistedPrompt = JSON.stringify({
      message: "Keep this draft.",
    });
    values.set(promptStorageKey, persistedPrompt);

    let sendError: unknown;
    await act(async () => {
      try {
        await hook.result.current.sendFromComposer("Keep this draft.", []);
      } catch (error) {
        sendError = error;
      }
    });
    expect(sendError).toMatchObject({ message: expect.stringContaining("disconnected") });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: null,
      draftConversationId: draftId,
      materializedConversationId: conversationId,
      conversation: { id: draftId, projectId },
    });
    expect(values.get(promptStorageKey)).toBe(persistedPrompt);

    await expect(hook.result.current.sendFromComposer(
      "Keep this draft.",
      [],
    )).rejects.toThrow("reconciling");
    expect(run).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    currentSnapshot = materializedSnapshot(
      "running",
      "Keep this draft.",
    );
    persistedId = conversationId;
    hook.rerender();
    expect(hook.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
    expect(values.has(promptStorageKey)).toBe(false);
  });

  it("retries a definitely unsent first message against the same materialized chat", async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const run = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "conversation.created", conversationId },
    }));
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new RuntimeCommandError(
        "The local service is reconnecting. Try again in a moment.",
        "not-sent",
      ))
      .mockResolvedValueOnce({
        kind: "message.accepted" as const,
        conversationId,
        turnId: "turn-retry",
        userMessageId: "message-retry",
        disposition: "new-turn" as const,
      });
    const useDraftWithLayout = (currentSnapshot: AppSnapshot | null, selectedId: string | null) => {
      const draft = useDraftConversation({
      snapshot: currentSnapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: selectedId,
      updatePersistedConversation: vi.fn(),
      onMaterialized: transferDraftWorkspacePanel,
      });
      const layout = useWorkspaceLayout("workspace", true, {
        startupReady: true,
        workspaceId: `${projectId}:${draft.layoutConversationId ?? selectedId ?? "draft"}`,
      });
      return { ...draft, layout };
    };
    const hook = renderHook(() => useDraftWithLayout(null, null));
    act(() => hook.result.current.start(projectId));
    const draftId = hook.result.current.conversation?.id;
    expect(hook.result.current.layoutConversationId).toBe(draftId);
    act(() => hook.result.current.layout.openSurface("usage"));
    const promptStorageKey = `inertia:draft:${draftId}`;
    const persistedPrompt = JSON.stringify({
      message: "Send once the socket returns.",
    });
    values.set(promptStorageKey, persistedPrompt);

    await act(async () => {
      await hook.result.current.sendFromComposer(
        "Send once the socket returns.",
        [],
      ).catch(() => undefined);
    });
    expect(hook.result.current.conversation?.id).toBe(draftId);
    expect(hook.result.current.layoutConversationId).toBe(conversationId);
    expect(values.get(promptStorageKey)).toBe(persistedPrompt);
    expect(hook.result.current.layout.activeTool).toBe("usage");
    act(() => {
      hook.result.current.layout.openSurface("agents");
      hook.result.current.layout.toggleWorkspaceTools();
    });
    expect(hook.result.current.layout.panel.isOpen).toBe(false);
    hook.unmount();

    let reconciledSnapshot = materializedSnapshot();
    let reconciledId: string | null = conversationId;
    const restored = renderHook(() => useDraftWithLayout(reconciledSnapshot, reconciledId));
    expect(restored.result.current.layoutConversationId).toBe(conversationId);
    expect(restored.result.current.layout.panel.isOpen).toBe(false);
    expect(restored.result.current.layout.panel.activeSurfaceId).toBe("agents");
    expect(restored.result.current.conversation?.id).toBe(draftId);
    expect(values.get(promptStorageKey)).toBe(persistedPrompt);
    await act(async () => {
      await restored.result.current.sendFromComposer(
        "Send once the socket returns.",
        [],
      );
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]?.[0]).toBe(conversationId);
    expect(sendMessage.mock.calls[1]?.[0]).toBe(conversationId);
    expect(restored.result.current.conversation?.id).toBe(draftId);
    expect(readPersistedMaterializedDraftConversation()).toMatchObject({
      acceptedTurnId: "turn-retry",
      draftConversationId: draftId,
      materializedConversationId: conversationId,
    });

    reconciledSnapshot = materializedSnapshot(
      "running",
      "Send once the socket returns.",
      "turn-retry",
    );
    reconciledId = conversationId;
    restored.rerender();
    expect(restored.result.current.conversation).toBeNull();
    expect(readPersistedMaterializedDraftConversation()).toBeNull();
    expect(values.has(promptStorageKey)).toBe(false);
    expect(restored.result.current.layout.panel.isOpen).toBe(false);
    act(() => restored.result.current.layout.toggleWorkspaceTools());
    expect(restored.result.current.layout.activeTool).toBe("agents");
  });

  it("restores a new-project draft identity after the renderer remounts", () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        get length() {
          return values.size;
        },
        removeItem: vi.fn((key: string) => values.delete(key)),
        setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      } satisfies Storage,
    });
    const options = {
      snapshot,
      settings: defaultSettings,
      run: vi.fn(),
      sendMessage: vi.fn(),
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
    };
    const first = renderHook(() => useDraftConversation(options));

    act(() => first.result.current.start(projectId));
    const draftId = first.result.current.conversation?.id;
    expect(draftId).toBeTruthy();
    first.unmount();

    const restored = renderHook(() => useDraftConversation(options));
    expect(restored.result.current.conversation).toMatchObject({
      id: draftId,
      projectId,
    });
  });

  it("does not reactivate a draft chat after its owner navigates away", async () => {
    let settleCreation: ((event: ServerEvent) => void) | null = null;
    const run = vi.fn(() => new Promise<ServerEvent>((resolve) => {
      settleCreation = resolve;
    }));
    const sendMessage = vi.fn(async () => null);
    const onMaterialized = vi.fn();
    const hook = renderHook(() => useDraftConversation({
      snapshot,
      settings: defaultSettings,
      run,
      sendMessage,
      persistedConversationId: null,
      updatePersistedConversation: vi.fn(),
      onMaterialized,
    }));
    act(() => hook.result.current.start(projectId));

    let sending!: Promise<unknown>;
    act(() => {
      sending = hook.result.current.sendFromComposer(
        "Keep working in the chat I left.",
        [],
      );
    });
    act(() => hook.result.current.clear());
    await act(async () => {
      settleCreation?.({
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: { kind: "conversation.created", conversationId },
      });
      await sending;
    });

    expect(sendMessage).toHaveBeenCalledWith(
      conversationId,
      "Keep working in the chat I left.",
      [],
      undefined,
      false,
    );
    expect(hook.result.current.conversation).toBeNull();
    expect(onMaterialized).not.toHaveBeenCalled();
  });
});
