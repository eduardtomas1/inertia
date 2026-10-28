import { useEffect, useState } from "react";
import { PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS } from "@shared/run-state";

import { useDocumentVisibility } from "../../hooks/useDocumentPresence";

export const PROVIDER_SILENCE_NOTICE_MS = 3 * 60_000;

export function ProviderSilenceNote({
  activityAt,
}: {
  activityAt: string;
}): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    if (!documentVisible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [activityAt, documentVisible]);
  const silentMs = now - Date.parse(activityAt) - PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS;
  if (!(silentMs >= PROVIDER_SILENCE_NOTICE_MS)) return null;
  return (
    <>
      <span className="turn-working-separator" aria-hidden="true">·</span>
      <span className="turn-working-silence" aria-live="polite">
        No output for {Math.floor(silentMs / 60_000)} min
      </span>
    </>
  );
}
