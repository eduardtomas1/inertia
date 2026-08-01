export const TIMELINE_FOCUS_EVENT = "inertia:timeline-focus";

export interface TimelineFocusDetail {
  conversationId: string;
  turnId: string;
}

export function isTimelineFocusDetail(
  value: unknown,
): value is TimelineFocusDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<TimelineFocusDetail>;
  return typeof detail.conversationId === "string"
    && detail.conversationId.length > 0
    && detail.conversationId.length <= 1_000
    && typeof detail.turnId === "string"
    && detail.turnId.length > 0
    && detail.turnId.length <= 1_000;
}

export function requestTimelineFocus(detail: TimelineFocusDetail): void {
  window.dispatchEvent(new CustomEvent<TimelineFocusDetail>(
    TIMELINE_FOCUS_EVENT,
    { detail },
  ));
}
