import { useEffect, useMemo, useState } from "react";

import type { Conversation } from "@shared/contracts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function nextSnoozeExpiry(
  conversations: readonly Conversation[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const conversation of conversations) {
    const expiresAt = conversation.snoozedUntil
      ? Date.parse(conversation.snoozedUntil)
      : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    if (next === null || expiresAt < next) next = expiresAt;
  }
  return next;
}

/** Re-renders the sidebar when the earliest live snooze expires. */
export function useSnoozeClock(
  conversations: readonly Conversation[],
): number {
  const [now, setNow] = useState(() => Date.now());
  const nextExpiry = useMemo(
    () => nextSnoozeExpiry(conversations, now),
    [conversations, now],
  );

  useEffect(() => {
    if (nextExpiry === null) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, nextExpiry - Date.now()) + 1,
    );
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  return now;
}
