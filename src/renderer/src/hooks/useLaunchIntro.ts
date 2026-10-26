import { useEffect, useState } from "react";

export const LAUNCH_INTRO_SETTLE_MS = 1_100;
export const LAUNCH_INTRO_LIMIT_MS = 4_000;

let launchIntroSpent = false;

export function useLaunchIntro(contentReady: boolean): boolean {
  const [active, setActive] = useState(() => !launchIntroSpent);

  useEffect(() => {
    launchIntroSpent = true;
  }, []);

  useEffect(() => {
    if (!active) return;
    const limit = window.setTimeout(() => setActive(false), LAUNCH_INTRO_LIMIT_MS);
    return () => window.clearTimeout(limit);
  }, [active]);

  useEffect(() => {
    if (!active || !contentReady) return;
    const settle = window.setTimeout(() => setActive(false), LAUNCH_INTRO_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [active, contentReady]);

  return active;
}
