import { useEffect, useRef } from "react";

import type { AppSnapshot, Conversation, ConversationLatestTurnSummary } from "@shared/contracts";
import type { DesktopNotificationKind } from "@shared/desktop";

export function threadNotificationKind(
  previous: Conversation,
  current: Conversation & { latestTurn?: Pick<ConversationLatestTurnSummary, "usageLimited"> | null },
): DesktopNotificationKind | null {
  if (current.status === "needs-input" && previous.status !== "needs-input") {
    return current.attentionKind === "approval" ? "approval" : "input";
  }
  if (current.status === "failed" && previous.status !== "failed") {
    return current.latestTurn?.usageLimited ? "usage-limited" : "failed";
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
  splitConversationIds: ReadonlySet<string>,
  enabled: boolean,
  onActivate: (conversation: Conversation) => void,
  onlyInBackground = false,
): void {
  const previousRef = useRef<Map<string, Conversation> | null>(null);
  const snapshotRef = useRef(snapshot);
  const activateRef = useRef(onActivate);
  const pendingActivationIdRef = useRef<string | null>(null);
  snapshotRef.current = snapshot;
  activateRef.current = onActivate;

  useEffect(() => {
    const subscribe = window.inertia?.onThreadNotificationActivated;
    if (!subscribe) return;
    return subscribe((conversationId) => {
      const conversation = snapshotRef.current?.conversations.find(
        ({ id }) => id === conversationId,
      );
      if (!conversation) {
        pendingActivationIdRef.current = conversationId;
        return;
      }
      pendingActivationIdRef.current = null;
      activateRef.current(conversation);
    });
  }, []);

  useEffect(() => {
    const conversationId = pendingActivationIdRef.current;
    if (!conversationId) return;
    const conversation = snapshot?.conversations.find(
      ({ id }) => id === conversationId,
    );
    if (!conversation) return;
    pendingActivationIdRef.current = null;
    activateRef.current(conversation);
  }, [snapshot]);

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
          || splitConversationIds.has(conversation.id)
        )
      ) continue;
      const notification = window.inertia?.showThreadNotification?.({
        conversationId: conversation.id,
        kind,
        ...(onlyInBackground ? { onlyInBackground } : {}),
      });
      void notification?.catch(() => undefined);
    }
  }, [
    activeConversationVisible,
    documentActive,
    enabled,
    onlyInBackground,
    snapshot,
    splitConversationIds,
  ]);
}

export function ThreadNotifications(props: {
  snapshot: AppSnapshot | null;
  documentActive: boolean;
  activeConversationVisible: boolean;
  splitConversationIds: ReadonlySet<string>;
  enabled: boolean;
  onlyInBackground?: boolean;
  onActivate: (conversation: Conversation) => void;
}): null {
  useThreadNotifications(
    props.snapshot,
    props.documentActive,
    props.activeConversationVisible,
    props.splitConversationIds,
    props.enabled,
    props.onActivate,
    props.onlyInBackground,
  );
  return null;
}
