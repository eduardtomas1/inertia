import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, ServerEvent, WorkspaceRun } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import { buildDraftConversation, buildNewConversationPayload } from "../../src/renderer/src/lib/newConversation";
import { useConversationPaneLayout } from "../../src/renderer/src/hooks/useConversationPaneLayout";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";
import { useSplitPaneScenes } from "../../src/renderer/src/hooks/useSplitPaneScenes";
import type { SplitPanes } from "../../src/renderer/src/hooks/useSplitPanes";

const now = "2026-09-15T10:00:00.000Z";
const project: Project = {
  id: "61616161-6161-4161-8161-616161616161",
  name: "Project",
  path: "/workspace/project",
  normalizedPath: "/workspace/project",
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
const conversation = (id: string) => ({
  ...buildDraftConversation(buildNewConversationPayload(project.id, defaultSettings), { id, now }),
  title: id,
});
const primary = conversation("primary");
const secondary = conversation("secondary");
const split = {
  pinned: { secondary, tertiary: null, quaternary: null },
  visibleOwners: ["secondary"],
  layout: { axis: "columns", ratio: 50, first: { owner: "primary" }, second: { owner: "secondary" } },
  commitLayout: vi.fn(), closePane: vi.fn(), setPaneConversation: vi.fn(), updateSplitConversationId: vi.fn(),
} as unknown as SplitPanes;
const pendingCommand = (): Promise<ServerEvent> => new Promise<ServerEvent>(() => undefined);
const connection: InertiaConnection = {
  snapshot: null,
  runtimeGeneration: null,
  status: "offline",
  error: null,
  databaseRecoveryNotice: null,
  dismissDatabaseRecoveryNotice: () => undefined,
  clearError: () => undefined,
  sendCommand: pendingCommand,
  subscribe: () => () => undefined,
};
const shared = {
  snapshotProjects: [project], settings: defaultSettings, connection,
  providerMaintenance: { statuses: new Map(), operations: new Map() },
  backendProfileActions: {}, appUpdate: {},
  busyAction: null, setBusyAction: vi.fn(), setActionError: vi.fn(), gitRefreshVersion: 0,
  request: pendingCommand, actions: {}, sendingConversationIds: new Set<string>(), onTerminal: vi.fn(),
} as unknown as Parameters<typeof useSplitPaneScenes>[0]["shared"];

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      onPreviewState: vi.fn(() => () => undefined),
      previewConnect: vi.fn(() => new Promise(() => undefined)),
      previewClose: vi.fn(async () => undefined),
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
});

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

it("marks a split chat's finished run seen only while its window is focused and its latest reply is in view", () => {
  const request = vi.fn<(command: { type: string }) => Promise<ServerEvent>>(pendingCommand);
  const run: WorkspaceRun = {
    id: "71717171-7171-4171-8171-717171717171", kind: "agent", projectId: project.id, conversationId: secondary.id, actionId: null,
    label: "Codex", detail: null, status: "succeeded", attentionState: "unseen", canStop: false, port: null, startedAt: now, finishedAt: now,
  };
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const hook = renderHook(({ version }: { version: number }) => {
    const primaryLayout = useConversationPaneLayout(primary.id);
    return useSplitPaneScenes({
      split, visible: true, conversation: primary, project, primaryLayout,
      shared: { ...shared, request, connection: { ...connection, snapshot: { runs: [run], conversations: [], projects: [project], providers: [] } as never }, attentionObstructed: false, attentionVisibilityVersion: version },
      openConversationInWindow: vi.fn(), openPrimaryWorkspaceRunPreview: vi.fn(),
    });
  }, { initialProps: { version: 0 } });
  const pane = () => hook.result.current.splitScene!.panes.find((entry) => entry.owner === "secondary")!;
  const marked = () => request.mock.calls.filter(([command]) => command.type === "activity.mark-seen");
  act(() => pane().scene!.chat.onLatestContentVisibilityChange?.(true));
  expect(marked()).toEqual([]);
  focused.mockReturnValue(true);
  hook.rerender({ version: 1 });
  expect(marked()).toEqual([[{ type: "activity.mark-seen", payload: { runId: run.id } }]]);
  focused.mockRestore();
});
