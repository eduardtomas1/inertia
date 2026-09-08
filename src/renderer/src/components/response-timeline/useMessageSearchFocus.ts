import { isTimelineFocusDetail, TIMELINE_FOCUS_EVENT } from "../../utils/timelineFocus";
import { useEffect, useLayoutEffect } from "react";
import type { ResponseTimelineProps } from "./types";
import type { ResponseTimelineItem } from "../../utils/responseTimeline";
import { MESSAGE_SEARCH_FOCUS_EVENT, clearMessageSearchFocus, pendingMessageSearchFocus } from "../../utils/messageSearchFocus";

export function resolveMessageSearchDestination(row: HTMLElement, messageId: string, turnId?: string): HTMLElement | null {
  if (turnId && row.dataset.turnId !== turnId) {
    const nested = Array.from(row.querySelectorAll<HTMLElement>("[data-turn-id]"))
      .find((element) => element.dataset.turnId === turnId);
    if (!nested) {
      const history = row.querySelector<HTMLDetailsElement>(":scope > details");
      if (history) history.open = true;
      return null;
    }
    row = nested;
  }
  const destination = Array.from(row.querySelectorAll<HTMLElement>("[data-follow-up-message-id], [data-message-search-id], [data-terminal-answer-id]"))
    .find((element) => (element.dataset.followUpMessageId ?? element.dataset.messageSearchId ?? element.dataset.terminalAnswerId) === messageId);
  if (destination) {
    const expand = destination.querySelector<HTMLButtonElement>('.turn-user-request-expand[aria-expanded="false"]');
    if (!expand) return destination;
    expand.click();
    return null;
  }
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
  focusTimelineItem: (index: number, target: "turn" | { messageId: string; turnId?: string }) => void,
): void {
  useEffect(() => {
    const focusSearchResult = (): void => {
      const target = pendingMessageSearchFocus(props.conversationId);
      if (!target || target.projectId !== props.projectId) return;
      const message = props.messages.find(({ id, conversationId, turnId }) =>
        id === target.messageId && conversationId === target.conversationId && turnId === target.turnId);
      if (!message) return;
      let ownerId: string | undefined;
      const index = timeline.findIndex((item) => {
        const turns = item.kind === "turn" ? [item.turn]
          : item.kind === "compatibility" ? item.compatibility.inferredTurns : [];
        // The timeline projection scopes every owned message by this same
        // persisted turn identity, including inferred requests and follow-ups.
        const owner = turns.find((turn) => turn.id === target.turnId);
        if (owner) ownerId = owner.id;
        return owner !== undefined || (item.kind === "compatibility"
          && item.compatibility.messages.some(({ id }) => id === target.messageId));
      });
      if (index < 0) return;
      clearMessageSearchFocus();
      beginReaderTimelineNavigation();
      focusTimelineItem(index, { messageId: message.id, turnId: ownerId });
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
