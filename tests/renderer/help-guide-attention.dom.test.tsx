import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeConversationIsVisible } from "../../src/renderer/src/components/AppLayout";
import { SidebarHelpButton } from "../../src/renderer/src/components/sidebar/SidebarHelpButton";
import { ThreadNotifications } from "../../src/renderer/src/hooks/useThreadNotifications";
import { useHelpGuideOpen } from "../../src/renderer/src/hooks/useHelpGuideOpen";
import {
  shouldMarkWorkspaceRunSeen,
  workspaceAttentionObstructed,
} from "../../src/renderer/src/utils/attentionVisibility";
import { closeHelpGuide } from "../../src/renderer/src/utils/helpGuide";
import type { AppSnapshot, Conversation, WorkspaceRun } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const conversationId = "11111111-1111-4111-8111-111111111111";

const noOverlays = {
  paletteOpen: false,
  commitDialogOpen: false,
  dailyWorkOpen: false,
  authProviderOpen: false,
  multiSpawnOpen: false,
  mobileSidebarOpen: false,
};

const visibleWorkspace = {
  view: "workspace" as const,
  commitDialogOpen: false,
  dailyWorkOpen: false,
  pullRequestDialogOpen: false,
  multiSpawnOpen: false,
  paletteOpen: false,
  providerAuthOpen: false,
  mobileSidebarOpen: false,
};

function thread(
  status: Conversation["status"],
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id: conversationId,
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Thread",
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status,
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: "2026-09-28T09:00:00.000Z",
    updatedAt: "2026-09-28T09:00:00.000Z",
    ...overrides,
  };
}

function snapshot(current: Conversation): AppSnapshot {
  return { conversations: [current], activeConversationId: conversationId } as AppSnapshot;
}

function run(status: WorkspaceRun["status"], id: string): WorkspaceRun {
  return {
    id,
    kind: "agent",
    projectId: "22222222-2222-4222-8222-222222222222",
    conversationId,
    actionId: null,
    label: "Thread",
    detail: null,
    status,
    attentionState: "unseen",
    canStop: false,
    port: null,
    startedAt: "2026-09-28T09:00:00.000Z",
    finishedAt: status === "succeeded" ? "2026-09-28T09:01:00.000Z" : null,
  };
}

function ActiveChat({ current }: { current: Conversation }): React.JSX.Element {
  const helpOpen = useHelpGuideOpen();
  return (
    <>
      <SidebarHelpButton />
      <ThreadNotifications
        snapshot={snapshot(current)}
        documentActive
        activeConversationVisible={activeConversationIsVisible({ ...visibleWorkspace, helpOpen })}
        splitConversationIds={new Set()}
        enabled
        onActivate={vi.fn()}
      />
    </>
  );
}

function VisibleRun({
  current,
  markSeen,
}: {
  current: WorkspaceRun;
  markSeen: (runId: string) => void;
}): React.JSX.Element {
  const helpOpen = useHelpGuideOpen();
  useEffect(() => {
    if (shouldMarkWorkspaceRunSeen(current, conversationId, {
      documentVisible: true,
      documentFocused: true,
      workspaceVisible: true,
      latestContentVisible: true,
      obstructed: workspaceAttentionObstructed({ ...noOverlays, helpOpen }),
    })) markSeen(current.id);
  }, [current, helpOpen, markSeen]);
  return <SidebarHelpButton />;
}

let showThreadNotification: ReturnType<typeof vi.fn>;

beforeEach(() => {
  showThreadNotification = vi.fn(async () => true);
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      onThreadNotificationActivated: vi.fn(() => vi.fn()),
      showThreadNotification,
    },
  });
});

afterEach(() => {
  act(() => closeHelpGuide());
  Reflect.deleteProperty(window, "inertia");
});

describe("Help as an attention obstruction", () => {
  it("is part of both visibility predicates while open", () => {
    expect(workspaceAttentionObstructed({ ...noOverlays, helpOpen: false })).toBe(false);
    expect(workspaceAttentionObstructed({ ...noOverlays, helpOpen: true })).toBe(true);
    expect(activeConversationIsVisible({ ...visibleWorkspace, helpOpen: false })).toBe(true);
    expect(activeConversationIsVisible({ ...visibleWorkspace, helpOpen: true })).toBe(false);
  });

  it.each([
    ["a completion", thread("completed", { completedAt: "2026-09-28T09:01:00.000Z" }), "completed"],
    ["an input request", thread("needs-input", { attentionKind: "input" }), "input"],
    ["an approval request", thread("needs-input", { attentionKind: "approval" }), "approval"],
  ] as const)("notifies %s on the active chat while Help covers it, and not after Help closes", (_label, next, kind) => {
    const view = render(<ActiveChat current={thread("running")} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));

    view.rerender(<ActiveChat current={next} />);
    expect(showThreadNotification).toHaveBeenCalledExactlyOnceWith({ conversationId, kind });

    act(() => closeHelpGuide());
    view.rerender(<ActiveChat current={thread("running")} />);
    view.rerender(<ActiveChat current={next} />);
    expect(showThreadNotification).toHaveBeenCalledOnce();
  });

  it.each([
    ["a completed run", run("succeeded", "33333333-3333-4333-8333-333333333333")],
    ["an input or approval request", run("waiting", "44444444-4444-4444-8444-444444444444")],
  ] as const)("does not mark %s seen behind Help, then marks it once Help closes", (_label, current) => {
    const markSeen = vi.fn();
    const view = render(<VisibleRun current={{ ...current, attentionState: "seen" }} markSeen={markSeen} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));

    view.rerender(<VisibleRun current={current} markSeen={markSeen} />);
    expect(markSeen).not.toHaveBeenCalled();

    act(() => closeHelpGuide());
    expect(markSeen).toHaveBeenCalledExactlyOnceWith(current.id);
  });
});
