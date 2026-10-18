import { useEffect, useMemo, useState } from "react";

import type { Conversation } from "@shared/contracts";

export const CLOCK_CHECK_INTERVAL_MS = 60_000;

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

export function nextLocalDayBoundary(now: number): number {
  const current = new Date(now);
  return new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() + 1,
  ).getTime();
}

/** Re-renders the sidebar at the next snooze expiry or local day boundary. */
export function useSnoozeClock(
  conversations: readonly Conversation[],
): number {
  const [now, setNow] = useState(() => Date.now());
  const nextExpiry = useMemo(
    () => nextSnoozeExpiry(conversations, now),
    [conversations, now],
  );
  const nextRefresh = Math.min(
    nextExpiry ?? Number.POSITIVE_INFINITY,
    nextLocalDayBoundary(now),
  );

  useEffect(() => {
    let timer = 0;
    const check = (): void => {
      const current = Date.now();
      if (current >= nextRefresh || nextLocalDayBoundary(current) !== nextLocalDayBoundary(now)) {
        setNow(current);
        return;
      }
      timer = window.setTimeout(check, Math.min(CLOCK_CHECK_INTERVAL_MS, nextRefresh - current + 1));
    };
    check();
    return () => window.clearTimeout(timer);
  }, [now, nextRefresh]);

  return now;
}
