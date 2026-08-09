import { useEffect, useRef } from "react";

import type { AppSnapshot, Conversation } from "@shared/contracts";
import type { DesktopNotificationKind } from "@shared/desktop";

export function threadNotificationKind(
  previous: Conversation,
  current: Conversation,
): DesktopNotificationKind | null {
  if (current.status === "needs-input" && previous.status !== "needs-input") {
    return current.attentionKind === "approval" ? "approval" : "input";
  }
  if (current.status === "failed" && previous.status !== "failed") {
    return "failed";
  }
  if (
    current.status === "completed"
    && (
      previous.status !== "completed"
      || previous.completedAt !== current.completedAt
    )
  ) return "completed";
  return null;
}

export function useThreadNotifications(
  snapshot: AppSnapshot | null,
  documentActive: boolean,
  activeConversationVisible: boolean,
  secondaryConversationId: string | null,
  enabled: boolean,
  onActivate: (conversation: Conversation) => void,
): void {
  const previousRef = useRef<Map<string, Conversation> | null>(null);
  const snapshotRef = useRef(snapshot);
  const activateRef = useRef(onActivate);
  snapshotRef.current = snapshot;
  activateRef.current = onActivate;

  useEffect(() => {
    const subscribe = window.inertia?.onThreadNotificationActivated;
    if (!subscribe) return;
    return subscribe((conversationId) => {
      const conversation = snapshotRef.current?.conversations.find(
        ({ id }) => id === conversationId,
      );
      if (conversation) activateRef.current(conversation);
    });
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const next = new Map(snapshot.conversations.map((conversation) => [
      conversation.id,
      conversation,
    ]));
    const previous = previousRef.current;
    previousRef.current = next;
    if (!previous || !enabled) return;

    for (const conversation of snapshot.conversations) {
      const prior = previous.get(conversation.id);
      if (!prior) continue;
      const kind = threadNotificationKind(prior, conversation);
      if (!kind) continue;
      if (
        conversation.snoozedUntil
        && Date.parse(conversation.snoozedUntil) > Date.now()
      ) continue;
      if (
        documentActive
        && activeConversationVisible
        && (
          snapshot.activeConversationId === conversation.id
          || secondaryConversationId === conversation.id
        )
      ) continue;
      const notification = window.inertia?.showThreadNotification?.({
        conversationId: conversation.id,
        kind,
      });
      void notification?.catch(() => undefined);
    }
  }, [
    activeConversationVisible,
    documentActive,
    enabled,
    secondaryConversationId,
    snapshot,
  ]);
}

export function ThreadNotifications(props: {
  snapshot: AppSnapshot | null;
  documentActive: boolean;
  activeConversationVisible: boolean;
  secondaryConversationId: string | null;
  enabled: boolean;
  onActivate: (conversation: Conversation) => void;
}): null {
  useThreadNotifications(
    props.snapshot,
    props.documentActive,
    props.activeConversationVisible,
    props.secondaryConversationId,
    props.enabled,
    props.onActivate,
  );
  return null;
}
