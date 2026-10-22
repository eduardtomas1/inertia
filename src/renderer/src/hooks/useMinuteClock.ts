import { useEffect, useState } from "react";

import { CLOCK_CHECK_INTERVAL_MS } from "./useSnoozeClock";

function untilNextMinute(now: number): number {
  return CLOCK_CHECK_INTERVAL_MS - (now % CLOCK_CHECK_INTERVAL_MS);
}

export function useMinuteClock(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const visible = (): boolean => document.visibilityState !== "hidden";
    const schedule = (): void => {
      window.clearTimeout(timer);
      if (visible()) timer = window.setTimeout(tick, untilNextMinute(Date.now()) + 1);
    };
    const tick = (): void => {
      setNow(Date.now());
      schedule();
    };
    const onVisibility = (): void => {
      if (visible()) tick();
      else window.clearTimeout(timer);
    };
    tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return now;
}
