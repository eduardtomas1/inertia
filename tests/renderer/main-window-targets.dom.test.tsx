import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UsageLimitsContext, type UsageLimitsContextValue } from "../../src/renderer/src/components/usage-limits-state";
import { MainWindowTargets } from "../../src/renderer/src/hooks/useMainWindowTargets";
import type { AppSnapshot, Conversation, Project } from "../../src/shared/contracts";
import type { MainWindowTarget, MainWindowTargetRequest } from "../../src/shared/desktop";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const sourceId = "11111111-1111-4111-8111-111111111111";
const otherId = "44444444-4444-4444-8444-444444444444";
const missingId = "55555555-5555-4555-8555-555555555555";
const turnId = "66666666-6666-4666-8666-666666666666";
const incidentId = "77777777-7777-4777-8777-777777777777";

function conversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    projectId,
    title: "Thread",
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: "2026-10-27T09:00:00.000Z",
    updatedAt: "2026-10-27T09:00:00.000Z",
    ...overrides,
  };
}

function snapshot(conversations: Conversation[]): AppSnapshot {
  return {
    projects: [
      { id: projectId, name: "Inertia" },
      { id: otherProjectId, name: "Other" },
    ] as Project[],
    conversations,
    providers: [{ id: "codex" }, { id: "claude" }],
    backendProfiles: [{ id: "local-ollama" }],
    activeConversationId: null,
  } as unknown as AppSnapshot;
}

let push: (request: MainWindowTargetRequest) => void = () => {
  throw new Error("Main-window targets were not subscribed.");
};
const unsubscribe = vi.fn();
const openUsageLimits = vi.fn();

function actions() {
  return {
    activateConversation: vi.fn(),
    createConversation: vi.fn(),
    openSettings: vi.fn(),
    connectProvider: vi.fn(),
    openBackendSetup: vi.fn(),
    reportUnavailable: vi.fn(),
  };
}

function renderTargets(
  value: AppSnapshot | null,
  targetActions = actions(),
  limits: UsageLimitsContextValue | null = { open: openUsageLimits } as unknown as UsageLimitsContextValue,
) {
  const view = (next: AppSnapshot | null) => (
    <UsageLimitsContext.Provider value={limits}>
      <MainWindowTargets snapshot={next} actions={targetActions} />
    </UsageLimitsContext.Provider>
  );
  const rendered = render(view(value));
  return {
    actions: targetActions,
    rerender: (next: AppSnapshot | null) => rendered.rerender(view(next)),
    unmount: rendered.unmount,
  };
}

