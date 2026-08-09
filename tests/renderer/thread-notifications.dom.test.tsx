import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadNotifications } from "../../src/renderer/src/hooks/useThreadNotifications";
import type { AppSnapshot, Conversation } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

function conversation(status: Conversation["status"]): Conversation {
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
    completedAt: status === "completed"
      ? "2026-08-09T09:01:00.000Z"
      : null,
    lastViewedAt: null,
    pinnedAt: null,
    snoozedUntil: null,
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:01:00.000Z",
  };
}

function snapshot(thread: Conversation): AppSnapshot {
  return {
    conversations: [thread],
    activeConversationId: null,
  } as AppSnapshot;
}

describe("thread notification lifecycle", () => {
  it("keeps activation subscribed after alert generation is disabled", () => {
    let activateNativeNotification = (_conversationId: string): void => {
      throw new Error("Notification activation was not subscribed.");
    };
    const unsubscribe = vi.fn();
    const showThreadNotification = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        onThreadNotificationActivated: vi.fn((listener: (
          conversationId: string,
        ) => void) => {
          activateNativeNotification = listener;
          return unsubscribe;
        }),
        showThreadNotification,
      },
    });
    const onActivate = vi.fn();
    const idle = snapshot(conversation("idle"));
    const completed = snapshot(conversation("completed"));
    const view = render(
      <ThreadNotifications
        snapshot={idle}
        documentActive={false}
        activeConversationVisible
        secondaryConversationId={null}
        enabled
        onActivate={onActivate}
      />,
    );
    view.rerender(
      <ThreadNotifications
        snapshot={completed}
        documentActive={false}
        activeConversationVisible
        secondaryConversationId={null}
        enabled
        onActivate={onActivate}
      />,
    );
    expect(showThreadNotification).toHaveBeenCalledOnce();

    view.rerender(
      <ThreadNotifications
        snapshot={completed}
        documentActive={false}
        activeConversationVisible
        secondaryConversationId={null}
        enabled={false}
        onActivate={onActivate}
      />,
    );
    expect(unsubscribe).not.toHaveBeenCalled();
    activateNativeNotification(completed.conversations[0]!.id);
    expect(onActivate).toHaveBeenCalledWith(completed.conversations[0]);

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("suppresses the visible active chat but alerts when an overlay obscures it", () => {
    const showThreadNotification = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        onThreadNotificationActivated: vi.fn(() => vi.fn()),
        showThreadNotification,
      },
    });
    const idleThread = conversation("idle");
    const completedThread = conversation("completed");
    const activeIdle = {
      ...snapshot(idleThread),
      activeConversationId: idleThread.id,
    };
    const activeCompleted = {
      ...snapshot(completedThread),
      activeConversationId: completedThread.id,
    };
    const view = render(
      <ThreadNotifications
        snapshot={activeIdle}
        documentActive
        activeConversationVisible
        secondaryConversationId={null}
        enabled
        onActivate={vi.fn()}
      />,
    );
    view.rerender(
      <ThreadNotifications
        snapshot={activeCompleted}
        documentActive
        activeConversationVisible
        secondaryConversationId={null}
        enabled
        onActivate={vi.fn()}
      />,
    );
    expect(showThreadNotification).not.toHaveBeenCalled();

    view.rerender(
      <ThreadNotifications
        snapshot={activeIdle}
        documentActive
        activeConversationVisible={false}
        secondaryConversationId={null}
        enabled
        onActivate={vi.fn()}
      />,
    );
    view.rerender(
      <ThreadNotifications
        snapshot={activeCompleted}
        documentActive
        activeConversationVisible={false}
        secondaryConversationId={null}
        enabled
        onActivate={vi.fn()}
      />,
    );
    expect(showThreadNotification).toHaveBeenCalledOnce();
  });

  it("suppresses transitions for the visible secondary split chat", () => {
    const showThreadNotification = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        onThreadNotificationActivated: vi.fn(() => vi.fn()),
        showThreadNotification,
      },
    });
    const primary = conversation("idle");
    const secondaryIdle = {
      ...conversation("idle"),
      id: "33333333-3333-4333-8333-333333333333",
      title: "Secondary thread",
    };
    const secondaryCompleted = {
      ...conversation("completed"),
      id: secondaryIdle.id,
      title: secondaryIdle.title,
    };
    const splitSnapshot = (secondary: Conversation) => ({
      ...snapshot(primary),
      conversations: [primary, secondary],
      activeConversationId: primary.id,
    }) as AppSnapshot;
    const view = render(
      <ThreadNotifications
        snapshot={splitSnapshot(secondaryIdle)}
        documentActive
        activeConversationVisible
        secondaryConversationId={secondaryIdle.id}
        enabled
        onActivate={vi.fn()}
      />,
    );

    view.rerender(
      <ThreadNotifications
        snapshot={splitSnapshot(secondaryCompleted)}
        documentActive
        activeConversationVisible
        secondaryConversationId={secondaryIdle.id}
        enabled
        onActivate={vi.fn()}
      />,
    );

    expect(showThreadNotification).not.toHaveBeenCalled();
  });
});
