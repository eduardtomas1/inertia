import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type Conversation,
  type GitStatusSnapshot,
  type Project,
} from "../../src/shared/contracts";

vi.mock("../../src/renderer/src/components/WorkspaceHeader", () => ({
  WorkspaceHeader: ({ onPushAndCreatePullRequest }: { onPushAndCreatePullRequest: () => void }) => (
    <button type="button" onClick={onPushAndCreatePullRequest}>Push & create PR</button>
  ),
}));
vi.mock("../../src/renderer/src/components/PullRequestDialog", () => ({
  default: ({ conversationId }: { conversationId?: string }) => (
    <div role="dialog" aria-label="Pull request">{conversationId}</div>
  ),
}));
vi.mock("../../src/renderer/src/components/WorkspaceScene", () => ({ WorkspaceScene: () => null }));
vi.mock("../../src/renderer/src/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../../src/renderer/src/components/AppNavigationOverlays", () => ({ AppNavigationOverlays: () => null }));
vi.mock("../../src/renderer/src/components/AppStatusOverlays", () => ({
  AppStatusOverlays: () => null,
  StatusToastStack: () => null,
}));
vi.mock("../../src/renderer/src/components/WelcomeGuideHost", () => ({ WelcomeGuideHost: () => null }));
vi.mock("../../src/renderer/src/components/HelpGuideHost", () => ({ HelpGuideHost: () => null }));
vi.mock("../../src/renderer/src/components/SplitDropLayer", () => ({ SplitDropLayer: () => null }));
vi.mock("../../src/renderer/src/components/workspace-header/PanelLayoutControls", () => ({
  PanelLayoutControls: () => null,
}));
vi.mock("../../src/renderer/src/hooks/useThreadNotifications", () => ({ ThreadNotifications: () => null }));

import { AppLayout } from "../../src/renderer/src/components/AppLayout";

type LayoutProps = ComponentProps<typeof AppLayout>;

const now = "2026-10-18T10:00:00.000Z";
const project = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Inertia",
  path: "/workspace/inertia",
  status: "ready",
} as Project;
const chat = (id: string, title: string) => ({
  id,
  projectId: project.id,
  title,
  createdAt: now,
  updatedAt: now,
}) as Conversation;
const first = chat("56565656-5656-4656-8656-565656565656", "First chat");
const second = chat("57575757-5757-4757-8757-575757575757", "Second chat");
const gitStatus = { isRepository: true, authorityRef: "authority", branch: "feature" } as unknown as GitStatusSnapshot;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function props(conversation: Conversation, mutateRemote: LayoutProps["actions"]["mutateRemote"]): LayoutProps {
  return {
    platform: "darwin",
    documentActive: true,
    documentVisible: true,
    settings: defaultSettings,
    connection: {
      snapshot: null,
      runtimeGeneration: "generation",
      status: "online",
      error: null,
      databaseRecoveryNotice: null,
      dismissDatabaseRecoveryNotice: () => undefined,
      clearError: () => undefined,
      sendCommand: () => new Promise(() => undefined),
      subscribe: () => () => undefined,
    },
    appUpdate: {} as LayoutProps["appUpdate"],
    providerQuotaNotices: { notices: [] } as unknown as LayoutProps["providerQuotaNotices"],
    workspaceLayout: {
      sidebarOpen: false,
      setSidebarOpen: () => undefined,
      sidebarCollapsed: true,
      setSidebarCollapsed: () => undefined,
      mobileNavigation: false,
      toolsVisible: false,
      panelPresentation: "inline",
      appShellRef: createRef(),
      workspaceBodyRef: createRef(),
      appShellStyle: {},
      workspaceBodyStyle: {},
      sidebar: { value: 276, max: 400, onChange: () => undefined, onCommit: () => undefined },
    } as unknown as LayoutProps["workspaceLayout"],
    view: "workspace",
    setView: () => undefined,
    busyAction: null,
    visibleError: null,
    setActionError: () => undefined,
    commitDialogOpen: false,
    setCommitDialogOpen: () => undefined,
    dailyWorkOpen: false,
    setDailyWorkOpen: () => undefined,
    paletteOpen: false,
    setPaletteOpen: () => undefined,
    project,
    conversation,
    headerConversation: conversation,
    splitConversationIds: new Set(),
    splitViewFull: false,
    detachedConversationIds: new Set(),
    detachedChatLimitReached: false,
    conversationSuppressedInMain: false,
    scenePanel: {} as LayoutProps["scenePanel"],
    workspaceToolsUnavailableReason: null,
    gitStatus,
    branches: [],
    projectActions: [],
    reviewStates: [],
    multiSpawn: { open: false } as LayoutProps["multiSpawn"],
    scene: { tools: null, chat: { conversation: null } } as unknown as LayoutProps["scene"],
    usage: {} as LayoutProps["usage"],
    providerAuth: { provider: null } as unknown as LayoutProps["providerAuth"],
    actions: { mutateRemote, run: vi.fn() } as unknown as LayoutProps["actions"],
  };
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => typeof key === "string" && key.startsWith("on")
        ? () => () => undefined
        : () => new Promise(() => undefined),
    }),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "inertia");
});

describe("push and create pull request", () => {
  it("opens the pull request dialog for the chat that pushed", async () => {
    const push = deferred();
    render(<AppLayout {...props(first, () => push.promise)} />);
    fireEvent.click(screen.getByRole("button", { name: "Push & create PR" }));
    await act(async () => { push.resolve(); await push.promise; });
    expect(await screen.findByRole("dialog", { name: "Pull request" })).toHaveTextContent(first.id);
  });

  it("does not open the pull request dialog for a chat selected while the push ran", async () => {
    const push = deferred();
    const mutateRemote = () => push.promise;
    const view = render(<AppLayout {...props(first, mutateRemote)} />);
    fireEvent.click(screen.getByRole("button", { name: "Push & create PR" }));
    view.rerender(<AppLayout {...props(second, mutateRemote)} />);
    await act(async () => { push.resolve(); await push.promise; });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(screen.queryByRole("dialog", { name: "Pull request" })).not.toBeInTheDocument();
  });
});
