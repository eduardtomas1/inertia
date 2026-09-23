import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Conversation, Project } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import { useConversationPaneLayout } from "../../src/renderer/src/hooks/useConversationPaneLayout";
import { useSplitPaneScenes } from "../../src/renderer/src/hooks/useSplitPaneScenes";
import type { SplitPanes } from "../../src/renderer/src/hooks/useSplitPanes";

// Keep the real layout and split-scene assembly hooks; external runtime data
// and tool contents do not participate in the pane toggle's state contract.
vi.mock("../../src/renderer/src/hooks/useConversationProjection", () => ({ useConversationProjection: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/useAgentWorkflows", () => ({
  useAgentWorkflows: () => ({}), agentWorkflowRouteIdentity: () => "test-route",
}));
vi.mock("../../src/renderer/src/hooks/useWorkspaceTools", () => ({ useWorkspaceTools: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/useDesktopTools", () => ({ useDesktopTools: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/useActivityActions", () => ({ useActivityActions: () => ({}) }));
vi.mock("../../src/renderer/src/hooks/usePlanSteps", () => ({ usePlanSteps: () => [] }));
vi.mock("../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel", () => ({
  createWorkspaceSceneModel: () => ({ detailState: null, chat: {}, resizeHandle: null, tools: null }),
}));

const project = { id: "project", name: "Project" } as Project;
const conversation = (id: string): Conversation => ({ id, projectId: project.id, title: id, status: "idle" }) as Conversation;
const primary = conversation("primary");
const secondary = conversation("secondary");
const split = {
  pinned: { secondary, tertiary: null, quaternary: null },
  visibleOwners: ["secondary"],
  layout: { axis: "columns", ratio: 50, first: { owner: "primary" }, second: { owner: "secondary" } },
  commitLayout: vi.fn(), closePane: vi.fn(), setPaneConversation: vi.fn(), updateSplitConversationId: vi.fn(),
} as unknown as SplitPanes;
const shared = {
  snapshotProjects: [project], settings: defaultSettings,
  connection: { snapshot: null, status: "offline" },
  providerMaintenance: { statuses: new Map(), operations: new Map() },
  actions: {}, sendingConversationIds: new Set<string>(), busyAction: null,
} as unknown as Parameters<typeof useSplitPaneScenes>[0]["shared"];

beforeEach(() => window.localStorage.clear());

it.each(["primary", "secondary"] as const)("reports the open launcher for the %s pane without a selected surface", (owner) => {
  const hook = renderHook(() => {
    const primaryLayout = useConversationPaneLayout(primary.id);
    return useSplitPaneScenes({
      split, shared, visible: true, conversation: primary, project, primaryLayout,
      openConversationInWindow: vi.fn(), openPrimaryWorkspaceRunPreview: vi.fn(),
    });
  });
  const pane = () => hook.result.current.splitScene!.panes.find((entry) => entry.owner === owner)!;
  const other = () => hook.result.current.splitScene!.panes.find((entry) => entry.owner !== owner)!;
  expect(pane().toolsOpen).toBe(false);
  expect(other().toolsOpen).toBe(false);

  act(() => pane().onToggleTools());

  expect(JSON.parse(window.localStorage.getItem(`inertia:layout:split-pane-panel:${owner}:v1`)!))
    .toEqual({ isOpen: true, surfaces: [], activeSurfaceId: null });
  expect(pane().toolsOpen).toBe(true);
  expect(other().toolsOpen).toBe(false);

  act(() => pane().onToggleTools());

  expect(pane().toolsOpen).toBe(false);
  expect(other().toolsOpen).toBe(false);
});
