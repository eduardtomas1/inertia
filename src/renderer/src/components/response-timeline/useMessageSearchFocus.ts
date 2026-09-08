import { isTimelineFocusDetail, TIMELINE_FOCUS_EVENT } from "../../utils/timelineFocus";
import { useEffect, useLayoutEffect } from "react";
import type { ResponseTimelineProps } from "./types";
import type { ResponseTimelineItem } from "../../utils/responseTimeline";
import { MESSAGE_SEARCH_FOCUS_EVENT, clearMessageSearchFocus, pendingMessageSearchFocus } from "../../utils/messageSearchFocus";

export function resolveMessageSearchDestination(row: HTMLElement, messageId: string): HTMLElement | null {
  const destination = Array.from(row.querySelectorAll<HTMLElement>("[data-follow-up-message-id], [data-message-search-id]"))
    .find((element) => (element.dataset.followUpMessageId ?? element.dataset.messageSearchId) === messageId);
  if (destination) return destination;
  // Collapsed work/legacy disclosures mount their content only after expansion.
  // The timeline's bounded focus controller keeps resolving until that commit.
  const details = row.querySelector<HTMLDetailsElement>(".turn-work-log.is-settled > details, :scope > details");
  if (details) details.open = true;
  else row.querySelector<HTMLButtonElement>('.turn-run-details-toggle[aria-expanded="false"]')?.click();
  return null;
}

export function useMessageSearchFocus(
  props: Pick<ResponseTimelineProps, "conversationId" | "projectId" | "messages">,
  timeline: ResponseTimelineItem[],
  beginReaderTimelineNavigation: () => void,
  focusTimelineItem: (index: number, target: "turn" | "request" | "final" | { messageId: string }) => void,
): void {
  useEffect(() => {
    const focusSearchResult = (): void => {
      const target = pendingMessageSearchFocus(props.conversationId);
      if (!target || target.projectId !== props.projectId) return;
      const message = props.messages.find(({ id, conversationId, turnId }) =>
        id === target.messageId && conversationId === target.conversationId && turnId === target.turnId);
      if (!message) return;
      const index = timeline.findIndex((item) => item.kind === "turn"
        ? item.turn.id === target.turnId || item.turn.userMessage.id === target.messageId
        : item.compatibility.messages.some(({ id }) => id === target.messageId));
      if (index < 0) return;
      clearMessageSearchFocus();
      beginReaderTimelineNavigation();
      const item = timeline[index]!;
      focusTimelineItem(index, message.role === "assistant" ? "final"
        : item.kind === "turn" && item.turn.userMessage.id === message.id ? "request"
          : { messageId: message.id });
    };
    window.addEventListener(MESSAGE_SEARCH_FOCUS_EVENT, focusSearchResult);
    focusSearchResult();
    return () => window.removeEventListener(MESSAGE_SEARCH_FOCUS_EVENT, focusSearchResult);
  }, [beginReaderTimelineNavigation, focusTimelineItem, props.conversationId, props.projectId, props.messages, timeline]);

  useLayoutEffect(() => {
    const focusRequestedTurn = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (
        !isTimelineFocusDetail(detail)
        || detail.conversationId !== props.conversationId
      ) return;
      const index = timeline.findIndex((item) =>
        item.kind === "turn" && item.turn.id === detail.turnId);
      if (index >= 0) {
        beginReaderTimelineNavigation();
        focusTimelineItem(index, "turn");
      }
    };
    window.addEventListener(TIMELINE_FOCUS_EVENT, focusRequestedTurn);
    return () => window.removeEventListener(
      TIMELINE_FOCUS_EVENT,
      focusRequestedTurn,
    );
  }, [
    beginReaderTimelineNavigation,
    focusTimelineItem,
    props.conversationId,
    timeline,
  ]);

}
