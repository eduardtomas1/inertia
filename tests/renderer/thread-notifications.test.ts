import { describe, expect, it, vi } from "vitest";

import {
  activeConversationIsVisible,
  activateNotificationConversation,
  formatAppShortcutLabel,
} from "../../src/renderer/src/components/AppLayout";
import { threadNotificationKind } from "../../src/renderer/src/hooks/useThreadNotifications";
import type { Conversation } from "../../src/shared/contracts";
import { parseDesktopNotificationRequest } from "../../src/shared/desktop";
import { nativeModelSelection } from "../../src/shared/model-routing";

function conversation(
  status: Conversation["status"],
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Thread",
    providerId: "codex",
    modelSelection: nativeModelSelection({ providerId: "codex" }),
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
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    ...overrides,
  };
}

describe("thread notifications", () => {
  it("treats settings and modal overlays as obscuring the active chat", () => {
    const visible = {
      view: "workspace" as const,
      commitDialogOpen: false,
      pullRequestDialogOpen: false,
      multiSpawnOpen: false,
      paletteOpen: false,
      activityOpen: false,
      providerAuthOpen: false,
      mobileSidebarOpen: false,
    };
    expect(activeConversationIsVisible(visible)).toBe(true);
    expect(activeConversationIsVisible({ ...visible, view: "settings" }))
      .toBe(false);
    expect(activeConversationIsVisible({ ...visible, commitDialogOpen: true }))
      .toBe(false);
    expect(activeConversationIsVisible({ ...visible, paletteOpen: true }))
      .toBe(false);
  });

  it("formats remapped shortcut labels for the active platform", () => {
    expect(formatAppShortcutLabel("darwin", "y")).toBe("⌘Y");
    expect(formatAppShortcutLabel("win32", "y")).toBe("Ctrl+Y");
    expect(formatAppShortcutLabel("linux", "y")).toBe("Ctrl+Y");
  });

  it("closes navigation and repository dialogs before activating a workspace thread", () => {
    const thread = conversation("completed");
    const calls: string[] = [];
    const selectConversation = vi.fn();
    const showWorkspace = vi.fn();
    const closeSidebar = vi.fn();
    const closePalette = vi.fn();
    const closeActivity = vi.fn();
    const closeCommitDialog = vi.fn(() => calls.push("commit"));
    const closePullRequestDialog = vi.fn(() => calls.push("pull-request"));
    const closeProviderAuth = vi.fn(() => calls.push("provider-auth"));
    selectConversation.mockImplementation(() => calls.push("conversation"));

    activateNotificationConversation(thread, {
      selectConversation,
      showWorkspace,
      closeSidebar,
      closePalette,
      closeActivity,
      closeCommitDialog,
      closePullRequestDialog,
      closeProviderAuth,
    });

    expect(calls).toEqual([
      "commit",
      "pull-request",
      "provider-auth",
      "conversation",
    ]);
    expect(selectConversation).toHaveBeenCalledWith(thread);
    expect(showWorkspace).toHaveBeenCalledOnce();
    expect(closeSidebar).toHaveBeenCalledOnce();
    expect(closePalette).toHaveBeenCalledOnce();
    expect(closeActivity).toHaveBeenCalledOnce();
    expect(closeCommitDialog).toHaveBeenCalledOnce();
    expect(closePullRequestDialog).toHaveBeenCalledOnce();
    expect(closeProviderAuth).toHaveBeenCalledOnce();
  });

  it("maps only meaningful status transitions to native notification kinds", () => {
    const idle = conversation("idle");
    expect(threadNotificationKind(idle, conversation("needs-input", {
      attentionKind: "approval",
    }))).toBe("approval");
    expect(threadNotificationKind(idle, conversation("needs-input", {
      attentionKind: "input",
    }))).toBe("input");
    expect(threadNotificationKind(idle, conversation("failed"))).toBe("failed");
    expect(threadNotificationKind(idle, conversation("completed", {
      completedAt: "2026-08-09T09:01:00.000Z",
    }))).toBe("completed");
    expect(threadNotificationKind(idle, conversation("running"))).toBeNull();
  });

  it("accepts only the privacy-safe, exact IPC request shape", () => {
    const valid = {
      conversationId: "11111111-1111-4111-8111-111111111111",
      kind: "completed",
    };
    expect(parseDesktopNotificationRequest(valid)).toEqual(valid);
    expect(parseDesktopNotificationRequest({ ...valid, title: "secret prompt" }))
      .toBeNull();
    expect(parseDesktopNotificationRequest({ ...valid, conversationId: "thread" }))
      .toBeNull();
    expect(parseDesktopNotificationRequest({ ...valid, kind: "arbitrary" }))
      .toBeNull();
  });
});
