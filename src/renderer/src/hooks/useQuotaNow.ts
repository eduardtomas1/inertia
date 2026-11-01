import { useEffect, useState } from "react";

import { useDocumentVisibility } from "./useDocumentPresence";

const MAX_TIMER_MS = 2_147_483_647;

export function useQuotaNow(
  limits: ReadonlyArray<{ resetsAt: string | null }>,
  live = true,
): [number, (now: number) => void] {
  const [now, setNow] = useState(() => Date.now());
  const visible = useDocumentVisibility();
  const ticking = visible && live && limits.length > 0;
  const nextReset = limits.reduce<number | null>((earliest, limit) => {
    const reset = Date.parse(limit.resetsAt ?? "");
    return Number.isFinite(reset) && reset > now && (earliest === null || reset < earliest)
      ? reset
      : earliest;
  }, null);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  useEffect(() => {
    if (nextReset === null) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(MAX_TIMER_MS, Math.max(0, nextReset - Date.now()) + 50),
    );
    return () => window.clearTimeout(timer);
  }, [nextReset]);
  return [now, setNow];
}
