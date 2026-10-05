import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { WorkspaceSceneActions } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import { useConversationPaneLayout } from "../../src/renderer/src/hooks/useConversationPaneLayout";
import { useSplitWorkspaceScene } from "../../src/renderer/src/hooks/useSplitWorkspaceScene";

import { composerProps, conversation, routedProvider } from "./composer-fixtures";

const scene = vi.hoisted(() => ({ actions: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useConversationProjection", () => ({ useConversationProjection: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/useAgentWorkflows", () => ({
  useAgentWorkflows: () => ({}), agentWorkflowRouteIdentity: () => "test-route",
}));
vi.mock("../../src/renderer/src/hooks/useWorkspaceTools", () => ({ useWorkspaceTools: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/useDesktopTools", () => ({ useDesktopTools: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/useActivityActions", () => ({ useActivityActions: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/usePlanSteps", () => ({ usePlanSteps: () => [] }));
vi.mock("../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel", () => ({
  createWorkspaceSceneModel: (input: { actions: unknown }) => {
    scene.actions = input.actions;
    return { detailState: null, chat: {}, resizeHandle: null, tools: null };
  },
}));
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

const source = conversation("split-transfer-source");
const target = conversation("split-transfer-target");
const project = { id: source.projectId, name: "Project" } as Project;

const storageSpies: { mockRestore: () => void }[] = [];

afterEach(() => {
  for (const spy of storageSpies.splice(0)) spy.mockRestore();
  window.localStorage.clear();
});

describe("split pane route transfer", () => {
  it("moves the draft into the new chat exactly once when storage rejects writes", async () => {
    const text = "Carry this request into the new split chat";
    let view!: ReturnType<typeof render>;
    const show = (owner: typeof source): void => {
      view.rerender(<Composer {...composerProps(owner, {
        providers: [routedProvider],
        onCreateConversationForSelection: (request) =>
          (scene.actions as WorkspaceSceneActions).createConversationForSelection(request),
      })} />);
    };
    const sendCommand = vi.fn(async (command: { type: string; requestId: string }): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: command.requestId,
      result: command.type === "conversation.continue"
        ? { kind: "conversation.created", conversationId: target.id }
        : { kind: "ok" },
    }) as unknown as ServerEvent);
    renderHook(() => useSplitWorkspaceScene({
      owner: "secondary",
      splitConversation: source,
      visible: true,
      layout: useConversationPaneLayout(source.id),
      snapshotProjects: [project],
      settings: defaultSettings,
      connection: { snapshot: null, status: "online", sendCommand },
      providerMaintenance: { statuses: new Map(), operations: new Map() },
      backendProfileActions: {},
      appUpdate: {},
      busyAction: null,
      setBusyAction: vi.fn(),
      setActionError: vi.fn(),
      gitRefreshVersion: 0,
      request: vi.fn(),
      actions: {},
      sendingConversationIds: new Set<string>(),
      onConversationCreated: () => act(() => show(target)),
      onTerminal: vi.fn(),
    } as unknown as Parameters<typeof useSplitWorkspaceScene>[0]));
    view = render(<></>);
    act(() => show(source));
    storageSpies.push(vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full.", "QuotaExceededError");
    }));
    expect(() => window.localStorage.setItem("probe", "value")).toThrow();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });

    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(screen.getByTitle("Routed Agent").closest("button")!);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation.continue",
      payload: expect.objectContaining({ sourceConversationId: source.id }),
    })));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
    act(() => show(source));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    act(() => show(target));
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text);
  });
});