function send(target: MainWindowTarget, sourceConversationId = sourceId): void {
  act(() => push({ sourceConversationId, target }));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      onMainWindowTarget: vi.fn((listener: (request: MainWindowTargetRequest) => void) => {
        push = listener;
        return unsubscribe;
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
});

describe("main-window targets from detached chats", () => {
  it("activates another chat through the main window's normal activation", () => {
    const other = conversation(otherId);
    const { actions: performed } = renderTargets(snapshot([conversation(sourceId), other]));
    send({ kind: "conversation", conversationId: otherId });
    expect(performed.activateConversation).toHaveBeenCalledExactlyOnceWith(other);
    expect(performed.reportUnavailable).not.toHaveBeenCalled();
  });

  it("creates new chats only in the detached chat's own project and checkout", () => {
    const source = conversation(sourceId, { branch: "feature", worktreePath: "/work/inertia-feature" });
    const { actions: performed } = renderTargets(snapshot([source]));
    send({ kind: "new-chat", projectId });
    send({ kind: "new-chat", projectId, checkout: { kind: "branch", branch: "release" } });
    send({ kind: "new-chat", projectId, checkout: { kind: "this-worktree" } });
    send({ kind: "new-chat", projectId, checkout: { kind: "this-worktree", branch: "switched" } });
    send({ kind: "new-chat", projectId, checkout: { kind: "isolated-worktree" } });
    const project = expect.objectContaining({ id: projectId });
    expect(performed.createConversation.mock.calls).toEqual([
      [project, { kind: "defaults" }],
      [project, { kind: "branch", branch: "release" }],
      [project, { kind: "worktree", branch: "feature", path: "/work/inertia-feature" }],
      [project, { kind: "worktree", branch: "switched", path: "/work/inertia-feature" }],
      [project, { kind: "isolated-worktree" }],
    ]);
    expect(performed.reportUnavailable).not.toHaveBeenCalled();
  });

  it("opens settings pages, provider sign-in, model backends, diagnostics and usage limits", () => {
    const { actions: performed } = renderTargets(snapshot([conversation(sourceId)]));
    send({ kind: "settings", page: "keyboard" });
    send({ kind: "backend-setup" });
    send({ kind: "diagnostics" });
    send({ kind: "diagnostics", turnId });
    send({ kind: "diagnostics", incidentId });
    expect(performed.openSettings.mock.calls).toEqual([
      [{ section: "keyboard" }],
      [{ section: "agents", anchor: "model-backends" }],
      [{ section: "help", anchor: "diagnostics-incidents" }],
      [{ section: "help", anchor: "diagnostics-incidents", selection: { turnId } }],
      [{ section: "help", anchor: "diagnostics-incidents", selection: { incidentId } }],
    ]);
    send({ kind: "provider-setup", providerId: "codex" });
    send({ kind: "provider-setup", providerId: "claude", method: "console" });
    expect(performed.connectProvider.mock.calls).toEqual([["codex", "account"], ["claude", "console"]]);
    send({ kind: "backend-setup", profileId: "local-ollama", panel: "models" });
    expect(performed.openBackendSetup).toHaveBeenCalledExactlyOnceWith("local-ollama", "models");
    send({ kind: "usage-limits" });
    expect(openUsageLimits).toHaveBeenCalledOnce();
    expect(performed.reportUnavailable).not.toHaveBeenCalled();
  });

  it("ignores stale or foreign ids and says so", () => {
    const { actions: performed } = renderTargets(snapshot([
      conversation(sourceId),
      conversation(otherId, { projectId: otherProjectId }),
    ]));
    send({ kind: "conversation", conversationId: missingId });
    send({ kind: "new-chat", projectId: missingId });
    send({ kind: "new-chat", projectId: otherProjectId });
    send({ kind: "new-chat", projectId }, missingId);
    send({ kind: "new-chat", projectId, checkout: { kind: "this-worktree" } });
    send({ kind: "provider-setup", providerId: "cursor" });
    send({ kind: "backend-setup", profileId: "deleted-profile" });
    expect(performed.reportUnavailable.mock.calls).toEqual([
      ["That chat is no longer available."],
      ["That project is no longer available."],
      ["That project is no longer available."],
      ["That project is no longer available."],
      ["That worktree is no longer available."],
      ["That agent is no longer available."],
      ["That model backend is no longer available."],
    ]);
    for (const action of [
      performed.activateConversation,
      performed.createConversation,
      performed.connectProvider,
      performed.openBackendSetup,
      performed.openSettings,
    ]) expect(action).not.toHaveBeenCalled();
  });

  it("reports usage limits as unavailable without the limits provider", () => {
    const { actions: performed } = renderTargets(snapshot([conversation(sourceId)]), actions(), null);
    send({ kind: "usage-limits" });
    expect(performed.reportUnavailable).toHaveBeenCalledExactlyOnceWith("Provider limits are unavailable.");
  });

  it("keeps the latest target until the first snapshot arrives and unsubscribes on unmount", () => {
    const other = conversation(otherId);
    const { actions: performed, rerender, unmount } = renderTargets(null);
    send({ kind: "settings", page: "agents" });
    send({ kind: "conversation", conversationId: otherId });
    expect(performed.activateConversation).not.toHaveBeenCalled();
    expect(performed.openSettings).not.toHaveBeenCalled();
    rerender(snapshot([conversation(sourceId), other]));
    expect(performed.activateConversation).toHaveBeenCalledExactlyOnceWith(other);
    expect(performed.openSettings).not.toHaveBeenCalled();
    rerender(snapshot([conversation(sourceId), other]));
    expect(performed.activateConversation).toHaveBeenCalledOnce();
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
