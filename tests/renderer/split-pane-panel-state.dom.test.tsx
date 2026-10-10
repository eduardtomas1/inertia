import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitStatusSnapshot, Project, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import { CheckoutBranchControlProvider } from "../../src/renderer/src/components/CheckoutBranchControl";
import { Composer } from "../../src/renderer/src/components/Composer";
import { buildDraftConversation, buildNewConversationPayload } from "../../src/renderer/src/lib/newConversation";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { useConversationPaneLayout } from "../../src/renderer/src/hooks/useConversationPaneLayout";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";
import { useSplitPaneScenes } from "../../src/renderer/src/hooks/useSplitPaneScenes";
import type { SplitPanes } from "../../src/renderer/src/hooks/useSplitPanes";
import { composerProps } from "./composer-fixtures";

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

it("hands the secondary pane its own checkout so a detached HEAD shows in its composer", async () => {
  const detached = {
    isRepository: true, root: project.path, branch: null, upstream: null, ahead: 0, behind: 0,
    hasRemote: false, files: [], insertions: 0, deletions: 0,
  } satisfies GitStatusSnapshot;
  const request = vi.fn((command: CommandWithoutId): Promise<ServerEvent> => command.type === "git.refresh"
    ? Promise.resolve({ type: "request.result", requestId: "git", result: { kind: "git.status", status: detached } } as unknown as ServerEvent)
    : pendingCommand());
  const online = { ...shared, connection: { ...connection, status: "online" }, request } as typeof shared;
  const hook = renderHook(() => {
    const primaryLayout = useConversationPaneLayout(primary.id);
    return useSplitPaneScenes({
      split, shared: online, visible: true, conversation: primary, project, primaryLayout,
      openConversationInWindow: vi.fn(), openPrimaryWorkspaceRunPreview: vi.fn(),
    });
  });
  const scene = () => hook.result.current.splitScene!.panes.find((entry) => entry.owner === "secondary")!.scene!;
  await waitFor(() => expect(scene().checkoutBranch?.gitStatus).toEqual(detached));

  render(
    <CheckoutBranchControlProvider value={scene().checkoutBranch!}>
      <Composer {...composerProps(secondary)} />
    </CheckoutBranchControlProvider>,
  );
  expect(screen.getByRole("group", { name: "Chat checkout context" })).toHaveTextContent(/^Current checkout/u);
  expect(await screen.findByRole("button", { name: "Detached HEAD, create or check out a branch" })).toBeInTheDocument();
});
